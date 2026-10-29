/**
 * `parseMultipartRelated` — streaming parser adapter. FR-001.
 *
 * Resource caps (NFR-DR-S-001/004/012), all validated as positive safe
 * integers when set:
 *   - `maxPartBytes`: the public body is a counting Transform piped from the
 *     parser's part stream (backpressure intact); overflow errors the body
 *     with `MultipartPartTooLargeError`. No default.
 *   - `maxParts`: checked on every parser 'part' emit. Default `10_000`.
 *   - `maxHeadersPerPart` / `maxHeaderBytesPerPart`: enforced inside the
 *     parser while the header block accumulates, surfaced as
 *     `MultipartHeadersTooLargeError`. Defaults 100 / 16 KiB.
 *
 * Timers (FR-006..FR-009, FR-DR-A-025/026): `setupTimers` aggregates idle,
 * total and the caller's AbortSignal into one signal. The idle timer resets
 * on every source chunk and stops when the source ends.
 *
 * Failure: every terminal error (timeout, abort, truncation, source/parser
 * error, cap overflow) goes through one `fail` path that queues it for the
 * next `.next()` AND destroys every incomplete part body with it, so a
 * consumer blocked on `part.body` is woken. Truncation (FR-022) is decided
 * by the parser at end of input and surfaced as `MultipartTruncatedError`.
 *
 * Cleanup (FR-010): the `finally` destroys unfinished part bodies, removes
 * the source/parser listeners, unpipes and destroys the source, and KEEPS
 * the parser and source 'error' listeners so late errors are logged
 * (FR-011).
 */

import { pipeline, type Readable, Transform } from 'node:stream';

import {
  MultipartAbortError,
  MultipartHeadersTooLargeError,
  MultipartPartTooLargeError,
  MultipartTooManyPartsError,
  MultipartTruncatedError,
} from './errors.js';
import { defaultLogger } from './internal/default-logger.js';
import { flattenPartHeaders } from './internal/flatten-headers.js';
import { summarizeError } from './internal/format-error-embed.js';
import {
  HeaderLimitError,
  MultipartParser,
  type MultipartPartStream,
  type PartHeaders,
  UnexpectedEndError,
} from './internal/multipart-parser.js';
import { normalizeInput } from './internal/normalize-input.js';
import { createQueueNotifier } from './internal/queue-notifier.js';
import { setupTimers } from './internal/timers.js';
import { validateOptionalCap, validatePositiveTimeout } from './internal/validate-timeout.js';
import type { Logger, ParseMultipartOptions, StreamingMultipartPart } from './types.js';

/**
 * Parse a `multipart/related` envelope as a typed async-iterator of
 * streaming parts (FR-001).
 *
 * @param input - A Web `Response` (boundary auto-extracted from
 *   `Content-Type`) or a Node `Readable` (caller supplies `boundary` via
 *   options).
 * @param opts - {@link ParseMultipartOptions}. `idleTimeoutMs` and
 *   `totalTimeoutMs` are REQUIRED on this entry point too (FR-006 / JC-3) and
 *   are validated synchronously via `validatePositiveTimeout` — both must be
 *   positive finite integers in `[1, 2_147_483_647]` (NFR-DR-S-009).
 * @returns An `AsyncGenerator<StreamingMultipartPart, void, void>` that
 *   yields parts in parser's emit order.
 *
 * @throws {TypeError} `multipart: idleTimeoutMs must be a positive finite
 *   integer in [1, 2_147_483_647]; …` when `idleTimeoutMs` is missing,
 *   non-numeric, non-finite, non-integer, `< 1`, or `> 2^31 - 1`. Same for
 *   `totalTimeoutMs`.
 * @throws {Error} `multipart: response body is null` when `input` is a
 *   `Response` whose `.body` is `null` (FR-004). The first `.next()` rejects.
 * @throws {Error} `multipart: Content-Type header is required to extract
 *   boundary` when the Response has no `Content-Type`.
 * @throws {Error} `multipart: boundary parameter missing from Content-Type`
 *   when `Content-Type` is present but lacks a `boundary=` parameter.
 * @throws {Error} `multipart: boundary option is required when input is a
 *   Readable` when the input is a Node `Readable` and `opts.boundary` is
 *   missing or empty.
 * @throws {MultipartIdleTimeoutError} when no source bytes arrive for
 *   `idleTimeoutMs` consecutive ms (FR-007). The idle timer resets on every
 *   chunk received from the source (FR-DR-A-025).
 * @throws {MultipartTotalTimeoutError} when the total operation wallclock
 *   exceeds `totalTimeoutMs` (FR-008).
 * @throws {MultipartAbortError} when `opts.signal` fires (or is already
 *   aborted at call time — first `.next()` rejects synchronously per FR-009).
 *   `error.reason` is the caller's `signal.reason` verbatim (F-S-006).
 * @throws {MultipartTruncatedError} when the source emits `'end'` before
 *   parser emits `'finish'` (FR-022).
 *
 * @example
 *   for await (const part of parseMultipartRelated(res, {
 *     idleTimeoutMs: 5000,
 *     totalTimeoutMs: 60_000,
 *   })) {
 *     console.log(part.contentType, part.contentId);
 *   }
 */
