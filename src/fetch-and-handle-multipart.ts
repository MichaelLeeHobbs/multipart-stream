/**
 * `fetchAndHandleMultipart` — Layer B (fetch orchestration). FR-005.
 *
 * The wrapper:
 *   1. Validates the option bag synchronously: `parser` presence,
 *      `validatePositiveTimeout` on both timeouts, FR-024 `fetchInit.signal`
 *      ban, and FR-009 already-aborted short-circuit. ALL of these run
 *      BEFORE `fetch` is invoked — T-013 spies on `globalThis.fetch` and
 *      asserts it was never called when the caller's signal is pre-aborted.
 *   2. Calls `fetch(url, { ...fetchInit, signal: options.signal })` —
 *      forwards the caller's `AbortSignal` to fetch directly so a network-
 *      time abort cancels the request before any bytes flow.
 *   3. Validates the response Content-Type (FR-021) case-insensitively
 *      against `multipart/related` BEFORE constructing parser. The offending
 *      Content-Type is sanitized via `truncateForErrorEmbed` per
 *      NFR-DR-S-006. T-035 asserts the parser-activity harness sees zero
 *      Parser instances on this path.
 *   4. Captures `status` + `headers` BEFORE consuming the body
 *      (FR-DR-A-029 — the Response is gone after iteration).
 *   5. Forwards `idleTimeoutMs` / `totalTimeoutMs` / `signal` / `onProgress`
 *      / `logger` / cap fields DOWN to `parseMultipartRelated`. Per
 *      FR-DR-A-026 timer ownership lives in Layer A; Layer B does NOT
 *      construct a TimerState.
 *   6. Drives the for-await loop, awaits `options.parser(part)` per part,
 *      collects non-undefined returns into `parts`.
 *   7. Resolves with `{ parts, bytes, elapsedMs, status, headers }` per
 *      FR-DR-A-029. The previously-considered `response: Response` field
 *      is REMOVED at the type level.
 *
 * Bytes-tracking strategy: the wrapper supplies its own `onProgress`
 * callback to `parseMultipartRelated` regardless of whether the caller
 * supplied one. The internal callback captures `lastBytes` and (when the
 * caller supplied one) forwards the snapshot to the caller — wrapping the
 * caller's call in a try/catch that routes via the resolved logger
 * (FR-017 silent-catch replacement). After the loop ends, the wrapper
 * fires ONE final completion-tick `onProgress` call (T-014 full
 * assertion) with the final `bytes` / `elapsedMs` / `rateBps`.
 */

import { MultipartAbortError, MultipartTotalTimeoutError } from './errors.js';
import { resolveLogger } from './internal/default-logger.js';
import { summarizeError, truncateForErrorEmbed } from './internal/format-error-embed.js';
import { validateOptionalCap, validatePositiveTimeout } from './internal/validate-timeout.js';
import { parseMultipartRelatedFrom } from './parse-multipart-related.js';
import type {
  Logger,
  MultipartFetchResult,
  MultipartHandlerOptions,
  ParseMultipartOptions,
  ProgressSnapshot,
  StreamingMultipartPart,
} from './types.js';

