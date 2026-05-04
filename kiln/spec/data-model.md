# Data Model — `@ubercode/multipart-stream`

This document defines every TypeScript type that crosses a public boundary plus every internal data shape needed to implement the library. All types compile under `strict: true` + `exactOptionalPropertyTypes: true` + `noUncheckedIndexedAccess: true`. There is no `any` and no `as any` anywhere in the source.

> **Note on `exactOptionalPropertyTypes` (NFR-DR-A-013).** Public option-bag input fields on `ParseMultipartOptions` and `MultipartHandlerOptions<T>` use the explicit `field?: T | undefined` form (NOT bare `field?: T`). This lets callers spread-merge dynamically-built option records under `exactOptionalPropertyTypes: true` without TypeScript complaining about an `undefined` slot that the schema does not accept. Internal-only types (those in `src/internal/`, never re-exported) MAY use the simpler `field?: T` form since callers do not construct them. Each public field's comment notes the choice explicitly.

---

## 1. Public types (re-exported from `src/index.ts`)

> **AsyncGenerator concurrency contract (F-A-005, Assumption).** The
> `AsyncGenerator<StreamingMultipartPart>` returned by `parseMultipartRelated`
> is designed for **serial** consumption — one in-flight `next()` at a time,
> e.g. via `for await ... of`. Calling `iter.next()` twice without awaiting
> the first is undefined behavior; the library MAY but is NOT required to
> detect and reject the concurrent call with a clear `Error`. Restarting
> iteration after the generator has returned or thrown is also unsupported.

### 1.1 `StreamingMultipartPart`

The yielded shape from `parseMultipartRelated`. One per multipart sub-part.

```ts
import type { Readable } from 'node:stream';

/**
 * One sub-part yielded by `parseMultipartRelated`. The body is a *streaming*
 * Node `Readable` — callers MUST drain or destroy it; if they neither drain nor
 * destroy, the library destroys it for them in the iterator's `finally`.
 */
export interface StreamingMultipartPart {
  /**
   * Zero-based ordinal of this part within the multipart envelope, in the
   * order dicer emits them. Useful for logging and for caller-side
   * deduplication when `content-id` is missing.
   */
  readonly index: number;

  /**
   * The multipart boundary that delimits this envelope. Echoed onto every
   * part for caller-side logging only — parsing has already consumed it.
   */
  readonly boundary: string;

  /**
   * Lowercased part headers as flat strings. Header names are normalized to
   * lowercase (consistent with Node `http`); values are the result of
   * `flattenHeaderValue` over dicer's raw `Buffer` / `Buffer[]` / `Buffer[][]`
   * shapes.
   *
   * `noUncheckedIndexedAccess` is enabled, so reads return `string | undefined`.
   * Convenience getters (`contentType`, `contentId`, `contentLength`) below
   * pre-compute the common ones.
   */
  readonly headers: Readonly<Record<string, string>>;

  /**
   * Pre-extracted `content-type` header value, or `''` if absent. Provided
   * for ergonomics (`if (part.contentType.includes('application/dicom'))`)
   * because callers branch on it constantly.
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
```

**Notes:**

- The reference implementation also surfaced a derived `name` field (`deriveNameFromContentId`). Per FR-016 that derivation moves to `src/internal/derive-name.ts` and is *not* exposed on the part — callers who want a filename call the internal helper themselves (within the library) or do their own derivation. The public `StreamingMultipartPart` is deliberately minimal.
- Reference impl renamed `stream` → `body`. The new name matches Web `Response.body`, which callers are already mentally aligned to.

### 1.2 `PartParser<T>`

```ts
/**
 * Caller-supplied per-part decision function. Receives a part, returns
 * either a value of type `T` (which is collected into `MultipartFetchResult.parts`)
 * or `undefined` (which means "skip this part, contribute nothing").
 *
 * The parser is responsible for either:
 *  - draining `part.body` (e.g. via `streamToString` / `streamToBuffer` / a pipe), OR
 *  - returning `undefined` without touching `part.body` (the library will drain it).
 *
 * If the parser throws (or its returned promise rejects), the operation
 * rejects with that error and the source stream is destroyed (FR-014).
 */
export type PartParser<T> = (part: StreamingMultipartPart) => Promise<T | undefined>;
```

**Notes:**

- Reference impl had `(part, outDir) => Promise<T | null>`. The `outDir` parameter was DICOM-specific and is removed (callers who need a filesystem target close over it). `null` was ambiguous with "the parser computed `null` as a real result" — we standardize on `undefined` for skip (`Array.prototype.find` precedent).

### 1.3 `MultipartFetchResult<T>`

