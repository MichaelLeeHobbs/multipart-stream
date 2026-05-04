/**
 * Public type aliases re-exported from `src/index.ts`.
 *
 * Per NFR-DR-A-013, every optional input field on the option-bag interfaces
 * (`ParseMultipartOptions`, `MultipartHandlerOptions<T>`) uses the explicit
 * `field?: T | undefined` form (NOT bare `field?: T`). This lets callers
 * spread-merge dynamically-built option records under
 * `exactOptionalPropertyTypes: true` without TypeScript complaining about an
 * `undefined` slot the schema does not accept.
 *
 * Read-only output fields on `StreamingMultipartPart` and the result struct
 * use the `field?: T | undefined` form too for symmetry.
 *
 * Internal-only types (`src/internal/`) are NOT re-exported and may use the
 * simpler `field?: T` form since callers never construct them.
 */

import type { Readable } from 'node:stream';

/**
 * One sub-part yielded by `parseMultipartRelated`. The body is a *streaming*
 * Node `Readable` — callers MUST drain or destroy it; if they neither drain
 * nor destroy, the library destroys it for them in the iterator's `finally`
 * (FR-010).
 *
 * Headers are normalized to lowercase keys (consistent with Node `http`) and
 * collapsed to single strings; convenience getters (`contentType`,
 * `contentId`, `contentLength`) pre-compute the common ones.
 */
export interface StreamingMultipartPart {
  /**
   * Zero-based ordinal of this part within the multipart envelope, in the
   * order dicer emits them.
   */
  readonly index: number;

  /**
   * The multipart boundary that delimits this envelope. Echoed onto every
   * part for caller-side logging only — parsing has already consumed it.
   */
  readonly boundary: string;

  /**
   * Lowercased part headers as flat strings. Names are normalized to
   * lowercase; values are the result of internal flattening over dicer's
   * `Buffer | Buffer[] | Buffer[][]` shapes.
   *
   * Reads are `string | undefined` due to `noUncheckedIndexedAccess`.
   */
  readonly headers: Readonly<Record<string, string | undefined>>;

  /**
   * Raw header block bytes captured from dicer (concatenated).
   *
   * Surfaced for callers who need byte-exact framing for re-emission or
   * signature verification.
   */
  readonly rawHeaders: Buffer;

  /**
   * Pre-extracted `content-type` header value, or `''` if absent.
   */
  readonly contentType: string;

  /**
   * Pre-extracted `content-id` header value (raw, with angle brackets if the
   * sender included them), or `undefined` if absent.
   */
  readonly contentId?: string | undefined;

  /**
   * Pre-extracted `content-length` parsed via `parseInt(_, 10)`, or
   * `undefined` if the header is absent or non-numeric. Note: dicer streams
   * regardless — this value is informational, not a contract.
   */
  readonly contentLength?: number | undefined;

  /**
   * The streaming body of this part as a Node `Readable`. Backed directly by
   * dicer's per-part stream — no intermediate buffering. Callers MUST consume
   * (drain, pipe, or destroy) before requesting the next part; the library
   * cannot pause dicer's state machine for them.
   */
  readonly body: Readable;
}

/**
 * Caller-supplied per-part decision function. Receives a part, returns
 * either a value of type `T` (collected into `MultipartFetchResult.parts`)
 * or `undefined` ("skip this part, contribute nothing").
 *
 * The parser is responsible for either:
 *  - draining `part.body` (e.g. via `streamToString` / `streamToBuffer` /
 *    a pipe), OR
 *  - returning `undefined` without touching `part.body` (the library will
 *    drain it).
 *
 * If the parser throws (or its returned promise rejects), the operation
 * rejects with that error and the source stream is destroyed (FR-014).
 */
export type PartParser<T> = (
  part: StreamingMultipartPart,
) => Promise<T | undefined>;

/**
 * The resolved value of `fetchAndHandleMultipart` (FR-DR-A-029 — JC-1 shape:
 * `{ parts, bytes, elapsedMs, status, headers }`; the previously-considered
 * `response: Response` field is REMOVED because the body is consumed by the
 * time the result resolves).
 *
 * Successful operations resolve with `parts` populated. Per-part parser
 * failures reject the whole call (FR-014) — they are not bundled into this
 * struct.
 */
export interface MultipartFetchResult<T> {
  /**
   * Array of values returned by the caller's `PartParser<T>`, in part order,
   * filtered to drop `undefined`s.
   */
  readonly parts: readonly T[];

  /**
   * Total bytes pulled from the source stream (raw multipart envelope size,
   * not sum of part body sizes).
   */
  readonly bytes: number;

  /** Wall-clock duration from `fetchAndHandleMultipart` entry to resolution. */
  readonly elapsedMs: number;

  /**
   * HTTP status code from the underlying `fetch` response, captured before
   * the body was consumed.
   */
  readonly status: number;

  /**
   * The `Headers` object from the underlying `fetch` response, captured
   * before the body was consumed.
   */
  readonly headers: Headers;
}

/**
 * Snapshot passed to `onProgress`. All fields are computed at the moment of
 * the call.
 */
export interface ProgressSnapshot {
  /** Cumulative bytes received from the source stream so far. */
  readonly bytes: number;
  /** Wall-clock ms since the operation started. */
  readonly elapsedMs: number;
  /** Bytes per second over `[start, now]`; `0` when `elapsedMs === 0`. */
  readonly rateBps: number;
}