/**
 * Wrap `fetch` end-to-end: call, validate Content-Type, parse multipart,
 * route each part through the caller's `parser`, and resolve with
 * {@link MultipartFetchResult} (FR-DR-A-029 — `{ parts, bytes, elapsedMs,
 * status, headers }`; NO `response` field).
 *
 * @param url - Forwarded to `fetch`. `URL` is supported for parity with
 *   `fetch` itself.
 * @param options - {@link MultipartHandlerOptions}. `parser`,
 *   `idleTimeoutMs`, and `totalTimeoutMs` are REQUIRED (FR-005 / FR-006).
 *   The static `Omit<RequestInit, 'signal'>` on `options.fetchInit` enforces
 *   the FR-024 signal-ban at compile time; the runtime check below catches
 *   dynamic spreads / `as` consumers.
 * @returns A `Promise<MultipartFetchResult<T>>` that resolves once every
 *   part has been processed.
 *
 * @throws {TypeError} `multipart: options.parser is required` when
 *   `options.parser` is missing or not a function.
 * @throws {TypeError} from `validatePositiveTimeout` when either timeout
 *   is missing/invalid (FR-006 / NFR-DR-S-009 — message mentions Node's
 *   `setTimeout` clamping).
 * @throws {Error} `multipart: pass signal via options.signal — fetchInit.signal
 *   is reserved for internal use` when `options.fetchInit.signal` is set
 *   (FR-024).
 * @throws {MultipartAbortError} (as a rejection, before `fetch` is called)
 *   when `options.signal?.aborted` is `true` at call time (FR-009). `fetch` is NEVER invoked on this path
 *   — T-013 spies on `globalThis.fetch` to verify.
 * @throws {Error} `multipart: response Content-Type is not multipart/related;
 *   got <actual>` when the response Content-Type doesn't start with
 *   `multipart/related` (case-insensitive) (FR-021). Parser is NEVER
 *   constructed on this path — T-035 asserts via the parser-activity
 *   harness.
 * @throws Any error from `parseMultipartRelated` (idle/total timeout,
 *   abort mid-stream, truncation, source error, parser error, cap overflow).
 * @throws Any error from `options.parser`.
 *
 * @example
 *   const result = await fetchAndHandleMultipart(url, {
 *     idleTimeoutMs: 10_000,
 *     totalTimeoutMs: 60_000,
 *     parser: async (part) => streamToString(part.body),
 *   });
 *   console.log(result.parts.length, 'parts in', result.elapsedMs, 'ms');
 */