```ts
/**
 * The resolved value of `fetchAndHandleMultipart`. Successful operations
 * resolve with `parts` populated. Per-part parser failures are NOT bundled
 * here — they reject the whole call (FR-014). The body stream is already
 * consumed by the time this resolves, so the original `Response` is NOT
 * exposed (see FR-DR-A-029): callers needing more than `status` + `headers`
 * should restructure to use `parseMultipartRelated` directly.
 */
export interface MultipartFetchResult<T> {
  /**
   * Array of values returned by the caller's `PartParser<T>`, in part order,
   * filtered to drop the `undefined`s.
   */
  readonly parts: ReadonlyArray<T>;

  /**
   * Total bytes pulled from the source stream (raw multipart envelope size,
   * not sum of part body sizes). Mirrors the final `onProgress.bytes`.
   */
  readonly bytes: number;

  /**
   * Wall-clock duration from `fetchAndHandleMultipart` entry to resolution,
   * in milliseconds.
   */
  readonly elapsedMs: number;

  /**
   * HTTP status code from the underlying `fetch` response. Captured before
   * the body was consumed and exposed here so callers can branch on it
   * post-stream without holding the `Response`.
   */
  readonly status: number;

  /**
   * The `Headers` object from the underlying `fetch` response. Captured
   * before the body was consumed; safe to read after this result resolves.
   */
  readonly headers: Headers;
}
```

**Notes:**

- Reference impl had `data: T[]`, `errors: Error[]`, `hadError: boolean`. The `errors`/`hadError` fields conflicted with FR-014 (parser throw must reject) and with the standards `error-handling.md` (no silent collection of errors with a soft-fail return). We rename `data` → `parts` for clarity (the values come from parts).
- Per JC-1 / FR-DR-A-029: the previously-considered `response: Response` field is REMOVED. Once `fetchAndHandleMultipart` resolves the body has been streamed; handing back the original `Response` is a foot-gun (callers might try to `.text()` it again). `status` + `headers` cover the realistic post-stream inspection use cases.

### 1.4 `ParseMultipartOptions`

```ts
/**
 * Options accepted by `parseMultipartRelated`. `idleTimeoutMs` and
 * `totalTimeoutMs` are REQUIRED (FR-006 / JC-3) — there is no default,
 * so the caller cannot accidentally disable hang protection by typo.
 * Other fields are optional.
 *
 * Per NFR-DR-A-013, every input field uses `field?: T | undefined` (not
 * bare `field?: T`) so callers can spread-merge dynamically-built option
 * records under `exactOptionalPropertyTypes: true`.
 */
export interface ParseMultipartOptions {
  /**
   * REQUIRED. Idle timeout in milliseconds. Resets on every chunk received
   * from the source `Readable` (per-chunk `'data'` listener; FR-DR-A-025).
   * When elapsed without activity, the operation rejects with
   * `MultipartIdleTimeoutError`. Must be a positive finite integer in the
   * range `[1, 2_147_483_647]` (NFR-DR-S-009 — Node clamps `setTimeout`
   * delays above `2^31 - 1`); `0`, `NaN`, `Infinity`, negatives, non-integers,
   * and values `> 2_147_483_647` are rejected synchronously with `TypeError`.
   */
  idleTimeoutMs: number;

  /**
   * REQUIRED. Total timeout in milliseconds, measured from the call to
   * `parseMultipartRelated`. When elapsed, rejects with
   * `MultipartTotalTimeoutError`. Same validation rules as `idleTimeoutMs`.
   */
  totalTimeoutMs: number;

  /**
   * Explicit boundary for raw `Readable` inputs. REQUIRED when `input` is a
   * Node `Readable` (no `Content-Type` to parse); IGNORED when `input` is a
   * `Response` (boundary is extracted from `Content-Type`). Validated before
   * any I/O.
   */
  boundary?: string | undefined;

  /**
   * Caller's `AbortSignal`. If already aborted at call time, the generator
   * throws `MultipartAbortError` on first `next()`. If aborted mid-stream,
   * the source is destroyed and the next `yield` rejects with
   * `MultipartAbortError`.
   */
  signal?: AbortSignal | undefined;

  /**
   * Progress callback. Called at least once per yielded part and once at
   * completion. Caller exceptions are caught, logged via `logger`, and
   * not re-thrown (the library guarantees parsing is not derailed by a
   * faulty progress sink). Note: `onProgress` does NOT drive idle-timer
   * reset — the idle timer is reset by the per-chunk source listener
   * (FR-DR-A-025).
   */
  onProgress?: ((snap: ProgressSnapshot) => void) | undefined;

  /**
   * Pluggable structured-logging shim (FR-018, JC-2). Event-style:
   * `(event: { level, msg, meta? }) => void`. When omitted, internal warnings
   * fall back to `console.warn(msg, meta)`. The library currently only emits
   * events with `level: 'warn'`; the event-style shape leaves room for
   * future levels without a breaking signature change.
   */
  logger?: Logger | undefined;

  /**
   * Per-part body-size cap in bytes (NFR-DR-S-001). When set and a part body
   * exceeds the cap, the iterator rejects with `MultipartPartTooLargeError`
   * and cleanup per FR-010 runs. Omit (default) for no cap. Must be a
   * positive finite integer when set.
   */
  maxPartBytes?: number | undefined;

  /**
   * Maximum number of parts permitted in the envelope (NFR-DR-S-012).
   * Defaults to `10_000` when omitted. When the part count exceeds this,
   * the iterator rejects with `MultipartTooManyPartsError` and cleanup
   * runs. Set explicitly to a different positive integer to override.
   */
  maxParts?: number | undefined;

  /**
   * Maximum number of distinct headers permitted on a single part
   * (NFR-DR-S-004). Defaults to `100`. On overflow, the iterator rejects
   * with `MultipartHeadersTooLargeError` and cleanup runs.
   */
  maxHeadersPerPart?: number | undefined;

  /**
   * Maximum total bytes permitted across the header block of a single part
   * (sum of every name + value + framing, in bytes; NFR-DR-S-004). Defaults
   * to `16_384` (16 KiB). On overflow, the iterator rejects with
   * `MultipartHeadersTooLargeError` and cleanup runs.
   */
  maxHeaderBytesPerPart?: number | undefined;
}
```

