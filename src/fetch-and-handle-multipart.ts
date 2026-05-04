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
 *      against `multipart/related` BEFORE constructing dicer. The offending
 *      Content-Type is sanitized via `truncateForErrorEmbed` per
 *      NFR-DR-S-006. T-035 asserts the dicer-activity harness sees zero
 *      Dicer instances on this path.
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

import { MultipartAbortError } from './errors.js';
import { defaultLogger } from './internal/default-logger.js';
import {
  summarizeError,
  truncateForErrorEmbed,
} from './internal/format-error-embed.js';
import { validatePositiveTimeout } from './internal/validate-timeout.js';
import { parseMultipartRelated } from './parse-multipart-related.js';
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
 * @throws {MultipartAbortError} synchronously when `options.signal?.aborted`
 *   is `true` at call time (FR-009). `fetch` is NEVER invoked on this path
 *   — T-013 spies on `globalThis.fetch` to verify.
 * @throws {Error} `multipart: response Content-Type is not multipart/related;
 *   got <actual>` when the response Content-Type doesn't start with
 *   `multipart/related` (case-insensitive) (FR-021). Dicer is NEVER
 *   constructed on this path — T-035 asserts via the dicer-activity
 *   harness.
 * @throws Any error from `parseMultipartRelated` (idle/total timeout,
 *   abort mid-stream, truncation, source error, dicer error, cap overflow).
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
  options: MultipartHandlerOptions<T>,
): Promise<MultipartFetchResult<T>> {
  // 1. Synchronous validation (FR-005 / FR-006 / FR-024 / FR-009).
  //    These all run BEFORE fetch is invoked — T-013 spy contract.
  if (typeof options.parser !== 'function') {
    throw new TypeError('multipart: options.parser is required');
  }
  validatePositiveTimeout('idleTimeoutMs', options.idleTimeoutMs);
  validatePositiveTimeout('totalTimeoutMs', options.totalTimeoutMs);

  // FR-024 runtime check. The static `Omit<RequestInit, 'signal'>` on
  // MultipartHandlerOptions.fetchInit handles the type-level rejection;
  // the runtime check catches dynamic spreads or `as any` consumers who
  // launder past TypeScript.
  if (
    options.fetchInit !== undefined &&
    'signal' in options.fetchInit &&
    (options.fetchInit as { signal?: unknown }).signal !== undefined
  ) {
    throw new Error(
      'multipart: pass signal via options.signal — fetchInit.signal is reserved for internal use',
    );
  }

  // FR-009 already-aborted: throw synchronously with the verbatim caller
  // reason (F-S-006). Fetch is NEVER called on this path.
  if (options.signal?.aborted === true) {
    throw new MultipartAbortError(options.signal.reason);
  }

  // 2. Logger fallback (FR-018 / JC-2). Resolved once and used at every
  //    Layer-B logger site (onProgress catch, completion-tick catch).
  //    Note: the SAME logger is forwarded to parseMultipartRelated so
  //    Layer A's late-emit / FR-017 sites flow through the caller's
  //    pipeline too.
  const logger: Logger = options.logger ?? defaultLogger;

  // 3. Wallclock + bytes accumulator. Layer B owns the result wallclock
  //    per architecture.md §3 ("owns wallclock for elapsedMs/bytes").
  const startMs = Date.now();
  let lastBytes = 0;

  // 4. Always supply our own onProgress to parseMultipartRelated so we
  //    can capture lastBytes — even when the caller didn't supply one.
  //    When they did, forward the snapshot through with a try/catch that
  //    routes via the resolved logger (FR-017 silent-catch replacement).
  //
  //    NOTE: parse-multipart-related.ts already wraps caller's onProgress
  //    in its own try/catch + logger.warn. To avoid a double-log when the
  //    caller's callback throws, we DO NOT also catch here — Layer A's
  //    catch site is the canonical one. We only forward.
  //
  //    Architecture decision: the inner onProgress closure unconditionally
  //    captures lastBytes; the call-through to options.onProgress lives
  //    inside parseMultipartRelated's fireProgress (which already wraps
  //    in try/catch + logger.warn). To get BOTH behaviors (capture bytes
  //    AND let Layer A do the catching), we pass a wrapper that captures
  //    bytes then defers to options.onProgress directly. Layer A's
  //    fireProgress wraps THIS wrapper, so a throw from options.onProgress
  //    is caught at the Layer A site and routed through Layer A's logger
  //    (which is the same `logger` we resolved above).
  const onProgressForLayerA = (snap: ProgressSnapshot): void => {
    lastBytes = snap.bytes;
    if (options.onProgress !== undefined) {
      options.onProgress(snap);
    }
  };

  // 5. fetch — forward fetchInit (without signal — caller's signal is
  //    threaded through as our `signal` arg). architecture.md §4.2 step 2
  //    explicitly: "caller signal forwarded raw; timers live in Layer A".
  //
  //    A pre-fetch abort fires `fetch` to reject with an AbortError-
  //    flavored DOMException; we surface that as MultipartAbortError if
  //    the caller's signal is now aborted (race-safe: the FR-009 check
  //    above already short-circuits the synchronously-aborted case).
  let res: Response;
  try {
    // Conditional spread: under exactOptionalPropertyTypes, passing
    // `signal: undefined` to fetch's RequestInit is rejected if the
    // declared type is non-optional. Always include the field — fetch
    // accepts AbortSignal | null | undefined at runtime.
    const init: RequestInit = {
      ...(options.fetchInit ?? {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    };
    res = await fetch(url, init);
  } catch (err) {
    // If the caller signal aborted during fetch, surface as
    // MultipartAbortError with the caller-verbatim reason (F-S-006).
    // Re-read the signal because TS's narrowing assumes the FR-009
    // already-aborted check above means the signal can't have aborted —
    // but the caller can fire it asynchronously between then and now.
    const sig = options.signal;
    if (sig?.aborted) {
      throw new MultipartAbortError(sig.reason);
    }
    throw err;
  }

  // 6. FR-021 — Content-Type validation BEFORE dicer construction. The
  //    test-harness asserts `dicer-activity.dicerInstances().length === 0`
  //    on this path (T-035). Case-insensitive prefix check per FR-021;
  //    the offending value is run through `truncateForErrorEmbed` (the
  //    full sanitizer per NFR-DR-S-006).
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/related')) {
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
    totalTimeoutMs: options.totalTimeoutMs,
    onProgress: onProgressForLayerA,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.maxPartBytes !== undefined
      ? { maxPartBytes: options.maxPartBytes }
      : {}),
    ...(options.maxParts !== undefined ? { maxParts: options.maxParts } : {}),
    ...(options.maxHeadersPerPart !== undefined
      ? { maxHeadersPerPart: options.maxHeadersPerPart }
      : {}),
    ...(options.maxHeaderBytesPerPart !== undefined
      ? { maxHeaderBytesPerPart: options.maxHeaderBytesPerPart }
      : {}),
  };

  const parts: T[] = [];
  for await (const part of parseMultipartRelated(res, parseOpts)) {
    const value = await invokeParser(options.parser, part);
    if (value !== undefined) {
      parts.push(value);
    }
    // FR-014: when the parser returns undefined OR the parser returned a
    // value without touching part.body, the LIBRARY drains the body so
    // dicer can advance its state machine to the next part. Without this,
    // a parser that always returns undefined hangs the multipart stream
    // (dicer's per-part Readable buffers indefinitely; the closing
    // boundary never makes it through; the truncation detector
    // mis-fires). Draining is a no-op if the parser already drained.
    if (!part.body.destroyed && part.body.readable) {
      // Drain by iterating to end. The for-await is the canonical
      // drain idiom for a Node Readable in flowing mode.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of part.body) {
        // discard
      }
    }
  }

  // 9. Final completion-tick onProgress (T-014 full assertion). Caller
  //    exceptions are caught and routed via the resolved logger — same
  //    contract as the per-part site in Layer A.
  const elapsedMs = Date.now() - startMs;
  if (options.onProgress !== undefined) {
    const rateBps =
      elapsedMs <= 0 ? 0 : Math.round((lastBytes * 1000) / elapsedMs);
    try {
      options.onProgress({ bytes: lastBytes, elapsedMs, rateBps });
    } catch (err) {
      // FR-017 silent-catch replacement — onProgress completion-tick
      // site lives at Layer B (the per-yielded-part site lives at Layer
      // A's fireProgress). Both flow through the same logger contract.
      logger({
        level: 'warn',
        msg: 'multipart: onProgress threw on completion tick',
        meta: { errSummary: summarizeError(err) },
      });
    }
  }

  // 10. Resolve with the FR-DR-A-029 shape — no response field.
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