export async function fetchAndHandleMultipart<T>(
  url: string | URL,
  callerOptions: MultipartHandlerOptions<T>,
): Promise<MultipartFetchResult<T>> {
  // A missing options bag reads as empty, so it fails the checks below
  // with their documented messages.
  const options: Partial<MultipartHandlerOptions<T>> = callerOptions ?? {};
  // 3. Wallclock. Layer B owns the result wallclock (architecture.md §3),
  //    and the total timeout is measured from here (FR-008).
  const startMs = Date.now();

  // 1. Synchronous validation (FR-005 / FR-006 / FR-024 / FR-009).
  //    These all run BEFORE fetch is invoked — T-013 spy contract.
  const parser = options.parser;
  if (typeof parser !== 'function') {
    throw new TypeError('multipart: options.parser is required');
  }
  const totalTimeoutMs = options.totalTimeoutMs;
  validatePositiveTimeout('idleTimeoutMs', options.idleTimeoutMs);
  validatePositiveTimeout('totalTimeoutMs', totalTimeoutMs);

  // FR-024 runtime check. The static `Omit<RequestInit, 'signal'>` on
  // MultipartHandlerOptions.fetchInit handles the type-level rejection;
  // the runtime check catches dynamic spreads or `as any` consumers who
  // launder past TypeScript.
  const fetchInit = options.fetchInit ?? {};
  if ('signal' in fetchInit && (fetchInit as { signal?: unknown }).signal !== undefined) {
    throw new Error(
      'multipart: pass signal via options.signal — fetchInit.signal is reserved for internal use',
    );
  }

  // Caps are validated again by Layer A; checking here keeps every
  // validation error ahead of the network call.
  validateOptionalCap('maxPartBytes', options.maxPartBytes);
  validateOptionalCap('maxParts', options.maxParts);
  validateOptionalCap('maxHeadersPerPart', options.maxHeadersPerPart);
  validateOptionalCap('maxHeaderBytesPerPart', options.maxHeaderBytesPerPart);

  // FR-009 already-aborted: throw synchronously with the verbatim caller
  // reason (F-S-006). Fetch is NEVER called on this path.
  const callerSignal = options.signal;
  if (callerSignal?.aborted === true) {
    throw new MultipartAbortError(callerSignal.reason);
  }

  // 2. Logger fallback (FR-018 / JC-2), used for the body-cancel site. The
  //    caller's logger is forwarded to parseMultipartRelated as-is.
  const logger: Logger = resolveLogger(options.logger);

  // 4. Always supply our own onProgress so we can capture the byte count.
  //    Layer A fires it per part and once at completion, and wraps it in
  //    its own try/catch + logger.warn (FR-017), so a throwing caller
  //    callback is caught there — we only forward.
  const callerOnProgress = options.onProgress;
  let lastBytes = 0;
  const onProgressForLayerA = (snap: ProgressSnapshot): void => {
    lastBytes = snap.bytes;
    callerOnProgress?.(snap);
  };

  // 5. fetch. The caller's signal is forwarded raw; the idle/total timers
  //    live in Layer A, except that the total budget must also cover the
  //    wait for response headers, so an internal timer aborts fetch when
  //    the budget runs out first.
  const totalBudget = new AbortController();
  const totalTimer = setTimeout(() => {
    totalBudget.abort();
  }, totalTimeoutMs);
  const fetchSignal =
    callerSignal === undefined
      ? totalBudget.signal
      : AbortSignal.any([callerSignal, totalBudget.signal]);
  let res: Response;
  try {
    res = await fetch(url, { ...fetchInit, signal: fetchSignal });
  } catch (err) {
    // Re-read the signals: the caller can abort asynchronously after the
    // FR-009 check above (the annotation stops TS keeping that narrowing).
    const signalNow: AbortSignal | undefined = callerSignal;
    if (signalNow?.aborted === true) {
      throw new MultipartAbortError(signalNow.reason);
    }
    if (totalBudget.signal.aborted) {
      throw new MultipartTotalTimeoutError(totalTimeoutMs, { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(totalTimer);
  }

  // 6. FR-021 — Content-Type validation BEFORE parser construction (T-035
  //    asserts no parser instance on this path). Case-insensitive prefix
  //    check; the offending value is sanitized per NFR-DR-S-006. The body
  //    is cancelled so the connection is released (US-007).
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/related')) {
    res.body?.cancel().catch((err: unknown) => {
      logger({
        level: 'warn',
        msg: 'multipart: cancelling the response body failed',
        meta: { errSummary: summarizeError(err) },
      });
    });
    throw new Error(
      `multipart: response Content-Type is not multipart/related; got ${truncateForErrorEmbed(contentType)}`,
    );
  }

  // 7. Capture status + headers BEFORE consuming the body (FR-DR-A-029 —
  //    the Response is gone after iteration). The `headers` reference is
  //    the live Headers object; callers who need a frozen snapshot can
  //    construct `new Headers(result.headers)`.
  const status = res.status;
  const headers = res.headers;

  // 8. Drive parseMultipartRelated. Forward EVERYTHING down (FR-DR-A-026
  //    — Layer A owns timers). Conditional spreads honor
  //    exactOptionalPropertyTypes for fields the caller may have omitted.
  const parseOpts: ParseMultipartOptions = {
    idleTimeoutMs: options.idleTimeoutMs,
    totalTimeoutMs,
    onProgress: onProgressForLayerA,
    ...(callerSignal !== undefined ? { signal: callerSignal } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.maxPartBytes !== undefined ? { maxPartBytes: options.maxPartBytes } : {}),
    ...(options.maxParts !== undefined ? { maxParts: options.maxParts } : {}),
    ...(options.maxHeadersPerPart !== undefined
      ? { maxHeadersPerPart: options.maxHeadersPerPart }
      : {}),
    ...(options.maxHeaderBytesPerPart !== undefined
      ? { maxHeaderBytesPerPart: options.maxHeaderBytesPerPart }
      : {}),
  };

  const parts: T[] = [];
  for await (const part of parseMultipartRelatedFrom(res, parseOpts, startMs)) {
    const value = await invokeParser(parser, part);
    if (value !== undefined) {
      parts.push(value);
    }
    // FR-014: when the parser returned without draining part.body, the
    // LIBRARY drains it so the multipart stream can advance to the next
    // part. Draining is a no-op if the parser already drained.
    if (!part.body.destroyed && part.body.readable) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of part.body) {
        // discard
      }
    }
  }

  // 9. Resolve with the FR-DR-A-029 shape — no response field. Layer A's
  //    completion tick has already reported the final byte count.
  const elapsedMs = Date.now() - startMs;
  return { parts, bytes: lastBytes, elapsedMs, status, headers };
}

/**
 * Tiny indirection so the parser invocation is its own statement (helps
 * the line / branch coverage attribution map cleanly to a single site
 * even when the parser returns a non-Promise).
 *
 * @internal
 */
async function invokeParser<T>(
  parser: (part: StreamingMultipartPart) => Promise<T | undefined>,
  part: StreamingMultipartPart,
): Promise<T | undefined> {
  return parser(part);
}