### 1.5 `MultipartHandlerOptions<T>`

```ts
/**
 * Options accepted by `fetchAndHandleMultipart<T>`. Extends
 * `ParseMultipartOptions` minus `boundary` (always derived from `Response`
 * `Content-Type`) plus the parser callback. Timeouts are REQUIRED here too
 * (FR-006).
 *
 * Per NFR-DR-A-013, every input field uses `field?: T | undefined` (not
 * bare `field?: T`) so callers can spread-merge dynamically-built option
 * records under `exactOptionalPropertyTypes: true`.
 */
export interface MultipartHandlerOptions<T> {
  /**
   * REQUIRED. Per-part parser; see `PartParser<T>`.
   */
  parser: PartParser<T>;

  /**
   * REQUIRED. Idle timeout in ms (FR-006: no default — battle-tested means
   * deliberate). Validated as positive finite integer in `[1, 2_147_483_647]`
   * at call time (NFR-DR-S-009).
   */
  idleTimeoutMs: number;

  /**
   * REQUIRED. Total timeout in ms. Validated identically.
   */
  totalTimeoutMs: number;

  /**
   * Caller's `AbortSignal`. Same semantics as in `ParseMultipartOptions`.
   */
  signal?: AbortSignal | undefined;

  /**
   * Progress callback. Same semantics as in `ParseMultipartOptions`.
   */
  onProgress?: ((snap: ProgressSnapshot) => void) | undefined;

  /**
   * Logger. Same semantics as in `ParseMultipartOptions`.
   */
  logger?: Logger | undefined;

  /**
   * Per-part body-size cap (NFR-DR-S-001). Forwarded to
   * `parseMultipartRelated`. See `ParseMultipartOptions.maxPartBytes`.
   */
  maxPartBytes?: number | undefined;

  /**
   * Maximum part count (NFR-DR-S-012; default `10_000`). Forwarded to
   * `parseMultipartRelated`. See `ParseMultipartOptions.maxParts`.
   */
  maxParts?: number | undefined;

  /**
   * Maximum headers per part (NFR-DR-S-004; default `100`). Forwarded.
   */
  maxHeadersPerPart?: number | undefined;

  /**
   * Maximum header-block bytes per part (NFR-DR-S-004; default `16_384`).
   * Forwarded.
   */
  maxHeaderBytesPerPart?: number | undefined;

  /**
   * Optional `RequestInit` forwarded to `fetch(url, init)`. The library
   * unconditionally overrides `init.signal` with its internal combined
   * signal (caller signal + idle-timeout signal + total-timeout signal).
   * Per FR-024, setting `fetchInit.signal` is REJECTED synchronously to
   * prevent silent overwrite — hence the `Omit<RequestInit, 'signal'>`
   * static type.
   */
  fetchInit?: Omit<RequestInit, 'signal'> | undefined;
}
```

### 1.6 `ProgressSnapshot`

```ts
/**
 * Snapshot passed to `onProgress`. All fields are computed at the moment
 * of the call.
 */
export interface ProgressSnapshot {
  /** Cumulative bytes received from the source stream so far. */
  readonly bytes: number;
  /** Wall-clock ms since the operation started. */
  readonly elapsedMs: number;
  /** Bytes per second over `[start, now]`; `0` when `elapsedMs === 0`. */
  readonly rateBps: number;
}
```

