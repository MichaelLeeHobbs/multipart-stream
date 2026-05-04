/**
 * `parseMultipartRelated` — Layer A (parser/dicer adapter). FR-001.
 *
 * Resource-cap enforcement (NFR-DR-S-001/004/012):
 *   - `maxPartBytes` (NFR-DR-S-001): each per-part body Readable gets a
 *     'data' listener that increments a per-part byte counter; on overflow
 *     the listener pushes `MultipartPartTooLargeError` into the queue and
 *     destroys the offending part body. No default — when undefined, no
 *     cap is enforced.
 *   - `maxParts` (NFR-DR-S-012): the dicer 'part' counter is checked at
 *     each emit; on overflow, push `MultipartTooManyPartsError`. Default
 *     `10_000` when undefined.
 *   - `maxHeadersPerPart` + `maxHeaderBytesPerPart` (NFR-DR-S-004): on
 *     each per-part 'header' event, count headers and sum the byte length
 *     of `name + ': ' + value + '\r\n'` framing for every header line; on
 *     overflow, push `MultipartHeadersTooLargeError`. Defaults: count=100,
 *     bytes=16384 (16 KiB).
 *
 * Timer + abort machinery (FR-006/FR-007/FR-008/FR-009/FR-DR-A-025/
 * FR-DR-A-026):
 *   - `validatePositiveTimeout` calls at the top of the generator enforce
 *     the FR-006 / JC-3 contract (both timeouts REQUIRED, both validated
 *     against `[1, 2^31-1]`).
 *   - `setupTimers(...)` constructs the composite abort signal aggregating
 *     idle, total, and caller-supplied AbortSignal — one source of truth
 *     for all three. The signal listens for any of those firing and pushes
 *     the right error class into the queue.
 *   - The per-chunk source `'data'` listener resets the idle timer
 *     (FR-DR-A-025 — onProgress is NOT used for this).
 *   - The cleanup function calls `timers.cleanup()` — same idempotent
 *     `cleaned` flag.
 *   - Already-aborted callers short-circuit on first `.next()` per FR-009.
 *
 * Cleanup contract: the `finally` cleanup drains unyielded part bodies
 * (FR-010), removes 'data'/'error'/'end' listeners on source and 'part'/
 * 'finish' on dicer, unpipes + destroys source, and KEEPS dicer's 'error'
 * listener for late-emit observability (FR-011). Truncation detection
 * (FR-022) fires when source 'end' arrives without dicer 'finish' having
 * fired.
 */

import { PassThrough, type Readable } from 'node:stream';

import type { DicerHeaderBag, DicerPartStream } from 'dicer';
// FR-DR-A-027: import dicer through the hand-written ambient shim. The
// FR-DR-A-028 normalization shape lives at the call site below (and must
// stay this way — the cross-format consumer test asserts the runtime shape
// works under both ESM and CJS bundles). DO NOT collapse this to
// `import { default as Dicer } from 'dicer'` — that defeats the
// normalization that handles the `module.exports = Dicer` CJS shape.
import dicerMod from 'dicer';

import {
  MultipartAbortError,
  MultipartHeadersTooLargeError,
  MultipartPartTooLargeError,
  MultipartTooManyPartsError,
  MultipartTruncatedError,
} from './errors.js';
import { defaultLogger } from './internal/default-logger.js';
import { flattenDicerHeaders } from './internal/flatten-headers.js';
import { summarizeError } from './internal/format-error-embed.js';
import { normalizeInput } from './internal/normalize-input.js';
import { createQueueNotifier } from './internal/queue-notifier.js';
import { setupTimers } from './internal/timers.js';
import { validatePositiveTimeout } from './internal/validate-timeout.js';
import type {
  Logger,
  ParseMultipartOptions,
  StreamingMultipartPart,
} from './types.js';

/** @internal */
type DicerDefaultExport = typeof dicerMod;