/**
 * Pluggable structured-logging shim (FR-018, JC-2). Event-style: the library
 * calls the function with a single object describing the event.
 *
 * The library currently only emits events with `level: 'warn'`. Adding more
 * levels in a future minor version is non-breaking because `level` is a
 * union, not a positional argument.
 *
 * Per NFR-DR-S-008, `meta` NEVER contains raw chunk bytes. When the library
 * logs an `Error` whose source is dicer or the source stream, it passes only
 * an `errSummary: { name, message }` object with `message` truncated to <=
 * 120 chars, control characters redacted, and the value JSON-stringified
 * per NFR-DR-S-006.
 *
 * @example
 *   // Pino adapter:
 *   const logger: Logger = (event) => log[event.level](event.meta, event.msg);
 *
 * @example
 *   // Default (when omitted): falls back to `console.warn(msg, meta)`.
 */
export type Logger = (event: {
  level: 'warn';
  msg: string;
  meta?: unknown;
}) => void;

/**
 * Options accepted by `parseMultipartRelated`. `idleTimeoutMs` and
 * `totalTimeoutMs` are REQUIRED on this entry point too (FR-006 / JC-3 —
 * required-on-both kills the slow-loris vector when the function is used
 * server-side on `req.body`).
 */
export interface ParseMultipartOptions {
  /**
   * REQUIRED. Idle timeout (ms). Resets on every chunk received from the
   * source `Readable` (per-chunk `'data'` listener; FR-DR-A-025).
   * Validated as a positive finite integer in the inclusive range
   * `[1, 2_147_483_647]` (NFR-DR-S-009 — Node clamps `setTimeout` delays
   * above `2^31 - 1`).
   */
  idleTimeoutMs: number;

  /**
   * REQUIRED. Total timeout (ms), measured from the call. Same validation
   * rules as `idleTimeoutMs`.
   */
  totalTimeoutMs: number;

  /**
   * Explicit boundary for raw `Readable` inputs. REQUIRED when `input` is a
   * Node `Readable` (no `Content-Type` to parse); IGNORED when `input` is a
   * `Response` (boundary is extracted from `Content-Type`).
   */
  boundary?: string | undefined;

  /**
   * Caller's `AbortSignal`. Already-aborted at call time → synchronous
   * `MultipartAbortError`. Aborted mid-stream → next yield rejects.
   */
  signal?: AbortSignal | undefined;

  /**
   * Progress callback (FR-013). Fires at least once per yielded part and
   * once at completion. Caller exceptions are caught and routed through
   * `logger`; the library guarantees parsing is not derailed by a faulty
   * sink. Per FR-DR-A-025, `onProgress` does NOT drive idle-timer reset.
   */
  onProgress?: ((snap: ProgressSnapshot) => void) | undefined;

  /**
   * Pluggable structured-logging shim (FR-018, JC-2). Event-style. When
   * omitted, internal warnings fall back to `console.warn(msg, meta)`.
   */
  logger?: Logger | undefined;

  /**
   * Per-part body-size cap (NFR-DR-S-001). Omit (default) for no cap. Must
   * be a positive finite integer when set.
   */
  maxPartBytes?: number | undefined;

  /**
   * Maximum part count (NFR-DR-S-012). Defaults to `10_000` when omitted.
   */
  maxParts?: number | undefined;

  /**
   * Maximum number of distinct headers per part (NFR-DR-S-004). Defaults to
   * `100` when omitted.
   */
  maxHeadersPerPart?: number | undefined;

  /**
   * Maximum total bytes across the header block of a single part
   * (NFR-DR-S-004). Defaults to `16_384` (16 KiB).
   */
  maxHeaderBytesPerPart?: number | undefined;
}

/**
 * Options accepted by `fetchAndHandleMultipart<T>`. Same shape as
 * {@link ParseMultipartOptions} (forwarded down per FR-DR-A-026) plus the
 * required `parser` callback and the optional `fetchInit` for the underlying
 * `fetch` call.
 */
export interface MultipartHandlerOptions<T> {
  /** REQUIRED. Per-part decision function. See {@link PartParser}. */
  parser: PartParser<T>;

  /** REQUIRED. Idle timeout (ms). See {@link ParseMultipartOptions.idleTimeoutMs}. */
  idleTimeoutMs: number;

  /** REQUIRED. Total timeout (ms). See {@link ParseMultipartOptions.totalTimeoutMs}. */
  totalTimeoutMs: number;

  /** Caller's `AbortSignal`. Same semantics as in {@link ParseMultipartOptions}. */
  signal?: AbortSignal | undefined;

  /** Progress callback. Same semantics as in {@link ParseMultipartOptions}. */
  onProgress?: ((snap: ProgressSnapshot) => void) | undefined;

  /** Logger. Same semantics as in {@link ParseMultipartOptions}. */
  logger?: Logger | undefined;

  /** Per-part body-size cap. Forwarded. (NFR-DR-S-001) */
  maxPartBytes?: number | undefined;

  /** Maximum part count. Forwarded. (NFR-DR-S-012) */
  maxParts?: number | undefined;

  /** Maximum headers per part. Forwarded. (NFR-DR-S-004) */
  maxHeadersPerPart?: number | undefined;

  /** Maximum header-block bytes per part. Forwarded. (NFR-DR-S-004) */
  maxHeaderBytesPerPart?: number | undefined;

  /**
   * Optional `RequestInit` for the underlying `fetch` call. The library
   * unconditionally REJECTS `signal` here (FR-024) — pass it via
   * `options.signal` instead. The static `Omit<RequestInit, 'signal'>`
   * surfaces the rule at compile time; the runtime check fires for callers
   * who narrow with `as`.
   */
  fetchInit?: Omit<RequestInit, 'signal'> | undefined;
}