### 1.7 `Logger`

```ts
/**
 * Pluggable structured-logging shim (FR-018, JC-2). Event-style: the library
 * calls the function with a single object describing the event, leaving room
 * for additional log levels in the future without a breaking signature change.
 *
 * The library currently only emits events with `level: 'warn'` (the union is
 * `'warn'` for v1; any future expansion would be a minor-version addition).
 *
 * Per NFR-DR-S-008, the `meta` payload NEVER contains raw chunk bytes. When
 * the library logs an `Error` whose source is dicer or the source stream, it
 * passes only an `errSummary: { name, message }` object with `message`
 * truncated to <= 120 chars and control characters stripped.
 *
 * @example
 *   // Pino adapter:
 *   const log = pino();
 *   const logger: Logger = (event) => log.warn(event.meta, event.msg);
 *
 * @example
 *   // Default (when omitted): falls back to `console.warn(msg, meta)`.
 */
export type Logger = (event: { level: 'warn'; msg: string; meta?: unknown }) => void;
```

### 1.8 Error classes

All seven are runtime values (FR-019 + NFR-DR-S-001 + NFR-DR-S-004 + NFR-DR-S-012, NFR-012). Each has a stable `name` (unaffected by minification, per NFR-DR-D-007) and inherits `Error`. `Error.cause` is set when there is an upstream cause.

```ts
/**
 * Thrown when no source bytes arrive on the source stream for
 * `idleTimeoutMs` consecutive ms. The source has already been destroyed
 * by the time this is raised.
 */
export class MultipartIdleTimeoutError extends Error {
  override readonly name = 'MultipartIdleTimeoutError';
  /** The configured idle window that elapsed. */
  readonly idleTimeoutMs: number;
  constructor(idleTimeoutMs: number, options?: ErrorOptions);
}

/**
 * Thrown when the total elapsed time of the operation exceeds
 * `totalTimeoutMs`, regardless of source activity.
 */
export class MultipartTotalTimeoutError extends Error {
  override readonly name = 'MultipartTotalTimeoutError';
  /** The configured total window that elapsed. */
  readonly totalTimeoutMs: number;
  constructor(totalTimeoutMs: number, options?: ErrorOptions);
}

/**
 * Thrown when the caller-supplied `AbortSignal` fires (or is already
 * aborted at call time).
 */
export class MultipartAbortError extends Error {
  override readonly name = 'MultipartAbortError';
  /**
   * The signal's `reason` if available, else `undefined`. Surfaced for
   * caller-side logging; the class itself is the discriminator.
   */
  readonly reason?: unknown;
  constructor(reason?: unknown, options?: ErrorOptions);
}

/**
 * Thrown when the source stream ends without emitting the closing
 * multipart boundary (mid-flight server hangup).
 */
export class MultipartTruncatedError extends Error {
  override readonly name = 'MultipartTruncatedError';
  /** Total bytes received before the source ended. */
  readonly bytesReceived: number;
  constructor(bytesReceived: number, options?: ErrorOptions);
}

/**
 * Thrown when a single part body's accumulated bytes exceed the configured
 * `maxPartBytes` cap (NFR-DR-S-001). The offending part body is destroyed
 * and full FR-010 cleanup runs before this surfaces.
 */
export class MultipartPartTooLargeError extends Error {
  override readonly name = 'MultipartPartTooLargeError';
  /** The configured `maxPartBytes` cap that was exceeded. */
  readonly maxPartBytes: number;
  /** Zero-based ordinal of the part whose body overflowed. */
  readonly partIndex: number;
  /** The byte count observed at the moment the cap was tripped. */
  readonly bytesReceived: number;
  constructor(
    info: { maxPartBytes: number; partIndex: number; bytesReceived: number },
    options?: ErrorOptions,
  );
}

/**
 * Thrown when a single part has more headers than `maxHeadersPerPart`
 * (default 100) OR when its header block in bytes exceeds
 * `maxHeaderBytesPerPart` (default 16 KiB) — NFR-DR-S-004. Cleanup per
 * FR-010 runs before this surfaces.
 */
export class MultipartHeadersTooLargeError extends Error {
  override readonly name = 'MultipartHeadersTooLargeError';
  /** Discriminator: which limit was hit. */
  readonly limit: 'count' | 'bytes';
  /** Zero-based ordinal of the offending part. */
  readonly partIndex: number;
  /** The configured cap for the limit that was hit. */
  readonly cap: number;
  /** The observed value at the moment the cap was tripped. */
  readonly observed: number;
  constructor(
    info: { limit: 'count' | 'bytes'; partIndex: number; cap: number; observed: number },
    options?: ErrorOptions,
  );
}

/**
 * Thrown when the multipart envelope contains more parts than
 * `maxParts` (default `10_000`) — NFR-DR-S-012. Cleanup per FR-010 runs
 * before this surfaces.
 */
export class MultipartTooManyPartsError extends Error {
  override readonly name = 'MultipartTooManyPartsError';
  /** The configured `maxParts` cap that was exceeded. */
  readonly maxParts: number;
  /** The observed part count when the cap was tripped (== `maxParts + 1`). */
  readonly observed: number;
  constructor(
    info: { maxParts: number; observed: number },
    options?: ErrorOptions,
  );
}
```

