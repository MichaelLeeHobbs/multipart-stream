# API — `@ubercode/multipart-stream`

This document is the authoritative source for the public publish surface. **Every symbol re-exported from `src/index.ts` is listed below**, with full JSDoc-style block (signature, params, returns, throws, examples) per FR-020. Symbols not listed here MUST stay in `src/internal/` and MUST NOT be re-exported.

---

## Module entry

```ts
// src/index.ts — only file callers import from
export { parseMultipartRelated } from './parse-multipart-related.js';
export { fetchAndHandleMultipart } from './fetch-and-handle-multipart.js';
export { streamToString, streamToBuffer } from './stream-helpers.js';
export { extractBoundary } from './extract-boundary.js';
export {
  MultipartIdleTimeoutError,
  MultipartTotalTimeoutError,
  MultipartAbortError,
  MultipartTruncatedError,
  MultipartPartTooLargeError,
  MultipartHeadersTooLargeError,
  MultipartTooManyPartsError,
} from './errors.js';
export type {
  StreamingMultipartPart,
  PartParser,
  MultipartFetchResult,
  ParseMultipartOptions,
  MultipartHandlerOptions,
  ProgressSnapshot,
  Logger,
} from './types.js';
```

> **Submodule exports policy:** none. Per the spec's Out of Scope, there is no `@ubercode/multipart-stream/utils` or similar. Single entry, single contract.

---

## 1. `parseMultipartRelated`

Signature:

```ts
export function parseMultipartRelated(
  input: Response,
  opts: ParseMultipartOptions,
): AsyncGenerator<StreamingMultipartPart, void, void>;
export function parseMultipartRelated(
  input: Readable,
  opts: ParseMultipartOptions & { boundary: string },
): AsyncGenerator<StreamingMultipartPart, void, void>;
```

### Description

Consume a `multipart/related` envelope as a typed async-iterator of streaming parts. Accepts either a Web `Response` (boundary auto-extracted from `Content-Type`) or a Node `Readable` (explicit `boundary` required). When the input is a `Response` carrying a Web `ReadableStream` body, the library converts it to a Node `Readable` via `Readable.fromWeb` (typed via the proper `ReadableStream<Uint8Array>` cast — no `as never`).

`opts` is REQUIRED on both overloads — `idleTimeoutMs` and `totalTimeoutMs` are mandatory (JC-3 / FR-006). Slow-loris-class hangs on server-side use of `parseMultipartRelated` (e.g., feeding `req.body` from an in-process server) would otherwise be undefended; making the timeouts mandatory closes that vector.

### Parameters

| Name    | Type                                        | Required | Description |
| ------- | ------------------------------------------- | -------- | ----------- |
| `input` | `Response \| Readable`                      | yes      | The source. `Response.body` may not be `null`. |
| `opts`  | `ParseMultipartOptions` (or with `& { boundary: string }` when `input` is `Readable`) | yes — timeouts mandatory (FR-006 / JC-3) | Per `data-model.md` §1.4. |

### Returns

`AsyncGenerator<StreamingMultipartPart, void, void>` — yields `StreamingMultipartPart` in dicer's emit order. Use `for await (const part of …)`. The generator is designed for **serial** consumption only — concurrent `iter.next()` calls without awaiting the previous one are unsupported (data-model.md §1, F-A-005).

### Throws (synchronously, before any iteration)