/**
 * Measure the byte length of one or more header VALUES (without the name
 * or framing). Dicer 0.3.1's HeaderParser delivers each header as
 * `string[]` (latin1-decoded line content per repeated header value). We
 * sum each entry's UTF-8 byte length.
 *
 * For the broader forward-compat shapes documented in the ambient shim
 * (`Buffer`, `Buffer[]`, `Buffer[][]`), the function recurses through
 * arrays and falls back to 0 for shapes it can't measure. The cap is
 * SOFT — under-counting at worst means the cap doesn't trip on a
 * forward-incompatible dicer version, NOT that the parser crashes.
 *
 * NOT exported. Used only by the maxHeaderBytesPerPart cap inside the
 * `'header'` event listener.
 *
 * @internal
 */
function measureHeaderValueBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Array.isArray(value)) {
    let total = 0;
    for (const inner of value) {
      total += measureHeaderValueBytes(inner);
    }
    return total;
  }
  // Forward-compat: Buffer / Buffer[] would arrive via the array
  // branch above (Buffer is recursed-into) or directly here. Defensive
  // — returns 0 for unknown shapes, which is safe under the SOFT-cap
  // contract documented above.
  if (Buffer.isBuffer(value)) return value.length;
  return 0;
}

/**
 * FR-DR-A-028 default-export normalization shape (typed; no `as any`).
 *
 * `dicer` is a CJS module whose `module.exports = Dicer` is the constructor
 * itself. Under ESM, Node wraps it as `{ default: Dicer }`; under CJS the
 * import is the raw constructor. The normalizer below picks the right
 * binding for both module formats. The cross-format consumer test (T-072)
 * proves this works against `dist/index.js` AND `dist/index.cjs`.
 *
 * @internal
 */
const Dicer: DicerDefaultExport =
  (dicerMod as { default?: DicerDefaultExport }).default ?? dicerMod;

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
 *   yields parts in dicer's emit order.
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
 *   dicer emits `'finish'` (FR-022).
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
  return parseMultipartRelatedImpl(input, opts);
}