**Notes:**

- `ErrorOptions` is the standard `{ cause?: unknown }` interface shipped with TypeScript lib.es2022. Allows `new MultipartIdleTimeoutError(5000, { cause: lowerLevelErr })`.
- All seven classes are tested for `instanceof` discrimination (US-010 + new caps).
- `name` is set as a `readonly` instance property AND matches the class name verbatim (NFR-DR-D-007). This is essential for callers who must use `err.name === 'MultipartIdleTimeoutError'` as a fallback when `instanceof` returns `false` across the ESM/CJS module-format boundary.

---

## 2. Internal types (live in `src/internal/`, not re-exported)

These shapes describe the queue+notifier bridge, the timer state, and helper inputs/outputs. They are NOT part of the publish surface.

### 2.1 `QueueItem<T>` — bridges dicer's event-emitter shape into the async-iterator

```ts
/**
 * Sentinel marking end-of-stream in the internal queue. Symbol is used
 * (not a string) to guarantee zero collision with caller payloads.
 */
export const END = Symbol('multipart:end');
export type EndSentinel = typeof END;

/**
 * One item in the queue maintained by `parseMultipartRelated`'s internal
 * queue+notifier bridge. Generic so the queue can be used by both the
 * generator and any internal helper that needs the same shape.
 */
export type QueueItem = StreamingMultipartPart | Error | EndSentinel;
```

### 2.2 `QueueNotifier`

```ts
/**
 * The queue+notifier bridge. The dicer event handlers `push` items; the
 * generator's main loop `await waitForItem()` until an item is enqueued
 * or `END` is emitted.
 *
 * Implemented as a closure factory in `src/internal/queue-notifier.ts`,
 * not a class — keeps the surface pure and testable in isolation.
 */
export interface QueueNotifier {
  /** Enqueue an item; wakes any pending `waitForItem` consumer. */
  push(item: QueueItem): void;
  /** Pull the next item, or wait until one is available. */
  next(): Promise<QueueItem>;
  /** Read-only snapshot of pending items (for cleanup-time draining). */
  readonly pending: ReadonlyArray<QueueItem>;
  /** Drain all pending items synchronously, destroying any part bodies. */
  drain(): void;
}
```

### 2.3 `TimerState`

```ts
/**
 * Bundles idle + total + caller-signal abort plumbing. Built once per
 * operation by `src/internal/timers.ts`. Owns its own `AbortController`
 * which is the *first-fire-wins* aggregator for the four termination
 * sources: idle timeout, total timeout, caller signal, parser-throw /
 * source-error.
 *
 * Per FR-DR-A-025 / FR-007, `resetIdle()` is called by the per-chunk
 * `'data'` listener attached to the source `Readable` inside Layer A
 * (`parseMultipartRelated`). It is NOT called from `onProgress` — the
 * progress callback fires per-part, which is too coarse for idle reset.
 */
export interface TimerState {
  /** Composite signal: aborted when ANY source fires. */
  readonly signal: AbortSignal;
  /** Reset the idle timer (called on every source-stream chunk). */
  resetIdle(): void;
  /** Cancel both timers and detach the caller-signal listener. */
  cleanup(): void;
  /**
   * Race-safe trigger from inside the library (e.g. parser throw). Equivalent
   * to `controller.abort(reason)` but exposed as a named API for clarity at
   * call sites.
   */
  abortInternally(reason: unknown): void;
}
```

### 2.4 `ParseInput` (discriminated union)

```ts
/**
 * Normalized input to the parsing core. Public callers pass a `Response`
 * or a `Readable` + boundary; internally we always work in this shape.
 */
export type ParseInput =
  | { kind: 'response'; response: Response; boundary: string }
  | { kind: 'readable'; readable: Readable; boundary: string };
```

### 2.5 `DicerHeadersRaw` (alias for clarity)

```ts
/**
 * The raw header map dicer emits on `'header'`. Values can be `Buffer`,
 * `Buffer[]`, or `Buffer[][]` depending on dicer version + how MIME
 * folding lands. `flattenHeaderValue` collapses all variants to a single
 * UTF-8 string.
 */
export type DicerHeadersRaw = Record<string, Buffer | Buffer[] | Buffer[][] | undefined>;
```