- `Error('multipart: response body is null')` when `input` is a `Response` with `body === null`.
- `Error('multipart: Content-Type header missing; pass an explicit boundary option for raw Readable inputs')` when `input` is a `Response` with no `Content-Type`.
- `Error('multipart: boundary parameter missing from Content-Type: <header>')` when `Content-Type` is present but lacks `boundary=`. The embedded `<header>` value is sanitized per NFR-DR-S-006 (truncated, control chars redacted, JSON.stringify'd) — see `formatErrorEmbed` in architecture.md §5.
- `Error('multipart: boundary option is required when input is a Readable')` when `input` is a `Readable` but `opts.boundary` is missing.
- `TypeError('multipart: idleTimeoutMs is required (positive finite integer in [1, 2_147_483_647])')` when `opts.idleTimeoutMs` is missing/invalid; same for `totalTimeoutMs` (FR-006 / JC-3 / NFR-DR-S-009). Per NFR-DR-S-009, the message MUST mention Node's `setTimeout` clamping behavior at `2^31 - 1`.
- `MultipartAbortError` if `opts.signal?.aborted === true` at call time (FR-009).

### Throws (asynchronously, from `for await`)

- `MultipartIdleTimeoutError` — no source bytes for `opts.idleTimeoutMs` (US-003).
- `MultipartTotalTimeoutError` — total wallclock exceeded `opts.totalTimeoutMs` (US-004).
- `MultipartAbortError` — `opts.signal` fired mid-stream (US-005). `MultipartAbortError.reason` carries the caller-supplied signal `reason` verbatim or `undefined`; the library never synthesizes a server-derived reason (F-S-006).
- `MultipartTruncatedError` — source ended without closing boundary (FR-022).
- `MultipartPartTooLargeError` — a part body exceeded `opts.maxPartBytes` (NFR-DR-S-001).
- `MultipartHeadersTooLargeError` — a part exceeded `opts.maxHeadersPerPart` or `opts.maxHeaderBytesPerPart` (NFR-DR-S-004).
- `MultipartTooManyPartsError` — envelope exceeded `opts.maxParts` (default `10_000`; NFR-DR-S-012).
- Any `Error` emitted by the source `Readable` or by dicer.

### Cleanup guarantees (FR-010, FR-011, US-007)

On any termination path (success, throw, caller `break`, abort, timeout), the iterator's `finally` MUST:

1. Remove the `'data'` listener attached to the source.
2. Remove the abort listener attached to `opts.signal` (if any).
3. `src.unpipe(dicer)` — wrapped in a logged catch, never silent.
4. `src.destroy()` if not already destroyed.
5. Drain the queue, calling `.destroy()` on every unyielded `StreamingMultipartPart.body`.
6. Remove dicer's `'part'`, `'finish'` listeners.
7. **Keep dicer's `'error'` listener** so late nextTick `'error'` emissions are captured by the configured logger as an event-style call: `logger({ level: 'warn', msg: 'multipart: late parser error after generator close', meta: { errSummary: { name, message } } })` (NFR-DR-S-008 — `errSummary` only, no raw chunk bytes). The error never escapes as an uncaught exception.

### Example

```ts
import { parseMultipartRelated, streamToString } from '@ubercode/multipart-stream';

const res = await fetch('https://api.example.com/blob', {
  headers: { Accept: 'multipart/related' },
});

for await (const part of parseMultipartRelated(res)) {
  console.log(part.contentType, part.contentId);
  if (part.contentType === 'application/json') {
    console.log(JSON.parse(await streamToString(part.body)));
  } else {
    // skip — `finally` will drain
    break;
  }
}
```

---

## 2. `fetchAndHandleMultipart`

Signature:

```ts
export function fetchAndHandleMultipart<T>(
  url: string | URL,
  options: MultipartHandlerOptions<T>,
): Promise<MultipartFetchResult<T>>;
```

### Description

Wraps `fetch` end-to-end: idle + total timeout, abort propagation, progress reporting, content-type validation, multipart parsing, per-part `parser` invocation, and resource cleanup. Resolves with `MultipartFetchResult<T>` on success; rejects on any failure (including parser throws and validation failures). NEVER swallows errors into the result struct (a deliberate departure from the reference impl, per `kiln/standards/error-handling.md`).

### Parameters

| Name      | Type                          | Required | Description                                                  |
| --------- | ----------------------------- | -------- | ------------------------------------------------------------ |
| `url`     | `string \| URL`               | yes      | Forwarded to `fetch`. `URL` is supported for parity with `fetch` itself. |
| `options` | `MultipartHandlerOptions<T>`  | yes      | Per `data-model.md` §1.5.                                    |

### Returns

`Promise<MultipartFetchResult<T>>` — resolves once the multipart envelope has been fully consumed and every part has been handed to `parser`. Per FR-DR-A-029 the resolved struct exposes `{ parts, bytes, elapsedMs, status, headers }` (NOT the original `Response` — the body has been consumed by the time this resolves). Callers needing the full `Response` should use `parseMultipartRelated` directly and manage the response themselves.

### Throws / rejects

- `TypeError` synchronously when `options.parser`, `options.idleTimeoutMs`, or `options.totalTimeoutMs` is missing or invalid (FR-006). The validation message for the timeouts MUST mention Node's `setTimeout` `2^31 - 1` clamping bound (NFR-DR-S-009).
- `MultipartAbortError` synchronously when `options.signal?.aborted === true` (US-005, FR-009).
- `Error('multipart: response Content-Type is not multipart/related; got <actual>')` when the response Content-Type does not start with `multipart/related` case-insensitive (FR-021). The embedded `<actual>` value is sanitized per NFR-DR-S-006 (truncated to <= 120 chars, control chars + ANSI escape sequences replaced with `[redacted-control]`, then JSON.stringify'd so embedded quotes are visible). `fetch` is allowed to complete; dicer is never constructed.
- `Error('multipart: response body is null')` when the response has no body.
- `MultipartIdleTimeoutError`, `MultipartTotalTimeoutError`, `MultipartAbortError`, `MultipartTruncatedError` — same conditions as `parseMultipartRelated`.
- `MultipartPartTooLargeError`, `MultipartHeadersTooLargeError`, `MultipartTooManyPartsError` — same conditions as `parseMultipartRelated` (forwarded options).
- Any error thrown by `options.parser`. The library destroys the source and runs full cleanup, then rejects with the parser's error.
- Any `Error` from `fetch` itself (network failure, DNS, TLS, etc.).

### Behavioral notes

- `options.fetchInit.signal` is RESERVED. If the caller sets `options.fetchInit.signal` (whether or not `options.signal` is also set), the library throws synchronously: `Error('multipart: pass signal via options.signal — fetchInit.signal is reserved for internal use')`. The library composes the caller's `options.signal` with internal idle/total timer signals into the combined signal it forwards to `fetch`. (FR-024.)
- `options.onProgress` is invoked at least once per yielded part and once at completion (FR-013). Caller exceptions are caught and logged via `options.logger` (event-style; see §1.7), never re-thrown.
- `options.parser` returning `undefined` skips the part (FR-014); the part body is drained internally before the next `yield`.
- All resource-cap options (`maxPartBytes`, `maxParts`, `maxHeadersPerPart`, `maxHeaderBytesPerPart`) are forwarded to `parseMultipartRelated` unchanged.

### Example

```ts
import {
  fetchAndHandleMultipart,
  streamToString,
  MultipartIdleTimeoutError,
} from '@ubercode/multipart-stream';

interface MetaPart { kind: 'meta'; payload: unknown }
interface BlobPart { kind: 'blob'; bytes: number }
type Part = MetaPart | BlobPart;

try {
  const result = await fetchAndHandleMultipart<Part>('https://api.example.com/blob', {
    idleTimeoutMs: 10_000,
    totalTimeoutMs: 60_000,
    onProgress: ({ bytes, rateBps }) => console.log(`${bytes}B at ${rateBps}B/s`),
    parser: async (part) => {
      if (part.contentType.startsWith('application/json')) {
        return { kind: 'meta', payload: JSON.parse(await streamToString(part.body)) };
      }
      // count bytes without buffering
      let bytes = 0;
      for await (const chunk of part.body) bytes += chunk.length;
      return { kind: 'blob', bytes };
    },
  });
  console.log(result.parts.length, 'parts in', result.elapsedMs, 'ms');
} catch (err) {
  if (err instanceof MultipartIdleTimeoutError) {
    console.warn('Source went silent for', err.idleTimeoutMs, 'ms');
  } else {
    throw err;
  }
}
```

---

## 3. `streamToString`

Signature:

```ts
export function streamToString(
  readable: Readable,
  encoding?: BufferEncoding,
  options?: { maxBytes?: number },
): Promise<string>;
```

### Description

Drains a Node `Readable` to a single string. Convenience for small text parts (e.g. JSON metadata, XML manifests). Calls `Buffer.from(chunk).toString(encoding)` for non-Buffer chunks, defending against object-mode-ish streams that emit strings already.

### Parameters

| Name       | Type                       | Required | Description |
| ---------- | -------------------------- | -------- | ----------- |
| `readable` | `Readable`                 | yes      | Source stream. Must end. |
| `encoding` | `BufferEncoding`           | optional | Defaults to `'utf8'`. |
| `options.maxBytes` | `number`           | optional | Soft cap on accumulated input bytes (NFR-DR-S-002). When set and accumulated bytes exceed `maxBytes`, the source `readable` is destroyed and the promise rejects with a clear `Error`. Must be a positive finite integer when set. |

### Returns

`Promise<string>` — resolves with the full decoded contents.

### Throws / rejects

- Any `'error'` event from `readable` rejects the promise with that error.
- `Error('streamToString: input exceeded maxBytes (<n>)')` when `options.maxBytes` is set and the source produces more than that many bytes (NFR-DR-S-002).

### Example

```ts
const text = await streamToString(part.body, 'utf8', { maxBytes: 1_000_000 });
console.log(text.length, 'chars');
```

---

## 4. `streamToBuffer`

Signature:

```ts
export function streamToBuffer(
  readable: Readable,
  options?: { maxBytes?: number },
): Promise<Buffer>;
```

### Description

Drains a Node `Readable` to a single `Buffer`. Convenience for small binary parts (e.g. embedded images, small DICOM tags). For larger payloads, callers SHOULD pipe directly to `fs.createWriteStream` or another sink — this helper buffers everything.

### Parameters

| Name       | Type       | Required | Description       |
| ---------- | ---------- | -------- | ----------------- |
| `readable` | `Readable` | yes      | Source stream.    |
| `options.maxBytes` | `number` | optional | Soft cap on accumulated bytes (NFR-DR-S-002). When set and exceeded, the source is destroyed and the promise rejects with a clear `Error`. Must be a positive finite integer when set. |

### Returns

`Promise<Buffer>` — resolves with the concatenated buffer; zero-byte streams resolve to a 0-length `Buffer.alloc(0)`.

### Throws / rejects

- Any `'error'` event from `readable` rejects the promise.
- `Error('streamToBuffer: input exceeded maxBytes (<n>)')` when `options.maxBytes` is set and exceeded (NFR-DR-S-002).

### Example

```ts
const buf = await streamToBuffer(part.body, { maxBytes: 5_000_000 });
await fs.writeFile(`/tmp/${part.contentId ?? 'part'}.bin`, buf);
```

---

## 5. `extractBoundary`

Signature:

```ts
export function extractBoundary(contentTypeHeader: string | null | undefined): string;
```

### Description

Parses the `boundary=` parameter out of a `Content-Type` header. Implements RFC 2046 quoted-string + bare-token forms. Pure function; safe to call repeatedly.

**Performance/Security (NFR-DR-S-011).** The implementation MUST be ReDoS-resistant: it uses a non-backtracking regex or a hand-written tokenizer. The asserted bound is that a 64 KiB pathological `Content-Type` input (with adversarial backslash + quote sequences) parses in `< 50 ms`. A test asserts this in `test-plan.md`.

### Parameters

| Name                | Type                          | Required | Description |
| ------------------- | ----------------------------- | -------- | ----------- |
| `contentTypeHeader` | `string \| null \| undefined` | yes      | The `Content-Type` header value, e.g. `multipart/related; boundary="foo"`. |

### Returns

`string` — the unquoted boundary token.

### Throws

- `Error('multipart: Content-Type header is required to extract boundary')` when input is `null`/`undefined`/`''`.
- `Error('multipart: boundary parameter missing from Content-Type: <header>')` when no `boundary=` substring matches.
- `Error('multipart: boundary parameter is empty in Content-Type: <header>')` when both regex capture groups are empty.

In all error cases that embed the input `<header>` value, the value is run through the internal `formatErrorEmbed` helper (NFR-DR-S-006): truncated to <= 120 chars, control chars (0x00–0x1F, 0x7F) and ANSI escape sequences replaced with the literal token `[redacted-control]`, then `JSON.stringify`'d so embedded quotes are visible to the operator reading the error. This prevents a malicious upstream from injecting log-line-breaking bytes via a crafted `Content-Type`.

### Examples

```ts
extractBoundary('multipart/related; boundary=foo'); // → 'foo'
extractBoundary('multipart/related; boundary="weird;boundary"'); // → 'weird;boundary'
extractBoundary('multipart/related; type="application/dicom"; boundary=BAR; charset=utf-8'); // → 'BAR'
extractBoundary(null); // throws
```

---

## 6. `MultipartIdleTimeoutError`

Signature:

```ts
export class MultipartIdleTimeoutError extends Error {
  override readonly name: 'MultipartIdleTimeoutError';
  readonly idleTimeoutMs: number;
  constructor(idleTimeoutMs: number, options?: ErrorOptions);
}
```

### Description

Thrown when the idle timer elapses without source bytes arriving (FR-007). The source has been destroyed and all listeners removed by the time this surfaces.

### Properties

| Name            | Type     | Description                                            |
| --------------- | -------- | ------------------------------------------------------ |
| `name`          | string   | Always `'MultipartIdleTimeoutError'` (stable).         |
| `idleTimeoutMs` | number   | The configured window that elapsed.                    |
| `message`       | string   | Human-readable: `multipart: idle timeout (<n>ms)`.     |
| `cause`         | unknown  | Optional underlying cause (rarely set for this class). |

### Example

```ts
import { MultipartIdleTimeoutError } from '@ubercode/multipart-stream';

try {
  await fetchAndHandleMultipart(url, { /* … */ });
} catch (err) {
  if (err instanceof MultipartIdleTimeoutError) {
    metrics.increment('multipart.idle_timeout', { ms: err.idleTimeoutMs });
  }
  throw err;
}
```

---

## 7. `MultipartTotalTimeoutError`

Signature:

```ts
export class MultipartTotalTimeoutError extends Error {
  override readonly name: 'MultipartTotalTimeoutError';
  readonly totalTimeoutMs: number;
  constructor(totalTimeoutMs: number, options?: ErrorOptions);
}
```

### Description

Thrown when the total wallclock budget elapses (FR-008) regardless of source activity. Source destroyed, listeners removed.

### Properties

| Name             | Type   | Description                                            |
| ---------------- | ------ | ------------------------------------------------------ |
| `name`           | string | Always `'MultipartTotalTimeoutError'`.                 |
| `totalTimeoutMs` | number | The configured window that elapsed.                    |
| `message`        | string | `multipart: total timeout (<n>ms)`.                    |

### Example

```ts
if (err instanceof MultipartTotalTimeoutError) {
  // Either the server is slow or our budget was unrealistic
  metrics.increment('multipart.total_timeout');
}
```

---

## 8. `MultipartAbortError`

Signature:

```ts
export class MultipartAbortError extends Error {
  override readonly name: 'MultipartAbortError';
  readonly reason?: unknown;
  constructor(reason?: unknown, options?: ErrorOptions);
}
```

### Description

Thrown when the caller-provided `AbortSignal` fires (FR-009), or when it is already aborted at call time. `reason` is the signal's `reason`, surfaced for caller-side branching (e.g. distinguishing user-cancel from upstream-timeout).

### Properties

| Name      | Type    | Description                                                         |
| --------- | ------- | ------------------------------------------------------------------- |
| `name`    | string  | Always `'MultipartAbortError'`.                                     |
| `reason`  | unknown | The signal's `reason` if available, else `undefined`.               |
| `message` | string  | `multipart: operation aborted` (does not embed `reason` for safety). |

### Example

```ts
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(new Error('user cancelled')), 5000);

try {
  await fetchAndHandleMultipart(url, { signal: ctrl.signal, /* … */ });
} catch (err) {
  if (err instanceof MultipartAbortError) {
    console.warn('aborted because:', err.reason);
  }
}
```

---

## 9. `MultipartTruncatedError`

Signature:

```ts
export class MultipartTruncatedError extends Error {
  override readonly name: 'MultipartTruncatedError';
  readonly bytesReceived: number;
  constructor(bytesReceived: number, options?: ErrorOptions);
}
```

### Description

Thrown when the source stream ends without dicer observing the closing multipart boundary (FR-022). Indicates a mid-flight server hangup, a transport-layer cut, or a malformed envelope. Cleanup per FR-010 still runs.

### Properties

| Name             | Type   | Description                                              |
| ---------------- | ------ | -------------------------------------------------------- |
| `name`           | string | Always `'MultipartTruncatedError'`.                      |
| `bytesReceived`  | number | Total bytes pulled from the source before it ended.      |
| `message`        | string | `multipart: stream ended before closing boundary (<n>B received)`. |

### Example

```ts
if (err instanceof MultipartTruncatedError) {
  retryQueue.enqueue({ url, bytesReceived: err.bytesReceived });
}
```

---

## 10. `MultipartPartTooLargeError`

Signature:

```ts
export class MultipartPartTooLargeError extends Error {
  override readonly name: 'MultipartPartTooLargeError';
  readonly maxPartBytes: number;
  readonly partIndex: number;
  readonly bytesReceived: number;
  constructor(
    info: { maxPartBytes: number; partIndex: number; bytesReceived: number },
    options?: ErrorOptions,
  );
}
```

### Description

Thrown when a single part body's accumulated bytes exceed the configured `maxPartBytes` cap (NFR-DR-S-001). The offending part body is destroyed, all unyielded parts are drained, and the source is destroyed before this surfaces.

### Properties

| Name             | Type   | Description                                                |
| ---------------- | ------ | ---------------------------------------------------------- |
| `name`           | string | Always `'MultipartPartTooLargeError'`.                     |
| `maxPartBytes`   | number | The configured cap that was exceeded.                      |
| `partIndex`      | number | Zero-based ordinal of the offending part.                  |
| `bytesReceived`  | number | The byte count observed at the moment the cap was tripped. |
| `message`        | string | `multipart: part <i> exceeded maxPartBytes (<n>) at <m>B`. |

### Example

```ts
import { MultipartPartTooLargeError } from '@ubercode/multipart-stream';

try {
  await fetchAndHandleMultipart(url, {
    idleTimeoutMs: 10_000,
    totalTimeoutMs: 60_000,
    maxPartBytes: 5_000_000,
    parser,
  });
} catch (err) {
  if (err instanceof MultipartPartTooLargeError) {
    metrics.increment('multipart.part_too_large', { partIndex: err.partIndex });
  }
  throw err;
}
```

---

## 11. `MultipartHeadersTooLargeError`

Signature:

```ts
export class MultipartHeadersTooLargeError extends Error {
  override readonly name: 'MultipartHeadersTooLargeError';
  readonly limit: 'count' | 'bytes';
  readonly partIndex: number;
  readonly cap: number;
  readonly observed: number;
  constructor(
    info: { limit: 'count' | 'bytes'; partIndex: number; cap: number; observed: number },
    options?: ErrorOptions,
  );
}
```

### Description

Thrown when a single part has more headers than `maxHeadersPerPart` (default 100) OR when its header block in bytes exceeds `maxHeaderBytesPerPart` (default 16 KiB) — NFR-DR-S-004. Defends against memory-exhaustion via a malicious envelope that ships a part with thousands of headers or a single multi-MB header value.

### Properties

| Name        | Type                   | Description                                                            |
| ----------- | ---------------------- | ---------------------------------------------------------------------- |
| `name`      | string                 | Always `'MultipartHeadersTooLargeError'`.                              |
| `limit`     | `'count' \| 'bytes'`   | Which limit was hit.                                                   |
| `partIndex` | number                 | Zero-based ordinal of the offending part.                              |
| `cap`       | number                 | The configured cap that was exceeded.                                  |
| `observed`  | number                 | Observed value at trip-time (count of headers OR total header bytes).  |
| `message`   | string                 | `multipart: part <i> headers exceeded <limit> cap (<cap>) at <obs>`.   |

### Example

```ts
if (err instanceof MultipartHeadersTooLargeError) {
  log.warn({ limit: err.limit, observed: err.observed }, 'oversized part headers');
}
```

---

## 12. `MultipartTooManyPartsError`

Signature:

```ts
export class MultipartTooManyPartsError extends Error {
  override readonly name: 'MultipartTooManyPartsError';
  readonly maxParts: number;
  readonly observed: number;
  constructor(
    info: { maxParts: number; observed: number },
    options?: ErrorOptions,
  );
}
```

### Description

Thrown when the multipart envelope contains more parts than `maxParts` (default `10_000`) — NFR-DR-S-012. Defends against memory-exhaustion via a deeply nested or pathological multipart payload.

### Properties

| Name       | Type   | Description                                                  |
| ---------- | ------ | ------------------------------------------------------------ |
| `name`     | string | Always `'MultipartTooManyPartsError'`.                       |
| `maxParts` | number | The configured cap that was exceeded.                        |
| `observed` | number | The count when the cap was tripped (`== maxParts + 1`).      |
| `message`  | string | `multipart: envelope exceeded maxParts (<cap>) at part <n>`. |

### Example

```ts
if (err instanceof MultipartTooManyPartsError) {
  log.warn({ cap: err.maxParts }, 'too many parts');
}
```

---

## Discriminating errors at runtime

```ts
import {
  MultipartIdleTimeoutError,
  MultipartTotalTimeoutError,
  MultipartAbortError,
  MultipartTruncatedError,
  MultipartPartTooLargeError,
  MultipartHeadersTooLargeError,
  MultipartTooManyPartsError,
} from '@ubercode/multipart-stream';

function classify(err: unknown): string {
  if (err instanceof MultipartIdleTimeoutError) return 'idle';
  if (err instanceof MultipartTotalTimeoutError) return 'total';
  if (err instanceof MultipartAbortError) return 'abort';
  if (err instanceof MultipartTruncatedError) return 'truncated';
  if (err instanceof MultipartPartTooLargeError) return 'part-too-large';
  if (err instanceof MultipartHeadersTooLargeError) return 'headers-too-large';
  if (err instanceof MultipartTooManyPartsError) return 'too-many-parts';
  return 'other';
}
```

All seven classes are runtime-importable (NFR-012); `instanceof` works across `import`/`require` boundaries because there is exactly one entry point bundle per module format (no duplicated class identities via deep imports).

### `err.name` fallback for cross-format consumers (NFR-DR-D-007)

When a single Node process loads the library through BOTH the ESM bundle (`dist/index.js`) AND the CJS bundle (`dist/index.cjs`) — for example, a CJS application that consumes one library which `import`'s `@ubercode/multipart-stream` while another transitive dependency `require`'s the same package — `instanceof` checks may return `false` even for an error that was conceptually produced by the same class, because the class identity differs across module-format bundles.

The library guarantees a stable `err.name` for every exported error class (set in the constructor as a `readonly` instance property matching the class name verbatim). Use this as a fallback discriminator:

```ts
function classifyByName(err: unknown): string {
  if (!(err instanceof Error)) return 'other';
  switch (err.name) {
    case 'MultipartIdleTimeoutError': return 'idle';
    case 'MultipartTotalTimeoutError': return 'total';
    case 'MultipartAbortError': return 'abort';
    case 'MultipartTruncatedError': return 'truncated';
    case 'MultipartPartTooLargeError': return 'part-too-large';
    case 'MultipartHeadersTooLargeError': return 'headers-too-large';
    case 'MultipartTooManyPartsError': return 'too-many-parts';
    default: return 'other';
  }
}
```

Single-format consumers (pure ESM or pure CJS) can rely on `instanceof` exclusively. Mixed-format consumers SHOULD prefer the name-based discriminator. This is documented in the README's `Error handling` section per `NFR-DR-D-002` / `NFR-DR-D-007`.

---

## Recipes

### Soft-fail per part (continue-on-error)

By design, `fetchAndHandleMultipart` is **fail-fast**: if the parser throws on any part, the whole operation rejects and the source is destroyed (per `kiln/standards/error-handling.md` "no silent error collection"). This matches what a battle-tested library should do by default.

If you need soft-fail semantics — collect successes AND parser errors, return both at the end — wrap your parser with a `try/catch` and return a discriminated value:

```ts
import { fetchAndHandleMultipart, streamToString } from '@ubercode/multipart-stream';

type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error; partIndex: number };

const result = await fetchAndHandleMultipart<Outcome<MyType>>('https://api.example.com/blob', {
  idleTimeoutMs: 10_000,
  totalTimeoutMs: 60_000,
  parser: async (part) => {
    try {
      const json = JSON.parse(await streamToString(part.body));
      return { ok: true, value: json as MyType };
    } catch (err) {
      return { ok: false, error: err as Error, partIndex: part.index };
    }
  },
});

const successes = result.parts.filter((p): p is Extract<Outcome<MyType>, { ok: true }> => p.ok);
const failures = result.parts.filter((p): p is Extract<Outcome<MyType>, { ok: false }> => !p.ok);
```

Caveats:

- Errors from the **library itself** (timeouts, aborts, truncation, malformed boundary, network failure) still reject the outer promise. Soft-fail only applies to errors thrown inside YOUR parser callback.
- A parser that catches and returns `{ ok: false, ... }` is responsible for fully draining `part.body` if the error happened before the body was consumed — otherwise the next iteration will block. Use `streamToBuffer(part.body)` (and discard) inside the catch as a defensive drain.

### Wiring a structured logger (pino, winston, ...)

`Logger` is event-style (FR-018, JC-2):

```ts
type Logger = (event: { level: 'warn'; msg: string; meta?: unknown }) => void;
```

The library calls the logger with a single event object, leaving room for additional levels in the future without a breaking signature change. v1 only emits `level: 'warn'` events; consumers can ignore the `level` field if they treat all events as warnings.

```ts
import pino from 'pino';
import { fetchAndHandleMultipart } from '@ubercode/multipart-stream';

const log = pino();

await fetchAndHandleMultipart(url, {
  idleTimeoutMs: 10_000,
  totalTimeoutMs: 60_000,
  parser,
  logger: (event) => log[event.level](event.meta, event.msg),
});
```

When `logger` is omitted, the library falls back to `console.warn(msg, meta)`.

**Meta sanitization (NFR-DR-S-008).** The library NEVER passes raw chunk bytes or full source-stream `Error` objects through `event.meta`. When logging an `Error` originating from dicer or the source stream (e.g., a late-emit `'error'`), `meta` is shaped as:

```ts
{ errSummary: { name: string; message: string } }
```

— with `message` truncated to <= 120 chars and control characters stripped. Callers wiring a structured logger can rely on `event.meta` containing only safe, log-line-friendly fields. (See test-plan.md `T-077` for the assertion.)

### Composing AbortSignal sources (e.g., your timeout + user cancel)

```ts
const controller = new AbortController();
const timeout = AbortSignal.timeout(30_000);
timeout.addEventListener('abort', () => controller.abort(timeout.reason));
userCancelSignal.addEventListener('abort', () => controller.abort(userCancelSignal.reason));

await fetchAndHandleMultipart(url, {
  idleTimeoutMs: 10_000,
  totalTimeoutMs: 60_000,
  parser,
  signal: controller.signal, // pass your composed signal here, NOT inside fetchInit
});
```

Do NOT set `fetchInit.signal` — the library throws synchronously to prevent silent overwrite (FR-024). Compose your sources into a single `AbortController` and pass that signal as `options.signal`.

---

## Internal-only symbols (NOT re-exported)

For traceability — these MUST stay in `src/internal/` and MUST NOT appear in `src/index.ts`:

- `flattenDicerHeaders`
- `flattenHeaderValue`
- `sanitizeFileName`
- `deriveNameFromContentId`
- `formatErrorEmbed` (NFR-DR-S-006 sanitizer)
- `END` sentinel
- `QueueNotifier`, `QueueItem`, `EndSentinel` types
- `TimerState`, `setupTimers`
- `ParseInput`, `normalizeInput`
- `validatePositiveTimeout`
- Ambient `dicer` declarations in `src/internal/dicer.d.ts` (FR-DR-A-027)

The `pnpm pack --dry-run` test (NFR-008) cross-checks that none of these names appear in the published `dist/index.d.ts`. The dicer-shim isolation test (T-071) additionally asserts that `dist/index.d.ts` contains no `from 'dicer'` import.