export function parseMultipartRelated(
  input: Response,
  opts: ParseMultipartOptions,
): AsyncGenerator<StreamingMultipartPart, void, void>;
export function parseMultipartRelated(
  input: Readable,
  opts: ParseMultipartOptions & { boundary: string },
): AsyncGenerator<StreamingMultipartPart, void, void>;
export function parseMultipartRelated(
  input: Response | Readable,
  opts: ParseMultipartOptions,
): AsyncGenerator<StreamingMultipartPart, void, void> {
  return parseMultipartRelatedFrom(input, opts, Date.now());
}

/**
 * {@link parseMultipartRelated} with the `totalTimeoutMs` budget measured
 * from `startMs` instead of the call, so `fetchAndHandleMultipart` can
 * count the time spent waiting for response headers.
 *
 * @internal
 */
export function parseMultipartRelatedFrom(
  input: Response | Readable,
  opts: ParseMultipartOptions,
  startMs: number,
): AsyncGenerator<StreamingMultipartPart, void, void> {
  return parseMultipartRelatedImpl(input, opts, startMs);
}

// The async generator below is intentionally one function — see the
// eslint.config.mjs per-file override. It owns three concerns (parser
// wiring, listener attachment before pipe per FR-012, and the yield loop)
// that are deliberately kept together. Splitting into helpers would require
// shared closure state across helper boundaries and obscure the "all
// listeners before pipe" invariant.
async function* parseMultipartRelatedImpl(
  input: Response | Readable,
  callerOpts: ParseMultipartOptions,
  startMs: number,
): AsyncGenerator<StreamingMultipartPart, void, void> {
  // A missing options bag reads as empty, so it fails the timeout checks
  // below with their documented message.
  const opts: Partial<ParseMultipartOptions> = callerOpts ?? {};
  // 1. Synchronous validation (FR-004 + FR-006/JC-3). Async generators
  //    cannot truly throw at construction time — every throw here surfaces
  //    from the first `.next()`.
  //
  //    Every option is read exactly once, here, so values stay fixed for
  //    the duration of the operation and a throwing getter surfaces from
  //    the first `.next()` instead of inside a stream listener. Timeouts are
  //    validated FIRST so callers get the precise NFR-DR-S-009 message even
  //    if their input is also malformed.
  const idleTimeoutMs = opts.idleTimeoutMs;
  const totalTimeoutMs = opts.totalTimeoutMs;
  validatePositiveTimeout('idleTimeoutMs', idleTimeoutMs);
  validatePositiveTimeout('totalTimeoutMs', totalTimeoutMs);

  // Resource caps (kiln/spec/api.md §2, review-security.md F-S-001/004/012):
  //   - maxPartBytes: undefined => no cap (NFR-DR-S-001).
  //   - maxParts: undefined => default 10_000 (NFR-DR-S-012).
  //   - maxHeadersPerPart: undefined => default 100 (NFR-DR-S-004).
  //   - maxHeaderBytesPerPart: undefined => default 16_384 (NFR-DR-S-004).
  const maxPartBytes = validateOptionalCap('maxPartBytes', opts.maxPartBytes);
  const maxParts = validateOptionalCap('maxParts', opts.maxParts) ?? 10_000;
  const maxHeadersPerPart = validateOptionalCap('maxHeadersPerPart', opts.maxHeadersPerPart) ?? 100;
  const maxHeaderBytesPerPart =
    validateOptionalCap('maxHeaderBytesPerPart', opts.maxHeaderBytesPerPart) ?? 16_384;
  const callerSignal = opts.signal;
  const onProgress = opts.onProgress;

  // 2. Logger fallback (FR-018 / JC-2). A logger that throws must not escape
  //    from a stream listener, so its failure is reported to the default
  //    sink instead.
  const callerLogger = opts.logger;
  const logger: Logger =
    callerLogger === undefined
      ? defaultLogger
      : (event) => {
          try {
            callerLogger(event);
          } catch (err) {
            defaultLogger({
              level: 'warn',
              msg: 'multipart: logger threw',
              meta: { event: event.msg, errSummary: summarizeError(err) },
            });
          }
        };

  let normalized: ReturnType<typeof normalizeInput>;
  try {
    normalized = normalizeInput(input, { boundary: opts.boundary });
  } catch (err) {
    // The input is unusable, but a Response body still holds a connection
    // open until it is read or cancelled (US-007).
    cancelResponseBody(input, logger);
    throw err;
  }
  const { readable: source, boundary } = normalized;

  // 3. Construct the internal parser. Header caps are enforced inside it,
  //    while the block is accumulated, so an oversized block is rejected
  //    before it is buffered.
  const parser = new MultipartParser(boundary, {
    maxHeaderPairs: maxHeadersPerPart,
    maxHeaderBytes: maxHeaderBytesPerPart,
  });

  // 4. Queue+notifier bridge (Layer C internal).
  const queue = createQueueNotifier();

  // Operation state used by the listeners.
  let bytesReceived = 0;
  let nextPartIndex = 0;
  let partsObserved = 0;
  let sourceEnded = false;
  let cleaned = false;
  // The first terminal error. Later errors are consequences of it (a
  // destroyed source erroring, bodies failing with it) and are dropped.
  let failure: Error | undefined;
  // Every per-part Readable the parser emitted, plus each `maxPartBytes`
  // counter. A part may be emitted on 'part' but never reach 'header' (so
  // it never made it into the queue); cleanup must still destroy it —
  // otherwise its buffered chunk is never freed (the silent leak BRIEF
  // flags).
  // Each entry maps to the parser part stream that feeds it.
  const allPartStreams = new Map<Readable, MultipartPartStream>();

  // Translate the parser's internal errors into the public typed errors.
  // The truncation error is memoized so the iterator and every failed body
  // reject with the same instance.
  let truncation: MultipartTruncatedError | undefined;
  const toPublicError = (err: Error): Error => {
    if (err instanceof UnexpectedEndError) {
      truncation ??= new MultipartTruncatedError(bytesReceived);
      return truncation;
    }
    if (err instanceof HeaderLimitError) {
      return new MultipartHeadersTooLargeError({
        limit: err.limit,
        partIndex: nextPartIndex - 1,
        cap: err.limit === 'count' ? maxHeadersPerPart : maxHeaderBytesPerPart,
        observed: err.observed,
      });
    }
    return err;
  };

  // Single terminal-error path for parser, source, part, cap, timeout and
  // abort failures. Besides queueing the error for the next `.next()`, it
  // fails every open part body with it: a consumer blocked reading
  // `part.body` (e.g. inside `streamToBuffer`) is otherwise never woken,
  // because cleanup only runs when the generator resumes (FR-007/FR-009).
  const fail = (err: Error, origin: ErrorOrigin = 'operation'): void => {
    if (cleaned) {
      // FR-011: a late-tick error after the generator closed is logged,
      // never thrown into an uncaughtException.
      if (failure === undefined) {
        logger({
          level: 'warn',
          msg: `multipart: late ${origin} error after generator close`,
          meta: { errSummary: summarizeError(err) },
        });
      }
      return;
    }
    if (failure !== undefined) return;
    const publicErr = toPublicError(err);
    failure = publicErr;
    queue.signalError(publicErr);
    // A body whose delimiter already arrived is complete and stays readable,
    // so parts before the failure are still delivered intact.
    for (const [stream, origin] of allPartStreams) {
      if (!origin.complete && !stream.destroyed) stream.destroy(publicErr);
    }
    if (!source.destroyed) source.destroy();
  };

  // 4b. Composite abort plumbing (FR-007/FR-008/FR-009/FR-DR-A-025/
  //     FR-DR-A-026): idle, total and the caller's AbortSignal aggregated
  //     into one signal. Constructed BEFORE any listener is attached and
  //     BEFORE the pipe so no fire is missed.
  const timers = setupTimers(
    {
      idleTimeoutMs,
      totalTimeoutMs,
      ...(callerSignal !== undefined ? { signal: callerSignal } : {}),
    },
    startMs,
  );
  const onCombinedAbort = (): void => {
    fail(timers.abortError() ?? new MultipartAbortError(callerSignal?.reason));
  };
  // FR-009: an already-aborted caller signal makes the first `.next()`
  // reject with MultipartAbortError carrying the verbatim reason.
  if (timers.signal.aborted) onCombinedAbort();
  else timers.signal.addEventListener('abort', onCombinedAbort, { once: true });

  const fireProgress = (completion: boolean): void => {
    if (onProgress === undefined) return;
    const elapsedMs = Date.now() - startMs;
    const rateBps = elapsedMs <= 0 ? 0 : Math.round((bytesReceived * 1000) / elapsedMs);
    try {
      onProgress({ bytes: bytesReceived, elapsedMs, rateBps });
    } catch (err) {
      // FR-017: NEVER silent-catch. Route through the configured logger.
      logger({
        level: 'warn',
        msg: completion
          ? 'multipart: onProgress threw on completion tick'
          : 'multipart: onProgress threw',
        meta: { errSummary: summarizeError(err) },
      });
    }
  };

  // 5. Attach ALL listeners BEFORE pipe() (FR-012 / US-011) so synchronous
  //    early errors surface via the queue rather than being lost.
  const onPart = (partStream: MultipartPartStream): void => {
    // The parser emits the part before its headers so this listener is ready.
    allPartStreams.set(partStream, partStream);
    const partIndex = nextPartIndex++;
    // Per-part 'error' bridge: without a listener, a body failed by `fail`
    // would raise an uncaughtException when the consumer is not reading it.
    partStream.on('error', (err: Error) => {
      fail(err, 'part-stream');
    });

    // maxParts (NFR-DR-S-012): observed === maxParts + 1 on first overflow.
    partsObserved += 1;
    if (partsObserved > maxParts) {
      fail(new MultipartTooManyPartsError({ maxParts, observed: partsObserved }));
      return;
    }

    partStream.once('header', (raw: PartHeaders, rawHeaderBlock: Buffer) => {
      const headers = flattenPartHeaders(raw);
      const contentType = headers['content-type'] ?? '';
      const contentId = headers['content-id'];
      const contentLengthRaw = headers['content-length']?.trim();
      const parsedLength =
        contentLengthRaw !== undefined && /^\d+$/.test(contentLengthRaw)
          ? Number(contentLengthRaw)
          : Number.NaN;
      const contentLength = Number.isSafeInteger(parsedLength) ? parsedLength : undefined;

      // maxPartBytes (NFR-DR-S-001). When a cap is configured, the public
      // body is a counting Transform piped from the parser's part stream,
      // which keeps backpressure intact. On overflow the transform errors
      // with the typed error, so a consumer draining the body rejects with
      // it and the iterator surfaces the same instance.
      let body: Readable = partStream;
      if (maxPartBytes !== undefined) {
        let partBytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback): void {
            partBytes += chunk.length;
            if (partBytes > maxPartBytes) {
              callback(
                new MultipartPartTooLargeError({
                  maxPartBytes,
                  partIndex,
                  bytesReceived: partBytes,
                }),
              );
              return;
            }
            callback(null, chunk);
          },
        });
        allPartStreams.set(counter, partStream);
        pipeline(partStream, counter, (err) => {
          // A premature close means one side was destroyed without an
          // error: the consumer skipping the body, or cleanup. Neither is
          // a failure of the operation.
          if (err != null && !isPrematureClose(err)) fail(err);
        });
        body = counter;
      }

      const part: StreamingMultipartPart = {
        index: partIndex,
        boundary,
        headers,
        rawHeaders: rawHeaderBlock,
        contentType,
        ...(contentId !== undefined ? { contentId } : {}),
        ...(contentLength !== undefined ? { contentLength } : {}),
        body,
      };

      queue.push({ type: 'part', part });
      // FR-013: fire onProgress per yielded part.
      fireProgress(false);
    });
  };

  const onFinish = (): void => {
    queue.signalEnd();
  };

  const onSourceData = (chunk: Buffer): void => {
    bytesReceived += chunk.length;
    // FR-DR-A-025: idle timer resets ON EVERY CHUNK from the source. This
    // is the SOLE idle-reset path.
    timers.resetIdle();
  };

  // FR-022: an 'end' lets the parser decide truncation (it errors with
  // UnexpectedEndError when the closing delimiter never arrived). No more
  // bytes can arrive, so the idle timer stops: a consumer still reading
  // the last part is not a stalled source.
  const onSourceEnd = (): void => {
    sourceEnded = true;
    timers.stopIdle();
  };

  // A source destroyed without an error and without 'end' (e.g. a fetch
  // body torn down mid-stream) never ends the parser, so it is truncation.
  const onSourceClose = (): void => {
    if (!sourceEnded) fail(new UnexpectedEndError());
  };

  const onParserError = (err: Error): void => {
    fail(err, 'parser');
  };
  const onSourceError = (err: Error): void => {
    fail(err, 'source');
  };

  // The parser and source 'error' listeners are INTENTIONALLY retained
  // through cleanup (FR-011): `fail` logs late errors instead of letting
  // them escape as uncaught exceptions.
  parser.on('part', onPart);
  parser.on('finish', onFinish);
  parser.on('error', onParserError);
  source.on('data', onSourceData);
  source.on('error', onSourceError);
  source.on('end', onSourceEnd);
  source.on('close', onSourceClose);

  // 6. Pipe AFTER all listeners are attached (FR-012).
  source.pipe(parser);

  // FR-010 cleanup — idempotent (`cleaned` guard). Runs from the
  // generator's `finally` on every termination path (success, caller
  // `break`, parser/source error, timeout/abort). Synchronous and total.
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;

    source.off('data', onSourceData);
    source.off('end', onSourceEnd);
    source.off('close', onSourceClose);
    try {
      source.unpipe(parser);
    } catch (err) {
      // FR-017 silent-catch replacement site (architecture.md §7).
      logger({
        level: 'warn',
        msg: 'multipart: unpipe failed during cleanup',
        meta: { errSummary: summarizeError(err) },
      });
    }
    if (!source.destroyed) source.destroy();

    // Destroy every body the consumer did not finish — yielded or not — so
    // no part's buffered chunks outlive the iterator (architecture.md §5.3).
    for (const part of queue.drainPendingParts()) part.body.destroy();
    for (const stream of allPartStreams.keys()) {
      if (!stream.destroyed) stream.destroy();
    }
    allPartStreams.clear();

    parser.off('part', onPart);
    parser.off('finish', onFinish);
    timers.signal.removeEventListener('abort', onCombinedAbort);
    timers.cleanup();
  };

  // 7. Yield loop. The `finally` runs on EVERY exit path so cleanup is
  //    centralized.
  try {
    while (true) {
      const item = await queue.next();
      if (item.type === 'error') throw item.err;
      if (item.type === 'end') {
        // FR-013 completion tick: every source byte has been counted.
        fireProgress(true);
        return;
      }
      yield item.part;
    }
  } finally {
    cleanup();
  }
}

type ErrorOrigin = 'operation' | 'parser' | 'source' | 'part-stream';

function isPrematureClose(err: Error): boolean {
  return (err as { code?: unknown }).code === 'ERR_STREAM_PREMATURE_CLOSE';
}

function cancelResponseBody(input: unknown, logger: Logger): void {
  const body = (input as { body?: unknown } | null)?.body;
  if (!(body instanceof ReadableStream) || body.locked) return;
  body.cancel().catch((err: unknown) => {
    logger({
      level: 'warn',
      msg: 'multipart: cancelling the response body failed',
      meta: { errSummary: summarizeError(err) },
    });
  });
}