### 2.6 `flattenHeaderValue` input/output

```ts
/**
 * Pure function. Coerces dicer's polymorphic header-value shape to a
 * single string (UTF-8). Returns `''` for nullish input — matches the
 * reference impl, which callers rely on.
 */
export function flattenHeaderValue(v: unknown): string;
```

### 2.7 `flattenDicerHeaders` input/output

```ts
/**
 * Lowercases keys and runs every value through `flattenHeaderValue`.
 * Pure function.
 */
export function flattenDicerHeaders(h: DicerHeadersRaw): Record<string, string>;
```

### 2.8 `sanitizeFileName` (per FR-023, NFR-DR-S-005)

```ts
/**
 * Cross-platform-safe filename normalizer. Internal — never exported.
 * Pipeline: strip path separators (`/`, `\`), strip control chars
 * (0x00–0x1F and 0x7F), strip leading dots, replace anything not in
 * `[A-Za-z0-9._-]` with `_`, cap at 255 chars.
 *
 * Per NFR-DR-S-005, `sanitizeFileName` MUST always return a non-empty
 * string. The fallback `'_'` (single underscore) is returned when ANY
 * of these hold:
 *   - The pipeline above produces an empty string (e.g. input was `'...'`
 *     and leading-dot strip emptied it).
 *   - The result, case-insensitively, matches a Windows reserved device
 *     name with or without an extension: `CON`, `PRN`, `AUX`, `NUL`,
 *     `COM1..COM9`, `LPT1..LPT9` (e.g. `'aux.txt'` → `'_'`).
 *   - The result is the literal `'.'` or `'..'` (pure-dot result).
 *
 * Implementation note: the Windows-reserved check is applied AFTER the
 * leading-dot strip and char-class replace, BEFORE the 255-char cap.
 */
export function sanitizeFileName(name: string): string;
```

### 2.9 `deriveNameFromContentId` (kept internal)

```ts
/**
 * Internal-only. Extracts a filename hint from a `Content-ID` header,
 * passing the result through `sanitizeFileName`. No DICOM-specific
 * `.dcm` defaulting (that was domain-specific in the reference impl).
 *
 * Returns `undefined` if the input is undefined OR the sanitized result
 * is empty.
 */
export function deriveNameFromContentId(contentId: string | undefined): string | undefined;
```

**Note:** This function is no longer used by the public part shape (we dropped `name`). It is retained as an internal utility for parity with the reference impl in case a future feature adds an opt-in `derivedName` to `StreamingMultipartPart`. If it goes unused after Sprint 1, the planner SHOULD delete it.

### 2.10 `extractBoundary` (public — only utility on the publish surface)

```ts
/**
 * Parses the `boundary=` parameter out of a `Content-Type` header value.
 * Handles RFC 2046 quoted-string and bare-token forms.
 *
 * @throws Error if the input is null/undefined/empty.
 * @throws Error if the input has no `boundary=` parameter.
 * @throws Error if the input has a malformed `boundary=` parameter
 *               (matching `m[1] === '' && m[2] === ''`).
 */
export function extractBoundary(contentTypeHeader: string | null | undefined): string;
```

### 2.11 `validatePositiveTimeout` (internal)

```ts
/**
 * Validates an `idleTimeoutMs` / `totalTimeoutMs` value. Throws synchronously
 * (`TypeError`) on `NaN`, non-finite, `<= 0`, non-integer, or values
 * `> 2_147_483_647` (`2^31 - 1`).
 *
 * The upper bound (NFR-DR-S-009) reflects Node's internal `setTimeout`
 * clamping behavior: any delay greater than `2^31 - 1` ms is silently
 * clamped down to `1` ms, which would be a debugging surprise. Callers who
 * want "effectively unlimited" should pass a finite-but-large integer
 * (e.g. `2_147_483_647` itself, ~24.8 days). The error message MUST
 * mention this clamping behavior so callers understand why the bound exists.
 *
 * Centralized for three reasons: (1) consistent error messages across both
 * options, (2) single point to enforce the `2^31 - 1` upper bound, (3) lets
 * the public `parseMultipartRelated` and `fetchAndHandleMultipart` entry
 * points share the validation without duplication.
 *
 * Valid range: `[1, 2_147_483_647]`.
 */
export function validatePositiveTimeout(
  name: 'idleTimeoutMs' | 'totalTimeoutMs',
  value: number,
): void;
```

### 2.12 Internal: dicer ambient declarations