// The async generator below is intentionally one function — see the
// eslint.config.mjs per-file override. It owns three concerns (dicer
// wiring, listener attachment before pipe per FR-012, and the yield loop)
// that are deliberately kept together. Splitting into helpers would require
// shared closure state across helper boundaries and obscure the "all
// listeners before pipe" invariant.
async function* parseMultipartRelatedImpl(
  input: Response | Readable,
  opts: ParseMultipartOptions,
): AsyncGenerator<StreamingMultipartPart, void, void> {
  // 1. Synchronous validation (FR-004 + FR-006/JC-3). Async generators
  //    cannot truly throw at construction time per the vitest contract
  //    (T-002/T-003/T-025 expectations) — every throw here surfaces from
  //    the first `.next()`.
  //
  //    Validate timeouts FIRST, before any input normalization, so callers
  //    who pass an invalid timeout get the precise NFR-DR-S-009 message
  //    even if their input is also malformed. Both timeouts must be present
  //    AND in the inclusive range [1, 2^31-1] (validatePositiveTimeout
  //    handles the missing-value case via the same TypeError path).
  validatePositiveTimeout('idleTimeoutMs', opts.idleTimeoutMs);
  validatePositiveTimeout('totalTimeoutMs', opts.totalTimeoutMs);

  // Resolve resource-cap defaults at validation time so the values stay
  // fixed for the duration of the operation (avoid race conditions where
  // opts mutates between listener fires). Per kiln/spec/api.md §2 and
  // review-security.md F-S-001/004/012:
  //   - maxPartBytes: undefined => no cap (NFR-DR-S-001).
  //   - maxParts: undefined => default 10_000 (NFR-DR-S-012).
  //   - maxHeadersPerPart: undefined => default 100 (NFR-DR-S-004).
  //   - maxHeaderBytesPerPart: undefined => default 16_384 (NFR-DR-S-004).
  // The numeric defaults defend against attacker-controlled inputs even
  // when callers omit the fields entirely.
  const maxPartBytes = opts.maxPartBytes;
  const maxParts = opts.maxParts ?? 10_000;
  const maxHeadersPerPart = opts.maxHeadersPerPart ?? 100;
  const maxHeaderBytesPerPart = opts.maxHeaderBytesPerPart ?? 16_384;

  const { readable: source, boundary } = normalizeInput(input, {
    boundary: opts.boundary,
  });

  // 2. Logger fallback (FR-018 / JC-2). Resolved here so the FR-017 catch
  //    sites (onProgress + cleanup unpipe) and the FR-011 late-emit path
  //    all share the same logger.
  const logger: Logger = opts.logger ?? defaultLogger;

  // 3. Construct dicer via the FR-DR-A-028 normalization at the top of file.
  const dicer = new Dicer({ boundary });

  // 4. Queue+notifier bridge (Layer C internal).
  const queue = createQueueNotifier();

  // Operation state used by the listeners.
  let bytesReceived = 0;
  let nextPartIndex = 0;
  let dicerFinished = false;
  let cleaned = false;
  // Set true when the abort came from the combined-signal handler so the
  // cleanup function knows the queue already received the discriminated
  // error — avoids double-pushing or racing with idle/total firings.
  let abortPushed = false;
  // Set of every per-part Readable dicer has emitted. We need this in
  // addition to queue.drainPendingParts() because a part may have been
  // emitted on dicer's 'part' event but NOT yet reached the per-part
  // 'header' event (so it never made it into the queue). Cleanup must
  // still destroy it — otherwise dicer's per-part Readable buffers a
  // chunk that is never freed (the silent-leak BRIEF flags).
  const allPartStreams = new Set<DicerPartStream>();
  const startMs = Date.now();

  // 4b. Set up the composite abort plumbing (FR-007/FR-008/FR-009/
  //     FR-DR-A-025/FR-DR-A-026). The TimerState aggregates idle, total, and
  //     caller-supplied AbortSignal into a single signal. It MUST be
  //     constructed BEFORE we attach our pre-pipe listeners and BEFORE we
  //     pipe — the timers fire wallclock-based, so any listener added later
  //     would miss synchronous fires. The combined-signal handler attached
  //     below pushes the right error class into the queue.
  const timers = setupTimers(
    {
      idleTimeoutMs: opts.idleTimeoutMs,
      totalTimeoutMs: opts.totalTimeoutMs,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    },
    startMs,
  );

  // FR-009 already-aborted contract: when the caller signal is aborted at
  // call time, the iterator's first `.next()` MUST reject synchronously
  // with MultipartAbortError whose `.reason` is the caller-supplied reason
  // verbatim. Push the error into the queue right now so the for-await
  // loop below picks it up immediately. The MultipartAbortError instance
  // was already constructed by setupTimers — we re-use it via abortError().
  if (timers.signal.aborted) {
    const abortErr =
      timers.abortError() ?? new MultipartAbortError(opts.signal?.reason);
    queue.signalError(abortErr);
    abortPushed = true;
  }

  // Combined-signal handler — fires when ANY of idle/total/caller-abort
  // trigger AFTER setupTimers returned. Same path used for source 'error'
  // and dicer 'error': push into queue, the for-await loop's
  // item.type === 'error' branch surfaces it, and the iterator's `finally`
  // runs cleanup() which also calls timers.cleanup(). The `cleaned` flag
  // protects against late-fire pushes after cleanup ran first (e.g.
  // success path that ran cleanup then a stray total-timer fire that
  // setupTimers' own cleanup missed by a microtask).
  const onCombinedAbort = (): void => {
    if (cleaned || abortPushed) return;
    abortPushed = true;
    const abortErr =
      timers.abortError() ?? new MultipartAbortError(opts.signal?.reason);
    queue.signalError(abortErr);
  };
  // `{ once: true }` because the combined signal is one-shot — once it
  // fires the controller can't fire again, but we still want to honor the
  // contract that this listener never re-runs across cleanup boundaries.
  if (!timers.signal.aborted) {
    timers.signal.addEventListener('abort', onCombinedAbort, { once: true });
  }

  const fireProgress = (): void => {
    const callback = opts.onProgress;
    if (callback === undefined) return;
    const elapsedMs = Date.now() - startMs;
    const rateBps =
      elapsedMs <= 0 ? 0 : Math.round((bytesReceived * 1000) / elapsedMs);
    try {
      callback({ bytes: bytesReceived, elapsedMs, rateBps });
    } catch (err) {
      // FR-017: NEVER silent-catch. Route through the configured logger.
      logger({
        level: 'warn',
        msg: 'multipart: onProgress threw',
        meta: { errSummary: summarizeError(err) },
      });
    }
  };

  // Running counter of dicer 'part' emits. Compared against maxParts on
  // every emit; once observed > cap, push the error and destroy the
  // offending stream. Counts every emit including those past the cap so
  // the surfaced `observed` value is accurate.
  let partsObserved = 0;

  // 5. Attach ALL listeners BEFORE pipe() (FR-012 / US-011). This is the
  //    critical invariant — synchronous early errors from dicer (e.g. a
  //    malformed first byte producing an immediate 'error') must surface
  //    via the queue rather than being lost.
  const onPart = (partStream: DicerPartStream): void => {
    // Dicer's per-part stream emits a single 'header' event with the full
    // header bag. dicer 0.3.1's HeaderParser delivers this as
    // Record<string, string[]>; the ambient shim documents the broader
    // shape Buffer | Buffer[] | Buffer[][] for forward-compat. The
    // flattenDicerHeaders helper handles every documented variant.
    allPartStreams.add(partStream);
    const partIndex = nextPartIndex++;

    // maxParts (NFR-DR-S-012). Trip when the (1-based) emit count
    // exceeds the cap. We push the error and destroy the offending part
    // stream; cleanup() handles the rest of the FR-010 work via the
    // iterator's finally. We deliberately count BEFORE the cap check so
    // observed === maxParts + 1 on the first overflow (the spec's
    // expected value per `cap, observed` shape).
    partsObserved += 1;
    if (partsObserved > maxParts) {
      if (!partStream.destroyed) partStream.destroy();
      queue.signalError(
        new MultipartTooManyPartsError({
          maxParts,
          observed: partsObserved,
        }),
      );
      return;
    }

    const headersAccumulator: { value: Record<string, string | undefined> } = {
      value: {},
    };

    const onHeader = (raw: unknown): void => {
      // maxHeadersPerPart (count) + maxHeaderBytesPerPart (bytes)
      // (NFR-DR-S-004). Inspect the raw bag BEFORE flattening so
      // a header with N repeated values counts as N headers (matching how
      // dicer/HTTP semantics see the wire). Bytes are measured as
      // `name + ': ' + value + '\r\n'` per header line — a deterministic
      // approximation of the on-the-wire framing. We measure on the
      // RAW values (Buffer | Buffer[] | Buffer[][] | string |
      // string[]) without flattening so the count is conservative
      // (under-counts only on shapes the wire wouldn't actually produce).
      // Each header line's wire framing is `name + ": " + value + "\r\n"`.
      // We charge 4 bytes for `": "` + `"\r\n"` per logical line (one
      // line per repeated header value). The byte count is approximate
      // — sufficient for the maxHeaderBytesPerPart cap, which is a
      // soft defense against attacker-bombed envelopes. Dicer 0.3.1
      // always delivers each header value as `string[]` (one entry per
      // repeat); the forward-compat broader shape from the ambient
      // shim is normalized to a uniform array via Array.isArray below.
      const bag = raw as DicerHeaderBag | undefined;
      let headerCount = 0;
      let headerBytes = 0;
      if (bag != null) {
        for (const name of Object.keys(bag)) {
          const value = (bag as Record<string, unknown>)[name];
          const nameBytes = Buffer.byteLength(name);
          const values = Array.isArray(value) ? value : [value];
          for (const inner of values) {
            headerCount += 1;
            headerBytes += nameBytes + 4 + measureHeaderValueBytes(inner);
          }
        }
      }
      if (headerCount > maxHeadersPerPart) {
        if (!partStream.destroyed) partStream.destroy();
        queue.signalError(
          new MultipartHeadersTooLargeError({
            limit: 'count',
            partIndex,
            cap: maxHeadersPerPart,
            observed: headerCount,
          }),
        );
        return;
      }
      if (headerBytes > maxHeaderBytesPerPart) {
        if (!partStream.destroyed) partStream.destroy();
        queue.signalError(
          new MultipartHeadersTooLargeError({
            limit: 'bytes',
            partIndex,
            cap: maxHeaderBytesPerPart,
            observed: headerBytes,
          }),
        );
        return;
      }

      headersAccumulator.value = flattenDicerHeaders(
        raw as Record<string, unknown> | undefined,
      );
      const headers = headersAccumulator.value;
      const contentType = headers['content-type'] ?? '';
      const contentId = headers['content-id'];
      const contentLengthRaw = headers['content-length'];
      const parsedLen =
        contentLengthRaw !== undefined
          ? Number.parseInt(contentLengthRaw, 10)
          : Number.NaN;
      const contentLength = Number.isFinite(parsedLen) ? parsedLen : undefined;

      // maxPartBytes (NFR-DR-S-001). When a cap is configured, wrap the
      // dicer per-part Readable in a counting PassThrough so the
      // public `body` exposed to consumers can observe every byte without
      // racing the consumer's own listener attach (PassThrough buffers
      // upstream writes until a downstream listener is attached, so the
      // consumer's `streamToString` / for-await drain catches every byte
      // even if it attaches several microtasks after we install our pipe).
      // The PassThrough is tracked in `allPartStreams` so cleanup destroys
      // it on every termination path.
      //
      // On overflow we:
      //   (a) destroy the upstream partStream to stop dicer pumping,
      //   (b) push the typed error into the queue,
      //   (c) END the counter cleanly (NOT destroy) so the consumer's
      //       drain on `body` resolves naturally — without this, the
      //       consumer sees a "Premature close" error from their drain
      //       BEFORE our queue.signalError gets a chance to surface, and
      //       the parser's throw eats our typed error. By ending the
      //       counter cleanly, the consumer's for-await of `body`
      //       completes; control returns to the outer for-await of the
      //       iterator; that .next() resolves with our error.
      let publicBody: Readable = partStream as unknown as Readable;
      if (maxPartBytes !== undefined) {
        const cap = maxPartBytes;
        let partBytesAccumulated = 0;
        let tripped = false;
        const counter = new PassThrough();
        // PassThrough extends Readable, and DicerPartStream extends
        // Readable per the ambient shim, so structural typing accepts
        // the PassThrough directly. The Set is used only for cleanup-
        // time `.destroy()` calls (Node Readable API), so the structural
        // overlap is safe.
        allPartStreams.add(counter);
        // Counter for upstream data. We use a Transform-style approach:
        // intercept partStream's 'data' events with a counting listener
        // and write each chunk to the counter ourselves (no `pipe()`).
        // This avoids the EventEmitter snapshot race where the pipe's
        // internal data listener fires AFTER our trip+unpipe (because
        // the listener array was snapshotted at the start of emit()).
        // We also forward 'end' / 'error' / 'close' explicitly.
        const onUpstreamData = (chunk: Buffer): void => {
          if (tripped) return;
          partBytesAccumulated += chunk.length;
          if (partBytesAccumulated > cap) {
            tripped = true;
            // Stop upstream dicer.
            if (!partStream.destroyed) partStream.destroy();
            // Push the typed error BEFORE we end the counter so the
            // queue ordering puts our error ahead of any post-end
            // iterator.next() resolutions.
            queue.signalError(
              new MultipartPartTooLargeError({
                maxPartBytes: cap,
                partIndex,
                bytesReceived: partBytesAccumulated,
              }),
            );
            // End the counter cleanly so consumer drain resolves.
            if (!counter.writableEnded) counter.end();
            return;
          }
          // Below cap: forward to counter (only if counter is still
          // writable — destroyed/ended counters reject further writes).
          if (counter.writable && !counter.writableEnded) {
            counter.write(chunk);
          }
        };
        const onUpstreamEnd = (): void => {
          if (tripped) return;
          if (!counter.writableEnded) counter.end();
        };
        const onUpstreamError = (err: Error): void => {
          // Forward upstream errors to the counter so a truncated part
          // propagates to the consumer's body drain. The per-part error
          // bridge ALSO routes the error to the queue; we deliberately
          // destroy the counter so the consumer's drain can complete.
          if (!counter.destroyed) counter.destroy(err);
        };
        partStream.on('data', onUpstreamData);
        partStream.on('end', onUpstreamEnd);
        partStream.on('error', onUpstreamError);
        publicBody = counter;
      }

      const part: StreamingMultipartPart = {
        index: partIndex,
        boundary,
        headers,
        rawHeaders: Buffer.alloc(0),
        contentType,
        ...(contentId !== undefined ? { contentId } : {}),
        ...(contentLength !== undefined ? { contentLength } : {}),
        // When maxPartBytes is configured, body is the PassThrough that
        // wraps dicer's per-part Readable; otherwise body is dicer's
        // per-part Readable directly. Both expose Node `Readable`.
        body: publicBody,
      };

      queue.push({ type: 'part', part });
      // FR-013: fire onProgress per yielded part. The completion-tick
      // assertion is owned by `fetchAndHandleMultipart`.
      fireProgress();
    };
    partStream.once('header', onHeader);
    // Per-part 'error' bridge. If dicer's per-part stream errors out
    // (e.g. truncated part body — "Part terminated early due to
    // unexpected end of multipart data"), the error propagates as an
    // unhandled 'error' event on the body Readable and Node terminates
    // the process. Bridge the error into the queue (pre-cleanup) or the
    // logger (post-cleanup) so it becomes observable instead of fatal.
    partStream.on('error', (err: Error) => {
      if (cleaned) {
        logger({
          level: 'warn',
          msg: 'multipart: late part-stream error after generator close',
          meta: { errSummary: summarizeError(err) },
        });
        return;
      }
      queue.signalError(err);
    });
  };

  const onFinish = (): void => {
    dicerFinished = true;
    queue.signalEnd();
  };

  // FR-011 contract — this listener is INTENTIONALLY retained through the
  // generator's `finally` block. Before cleanup runs it pushes the error
  // into the queue; AFTER cleanup it routes the error observation through
  // the configured logger so late-tick dicer errors never escape as
  // uncaught process exceptions. The `cleaned` flag is the sole
  // discriminator.
  const onDicerError = (err: Error): void => {
    if (cleaned) {
      logger({
        level: 'warn',
        msg: 'multipart: late parser error after generator close',
        meta: { errSummary: summarizeError(err) },
      });
      return;
    }
    queue.signalError(err);
  };

  const onSourceData = (chunk: Buffer): void => {
    bytesReceived += chunk.length;
    // FR-DR-A-025: idle timer resets ON EVERY CHUNK from the source. This
    // is the SOLE idle-reset path — onProgress (which fires per-part per
    // FR-013) is too coarse for slow-loris protection.
    timers.resetIdle();
  };

  const onSourceError = (err: Error): void => {
    queue.signalError(err);
  };

  // FR-022 truncation detector: when the source emits 'end' but dicer has
  // NOT yet emitted 'finish' on a subsequent tick, the response was cut
  // mid-envelope. Push a MultipartTruncatedError so the consumer's next
  // `.next()` sees it. dicer may also emit its own 'error' if the
  // truncation happens mid-part-header; the queue is first-fire-wins, so
  // whichever path fires first is what surfaces. Either outcome runs the
  // same FR-010 cleanup.
  //
  // We defer the dicerFinished check to `setImmediate` so well-formed
  // envelopes (where dicer's 'finish' fires synchronously after source
  // 'end' through the pipe machinery) do not race-trip the truncation
  // path. setImmediate runs strictly AFTER any pending I/O and any
  // already-scheduled process.nextTick / promise microtasks — long enough
  // for dicer's internal end-of-stream tick to land.
  const onSourceEnd = (): void => {
    setImmediate(() => {
      if (dicerFinished) return;
      if (cleaned) return;
      queue.signalError(new MultipartTruncatedError(bytesReceived));
    });
  };

  dicer.on('part', onPart);
  dicer.on('finish', onFinish);
  dicer.on('error', onDicerError);
  source.on('data', onSourceData);
  source.on('error', onSourceError);
  source.on('end', onSourceEnd);

  // 6. Pipe AFTER all listeners are attached (FR-012).
  source.pipe(dicer);

  // FR-010 cleanup function — idempotent (`cleaned` guard). Runs from the
  // generator's `finally` on every termination path (success, caller
  // `break`, parser/source/dicer error, timeout/abort). The function is
  // intentionally synchronous and total — no awaits, no thrown errors —
  // because the cleanup contract demands it run unconditionally and
  // exactly once.
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;

    // (1) Remove the listeners we attached to the source. Removing by
    //     reference lets us coexist with any listeners the caller (or
    //     downstream layers) may have attached.
    source.off('data', onSourceData);
    source.off('error', onSourceError);
    source.off('end', onSourceEnd);

    // (2) Try to unpipe — wrap in a logged catch (FR-017 silent-catch
    //     replacement site, architecture.md §7).
    try {
      source.unpipe(dicer);
    } catch (err) {
      logger({
        level: 'warn',
        msg: 'multipart: unpipe failed during cleanup',
        meta: { errSummary: summarizeError(err) },
      });
    }

    // (3) Destroy the source if it isn't already done. `destroy()` is
    //     idempotent on Node Readable, but the `.destroyed` short-circuit
    //     keeps the call site free of redundant work.
    if (!source.destroyed) {
      source.destroy();
    }

    // (4) Drain unyielded parts and destroy each one's body. This is the
    //     silent-leak BRIEF flags (architecture.md §5.3): dicer's per-part
    //     Readables hold buffered chunks and are not GC-eligible until
    //     destroyed. If the consumer broke out of the for-await loop,
    //     every still-pending part is leaked unless we destroy here.
    for (const part of queue.drainPendingParts()) {
      // Cast: StreamingMultipartPart.body is typed as Node Readable, which
      // exposes `.destroy()` directly.
      part.body.destroy();
    }
    // Belt-and-suspenders: also destroy any per-part Readable that dicer
    // emitted on 'part' but that never made it into the queue (i.e. it
    // never fired 'header' before cleanup ran — happens on synchronous
    // termination paths like an immediate source error).
    for (const partStream of allPartStreams) {
      if (!partStream.destroyed) partStream.destroy();
    }
    allPartStreams.clear();

    // (5) Remove dicer 'part' and 'finish' listeners. INTENTIONALLY do NOT
    //     remove dicer's 'error' listener — that's the FR-011 contract.
    //     The retained listener checks the `cleaned` flag (set above) to
    //     route late-tick errors through `logger.warn` instead of trying
    //     to push into the now-closed queue.
    dicer.off('part', onPart);
    dicer.off('finish', onFinish);
    // dicer.off('error', onDicerError);  ← deliberately left attached

    // (6) Cancel idle/total timers and detach the caller-signal listener
    //     (Layer C). timers.cleanup() is itself idempotent. We also remove
    //     our combined-signal listener so we don't accumulate references
    //     across operations (the controller is operation-scoped so this
    //     is belt-and-suspenders, but cheap and correct).
    timers.signal.removeEventListener('abort', onCombinedAbort);
    timers.cleanup();
  };

  // 7. Yield loop. The `finally` runs on EVERY exit path (success /
  //    caller break / yield throw / item-error throw / source destroy)
  //    so cleanup is centralized.
  try {
    while (true) {
      const item = await queue.next();
      if (item.type === 'end') return;
      if (item.type === 'error') throw item.err;
      yield item.part;
    }
  } finally {
    cleanup();
  }
}