Per FR-DR-A-027, the library ships a hand-written ambient declaration shim
for `dicer` at `src/internal/dicer.d.ts`. This shim types only the surface
the library actually uses, so the published `dist/index.d.ts` is
self-contained — consumers do NOT need `@types/dicer` (which is missing
from npm) and the dual-emit `attw` gate (NFR-DR-D-015) passes cleanly.

The shim shape (sketch — implementation in `src/internal/dicer.d.ts`):

```ts
declare module 'dicer' {
  import type { Readable, Writable } from 'node:stream';

  /**
   * Per-part header bag emitted by dicer's `'header'` event and on the
   * per-part `Readable`. Values can be `Buffer`, `Buffer[]`, or
   * `Buffer[][]` depending on dicer version + folding (see
   * `flattenHeaderValue` for the collapser).
   */
  type DicerHeaderBag = Record<string, Buffer | Buffer[] | Buffer[][] | undefined>;

  /**
   * Per-part `Readable` emitted by dicer on the `'part'` event. The
   * `headers` getter is populated either synchronously on `'part'` or
   * via the per-part `'header'` event (dicer is inconsistent across
   * versions; we read whichever fires first).
   */
  interface DicerPartStream extends Readable {
    headers?: DicerHeaderBag;
    on(event: 'header', listener: (h: DicerHeaderBag) => void): this;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end' | 'close', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  interface DicerOptions {
    boundary: string;
    headerFirst?: boolean;
    maxHeaderPairs?: number;
  }

  class Dicer extends Writable {
    constructor(opts: DicerOptions);
    on(event: 'part', listener: (part: DicerPartStream) => void): this;
    on(event: 'finish', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'header', listener: (h: DicerHeaderBag) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export default Dicer;
  export = Dicer; // CJS interop — import-normalization at call site (FR-DR-A-028)
}
```

**Constraints on the shim:**

- MUST NOT depend on `@types/dicer` (package does not exist on npm).
- MUST NOT leak any type or symbol into the published `dist/index.d.ts`
  (the `pnpm pack --dry-run` test asserts that consumers pulling the
  published types do NOT see a `dicer` import).
- MUST be written defensively for the CJS/ESM dual-export shape (see
  FR-DR-A-028 — the call site uses `const Dicer = dicerMod.default ?? dicerMod`
  to pick the right binding under both module formats).

---

## 3. Field-level traceability matrix

Every spec-mentioned data item is accounted for. This is the table the planner cross-checks against.

| Concept (spec / brief)               | Type / location                                          | Public? | Notes                                              |
| ------------------------------------ | -------------------------------------------------------- | ------- | -------------------------------------------------- |
| `StreamingMultipartPart`             | `src/types.ts` (re-exported)                             | yes     | renamed `stream` → `body`; dropped `name`          |
| `PartParser<T>`                      | `src/types.ts`                                           | yes     | dropped `outDir` 2nd arg; `null` → `undefined`     |
| `ParseMultipartOptions`              | `src/types.ts`                                           | yes     | adds `idleTimeoutMs`/`totalTimeoutMs`/`logger`     |
| `MultipartHandlerOptions<T>`         | `src/types.ts`                                           | yes     | timeouts REQUIRED here (FR-006)                    |
| `MultipartFetchResult<T>`            | `src/types.ts`                                           | yes     | FR-DR-A-029 — `{parts,bytes,elapsedMs,status,headers}`; NO `response` field |
| `ProgressSnapshot`                   | `src/types.ts`                                           | yes     | new — was inline anonymous in reference impl       |
| `Logger`                             | `src/types.ts`                                           | yes     | new (FR-018)                                       |
| `MultipartIdleTimeoutError`          | `src/errors.ts`                                          | yes     | FR-019                                             |
| `MultipartTotalTimeoutError`         | `src/errors.ts`                                          | yes     | FR-019                                             |
| `MultipartAbortError`                | `src/errors.ts`                                          | yes     | FR-019                                             |
| `MultipartTruncatedError`            | `src/errors.ts`                                          | yes     | FR-019, FR-022                                     |
| `MultipartPartTooLargeError`         | `src/errors.ts`                                          | yes     | NFR-DR-S-001                                       |
| `MultipartHeadersTooLargeError`      | `src/errors.ts`                                          | yes     | NFR-DR-S-004                                       |
| `MultipartTooManyPartsError`         | `src/errors.ts`                                          | yes     | NFR-DR-S-012                                       |
| `extractBoundary`                    | `src/extract-boundary.ts`                                | yes     | FR-016 — only utility on publish surface           |
| `streamToString`                     | `src/stream-helpers.ts`                                  | yes     | FR-015 + NFR-DR-S-002 (`maxBytes` cap)             |
| `streamToBuffer`                     | `src/stream-helpers.ts`                                  | yes     | FR-015 + NFR-DR-S-002 (`maxBytes` cap)             |
| `parseMultipartRelated`              | `src/parse-multipart-related.ts`                         | yes     | FR-001, FR-DR-A-025/026                            |
| `fetchAndHandleMultipart`            | `src/fetch-and-handle-multipart.ts`                      | yes     | FR-005, FR-DR-A-029                                |
| Ambient `dicer` declarations         | `src/internal/dicer.d.ts`                                | NO      | FR-DR-A-027 — hand-written shim                    |
| `flattenDicerHeaders`                | `src/internal/flatten-headers.ts`                        | NO      | FR-016 — internal only                             |
| `flattenHeaderValue`                 | `src/internal/flatten-headers.ts`                        | NO      | FR-016                                             |
| `sanitizeFileName`                   | `src/internal/sanitize-filename.ts`                      | NO      | FR-016, FR-023, NFR-DR-S-005                       |
| `deriveNameFromContentId`            | `src/internal/derive-name.ts`                            | NO      | FR-016 (unused after rename — see §2.9 note)       |
| `formatErrorEmbed`                   | `src/internal/format-error-embed.ts`                     | NO      | NFR-DR-S-006 — sanitize embedded attacker bytes    |
| `QueueNotifier`, `QueueItem`, `END`  | `src/internal/queue-notifier.ts`                         | NO      | replaces inline closures in reference              |
| `TimerState`                         | `src/internal/timers.ts`                                 | NO      | replaces `setupIdleTimeout`+`setupTotalTimeout`    |
| `ParseInput`                         | `src/internal/parse-input.ts`                            | NO      | normalizes Response \| Readable                    |
| `validatePositiveTimeout`            | `src/internal/validate.ts`                               | NO      | shared by both public entries; enforces `2^31-1`   |

---

## 4. Defaults and invariants

| Symbol                                       | Default                                   | Invariant                                                                                                |
| -------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ParseMultipartOptions.boundary`             | extracted from `Content-Type` if Response | required if input is `Readable`; throws if missing                                                       |
| `ParseMultipartOptions.signal`               | none                                      | already-aborted signal short-circuits to `MultipartAbortError`                                           |
| `ParseMultipartOptions.idleTimeoutMs`        | REQUIRED (no default; JC-3 / FR-006)      | positive finite integer in `[1, 2_147_483_647]`; missing throws `TypeError`                              |
| `ParseMultipartOptions.totalTimeoutMs`       | REQUIRED (no default; JC-3 / FR-006)      | positive finite integer in `[1, 2_147_483_647]`; missing throws `TypeError`                              |
| `ParseMultipartOptions.logger`               | `console.warn(msg, meta)` fallback        | event-style `(event) => void`; library only emits `level: 'warn'` events                                 |
| `ParseMultipartOptions.maxPartBytes`         | undefined (no cap)                        | when set, must be positive finite integer; overflow → `MultipartPartTooLargeError` (NFR-DR-S-001)        |
| `ParseMultipartOptions.maxParts`             | `10_000`                                  | overflow → `MultipartTooManyPartsError` (NFR-DR-S-012)                                                   |
| `ParseMultipartOptions.maxHeadersPerPart`    | `100`                                     | overflow → `MultipartHeadersTooLargeError` with `limit: 'count'` (NFR-DR-S-004)                          |
| `ParseMultipartOptions.maxHeaderBytesPerPart` | `16_384` (16 KiB)                        | overflow → `MultipartHeadersTooLargeError` with `limit: 'bytes'` (NFR-DR-S-004)                          |
| `MultipartHandlerOptions.idleTimeoutMs`      | REQUIRED                                  | no default; missing throws `TypeError`                                                                   |
| `MultipartHandlerOptions.totalTimeoutMs`     | REQUIRED                                  | no default; missing throws `TypeError`                                                                   |
| `MultipartHandlerOptions.maxPartBytes`/`maxParts`/`maxHeadersPerPart`/`maxHeaderBytesPerPart` | forwarded to `parseMultipartRelated` | same defaults / invariants as `ParseMultipartOptions`                                |
| `streamToString` / `streamToBuffer` `maxBytes` | undefined (no cap)                      | when set, source destroyed and promise rejects on overflow (NFR-DR-S-002)                                |
| `StreamingMultipartPart.headers`             | always lowercase keys                     | mirrors Node `http`                                                                                      |
| `StreamingMultipartPart.contentType`         | `''` if absent                            | never `undefined`                                                                                        |
| `sanitizeFileName` empty / Windows-reserved / dot-only result | mapped to `'_'`          | NFR-DR-S-005 — never returns empty                                                                       |
| `END` sentinel                               | n/a                                       | unique `Symbol`; identity comparison only                                                                |
