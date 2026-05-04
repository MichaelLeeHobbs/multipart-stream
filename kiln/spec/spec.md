# `@ubercode/multipart-stream` — Specification

## Objective

A focused TypeScript library that consumes `multipart/related` HTTP responses as a typed async-iterator of streaming parts, with production-grade idle/total timeout, `AbortSignal` propagation, progress reporting, and cleanup-safe resource hygiene under cancellation. The library exists because the actively-maintained `multipart/related` streaming-parser space on npm is empty as of 2026-05 (`@mjackson/multipart-parser` archived, `dicer` stale, others scoped to `multipart/form-data`), and is being extracted from a working production implementation at `vns/portal/portal-ecia/src/libs/streamingMultipart.ts` — but **not** as a copy job. This is a battle-tested library: tests must rigorously prove correctness AND resource-leak hygiene.

## User Stories

### P0 — Must Have

- **US-001:** As a developer consuming a `multipart/related` HTTP response, I want to iterate the response as a typed async-iterator of parts (each with headers + a streaming body), so that I can process arbitrarily large responses without buffering the whole body.
  - GIVEN a `Response` whose `Content-Type` is `multipart/related; boundary=foo` WHEN I call `parseMultipartRelated(res)` and `for await (const part of ...)` THEN I receive each part as `{ headers, body: Readable, index }` in order.
  - GIVEN the response body is `null` WHEN I call `parseMultipartRelated(res)` THEN it throws synchronously with a clear error before the iterator yields.
  - GIVEN the `Content-Type` is missing the boundary parameter WHEN I call `parseMultipartRelated(res)` THEN it throws synchronously with a clear error.
  - GIVEN the input is a Web `ReadableStream` (e.g., from `fetch` in a non-Node-stream environment) WHEN I call `parseMultipartRelated(res)` THEN the library internally converts via `Readable.fromWeb`.
  - GIVEN the input is a Node `Readable` plus an explicit `boundary` option WHEN I call `parseMultipartRelated(readable, { boundary })` THEN parsing proceeds without needing a `Content-Type` header.

- **US-002:** As a caller, I want to supply a per-part parser callback (`PartParser<T>`) that decides per-part what to do (read, skip, transform), so that I can drive multipart processing from caller-side logic.
  - GIVEN I pass `parser: async (part) => { if (part.headers['content-id'] === 'meta') return JSON.parse(await streamToString(part.body)); }` to `fetchAndHandleMultipart` WHEN parts arrive THEN only the meta part contributes a result, and other parts are drained without buffering.
  - GIVEN my parser returns `undefined` for a part WHEN parsing completes THEN that part contributes nothing to `MultipartFetchResult.parts`.
  - GIVEN my parser throws for a part WHEN that part is processed THEN the error propagates out of `fetchAndHandleMultipart`, and the source stream is destroyed cleanly.

- **US-003:** As a caller, I want an idle timeout that aborts the operation if no source bytes arrive on the network for N ms, so that hung connections don't deadlock the process.
  - GIVEN `idleTimeoutMs: 5000` WHEN no bytes arrive for 5+ seconds THEN the operation rejects with `MultipartIdleTimeoutError` and the source stream is destroyed.
  - GIVEN bytes arrive every 4 seconds WHEN the operation runs for 30 seconds THEN it does NOT idle-timeout (the timer resets on every chunk).

- **US-004:** As a caller, I want a total timeout that aborts the operation if the whole multipart download takes longer than N ms, so that pathologically slow streams don't run forever.
  - GIVEN `totalTimeoutMs: 60_000` WHEN the operation exceeds 60 seconds total THEN it rejects with `MultipartTotalTimeoutError`, even if bytes are still arriving.

- **US-005:** As a caller, I want my own `AbortSignal` to propagate into the in-flight stream, so that I can cancel cleanly from the outside.
  - GIVEN I pass `signal: controller.signal` and call `controller.abort()` mid-stream WHEN the abort fires THEN the operation rejects with `MultipartAbortError`, the source stream is destroyed, and any partly-read part body emits no further data.
  - GIVEN the `AbortSignal` is already aborted before the call WHEN I call `fetchAndHandleMultipart` THEN it rejects synchronously with `MultipartAbortError`.

- **US-006:** As a caller, I want a progress callback that fires periodically with bytes-received / elapsed / rate, so that I can drive UI feedback or monitoring.
  - GIVEN `onProgress: snap => log(snap)` WHEN bytes arrive THEN `onProgress` is called with `{ bytes: number, elapsedMs: number, rateBps: number }` at least once per yielded part and at completion.

- **US-007:** As a caller cancelling mid-iteration, I want the library to clean up all resources (drain unyielded parts, remove listeners, unpipe source, destroy source if not destroyed) so that there are no listener leaks, no leaked sockets, and no late-emit errors crashing my process.
  - GIVEN I `break` out of `for await (const part of parseMultipartRelated(res))` after the first part WHEN the iterator's `finally` runs THEN: every event listener attached by the library is removed; the dicer is unpiped from the source; the source is destroyed; AND no late `'error'` event from dicer escapes as an uncaught exception.
  - GIVEN dicer emits `'error'` AFTER the generator's `finally` has run WHEN the error fires THEN it is observed via `logger.warn('multipart: late parser error after generator close', { err })` and never thrown.

- **US-008:** As a caller working with small text or binary parts, I want convenience helpers `streamToString(readable, encoding?)` and `streamToBuffer(readable)`, so that I don't reimplement stream-collection boilerplate per call.
  - GIVEN a Node `Readable` of small text WHEN I call `await streamToString(readable, 'utf-8')` THEN I get the full string and the readable is fully consumed.
  - GIVEN a Node `Readable` of binary bytes WHEN I call `await streamToBuffer(readable)` THEN I get a `Buffer` of the full content.

### P1 — Should Have

- **US-009:** As a caller in a service that uses structured logging, I want to inject a logger (event-style `(event: { level, msg, meta? }) => void`) so that internal warnings flow through my logging pipeline at the right level/shape rather than `console.warn`.
  - GIVEN I pass `logger: myLogger` THEN all internal log emissions call `myLogger({ level, msg, meta? })` with `level: 'warn'` (currently the only level emitted). GIVEN I omit `logger` THEN warnings default to `console.warn(msg, meta)`.

- **US-010:** As a caller, I want timeout/abort failures to be discriminable error classes (`MultipartIdleTimeoutError`, `MultipartTotalTimeoutError`, `MultipartAbortError`) so that I can branch on `instanceof` in my error handling.

- **US-011:** As a caller relying on early-fault detection, I want the library to attach all listeners BEFORE piping starts, so that a synchronous `'error'` from dicer is never lost.

### P2 — Nice to Have

(none — operator preference is to stay minimal; nice-to-haves go to Out of Scope)

## Functional Requirements

| ID     | Priority | Requirement                                                                                                                                                                                                                              | Notes                                                |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| FR-001 | P0       | The library MUST export `parseMultipartRelated(input, opts?)` that returns an `AsyncGenerator<StreamingMultipartPart>`.                                                                                                                  |                                                      |
| FR-002 | P0       | `parseMultipartRelated` MUST accept either a Web `Response` or a Node `Readable`. When the input is a `Response`, the boundary MUST be extracted from `Content-Type`. When the input is a `Readable`, the caller MUST supply `boundary`. |                                                      |
| FR-003 | P0       | When the input `Response` has a Web `ReadableStream` body, the library MUST convert it to a Node `Readable` internally via `Readable.fromWeb`.                                                                                           |                                                      |
| FR-004 | P0       | The library MUST throw synchronously (before the first `next()`) with a clear error when the body is `null`, when the boundary is missing/unparseable, or when the input is fundamentally invalid.                                      |                                                      |
| FR-005 | P0       | The library MUST export `fetchAndHandleMultipart<T>(url, options)` that wraps `fetch`, calls `parseMultipartRelated` on the response, runs the caller's `parser: PartParser<T>` per part, and resolves to `MultipartFetchResult<T>`.     |                                                      |
| FR-006 | P0       | BOTH `fetchAndHandleMultipart` AND `parseMultipartRelated` MUST require `idleTimeoutMs` and `totalTimeoutMs` in their options (no defaults — battle-tested means deliberate, and a default closes the slow-loris vector when `parseMultipartRelated` is used server-side on `req.body`). | JC-3 / F-S-002. Required on both entry points.       |
| FR-007 | P0       | When `idleTimeoutMs` elapses with no source-stream bytes arriving, the operation MUST reject with `MultipartIdleTimeoutError`. The idle timer MUST reset on every chunk received from the source `Readable` (i.e., the source's per-chunk `'data'` event), NOT on the cadence of `onProgress` (which is per-part per FR-013). | Clarified per F-A-001: idle reset is per-chunk, owned by Layer A. |
| FR-008 | P0       | When `totalTimeoutMs` elapses from the start of the operation, the operation MUST reject with `MultipartTotalTimeoutError`, regardless of activity.                                                                                      |                                                      |
| FR-009 | P0       | When a caller-provided `AbortSignal` fires (or is already aborted at call time), the operation MUST reject with `MultipartAbortError`.                                                                                                   |                                                      |
| FR-010 | P0       | On any termination path (success, idle timeout, total timeout, abort, parser throw, caller `break`), the library MUST drain any unyielded parts, remove all listeners it attached, unpipe the source, and destroy the source.            | Drain prevents stream-GC hazards documented in BRIEF |
| FR-011 | P0       | The library MUST keep dicer's `'error'` listener attached through `finally` so that late `'error'` emissions after generator close are observed (logger.warn) and never escape as uncaught process exceptions.                           |                                                      |
| FR-012 | P0       | All listeners the library attaches to dicer / source streams MUST be attached BEFORE `pipe()` starts, so synchronous early errors are not lost.                                                                                          |                                                      |
| FR-013 | P0       | The library MUST export an `onProgress?: (snap: { bytes, elapsedMs, rateBps }) => void` option that fires at least once per yielded part and at completion.                                                                              |                                                      |
| FR-014 | P0       | The library MUST export a `PartParser<T>` callback type. When the parser returns `undefined`, that part MUST NOT contribute to `MultipartFetchResult.parts`. When the parser throws, the operation MUST reject and clean up per FR-010.  |                                                      |
| FR-015 | P0       | The library MUST export `streamToString(readable, encoding?: BufferEncoding): Promise<string>` and `streamToBuffer(readable): Promise<Buffer>`.                                                                                          |                                                      |
| FR-016 | P0       | The library MUST export `extractBoundary(contentTypeHeader: string): string` (named, public). The supporting utilities `flattenDicerHeaders`, `flattenHeaderValue`, `sanitizeFileName`, `deriveNameFromContentId` MUST stay internal (live in `src/internal/` and NOT be re-exported from `src/index.ts`). | Minimal publish surface, easier to refactor. |
| FR-017 | P0       | The library MUST replace the 3 silent-catch blocks present in the reference implementation with observable patterns: route via the configurable logger (`logger.warn`) at minimum.                                                       | Reference lines 121, 192, 314                        |
| FR-018 | P1       | The library MUST accept an optional `logger?: (event: { level: 'warn'; msg: string; meta?: unknown }) => void` option in both `ParseMultipartOptions` and `MultipartHandlerOptions<T>` — event-style for forward compatibility with future log levels. When omitted, internal warnings MUST go to `console.warn(msg, meta)`. (JC-2.) |                                                      |
| FR-019 | P1       | The library MUST export error classes `MultipartIdleTimeoutError`, `MultipartTotalTimeoutError`, `MultipartAbortError`, `MultipartTruncatedError` (each `extends Error` with a stable `name`) so callers can branch on `instanceof`.     |                                                      |
| FR-020 | P0       | All exported symbols MUST have full JSDoc with `@param`, `@returns`, `@throws`, and at least one `@example` for each public function.                                                                                                    |                                                      |
| FR-021 | P0       | `fetchAndHandleMultipart` MUST validate `response.headers.get('content-type')` starts with `multipart/related` (case-insensitive) before parsing begins. On mismatch, it MUST reject with `Error('multipart: response Content-Type is not multipart/related; got <actual>')` before dicer is constructed. | Fail-fast on JSON error envelopes, etc.              |
| FR-022 | P0       | When the source stream ends without emitting the closing multipart boundary, the operation MUST reject with `MultipartTruncatedError`. Cleanup per FR-010 still runs.                                                                    | Detects mid-flight server hangups.                   |
| FR-023 | P0       | The internal `sanitizeFileName(name)` utility MUST: strip path separators (`/`, `\`), strip control chars (0x00–0x1F and 0x7F), strip leading dots, replace anything not in `[A-Za-z0-9._-]` with `_`, and cap the result at 255 chars. | Cross-platform-safe. Reasoning in design.md.         |
| FR-024 | P0       | `fetchAndHandleMultipart` MUST throw synchronously if the caller sets `options.fetchInit.signal` (whether or not `options.signal` is also set). Error message: `multipart: pass signal via options.signal — fetchInit.signal is reserved for internal use`. | Prevents silent overwrite footgun.                   |
| FR-DR-A-025 | P0  | The idle timer MUST live inside `parseMultipartRelated` (Layer A) and be reset by the per-chunk `'data'` listener attached to the source `Readable`. `onProgress` MUST NOT be repurposed as the idle-reset hook. | F-A-001. Pairs with FR-007 clarification.            |
| FR-DR-A-026 | P0  | `fetchAndHandleMultipart` MUST forward `idleTimeoutMs`, `totalTimeoutMs`, and `signal` to `parseMultipartRelated` rather than consuming them at the fetch wrapper. Timer ownership lives in one place (Layer A) for both entry points. | F-A-001.                                             |
| FR-DR-A-027 | P0  | The library MUST ship a hand-written ambient declaration shim for `dicer` at `src/internal/dicer.d.ts` typing only the surface used (default-export `Dicer` constructor; `'part'`/`'finish'`/`'error'`/`'header'` events; per-part `Readable` shape with raw header bag). The shim MUST NOT depend on `@types/dicer`. The published `dist/index.d.ts` MUST be self-contained. | Convergent: F-A-002 + F-D-003.                       |
| FR-DR-A-028 | P0  | The `dicer` import MUST normalize the CJS default-export shape so `new Dicer({ boundary })` works under both ESM (`dist/index.js`) and CJS (`dist/index.cjs`) consumers (e.g., `import dicerMod from 'dicer'; const Dicer = dicerMod.default ?? dicerMod;` — typed, no `as any`). | F-A-003.                                             |
| FR-DR-D-001 | P0  | The repository MUST contain a top-level `LICENSE` file with the MIT license text and copyright line `Copyright (c) <year> Michael Hobbs` before the first publish. NFR-008's pack-manifest test MUST fail when it is absent. | F-D-001.                                             |
| FR-DR-D-004 | P0  | Before the first publish, `package.json#repository.url` MUST be set to the canonical GitHub URL (`git+https://github.com/<org>/<repo>.git`) and `package.json#bugs.url` MUST be set to the issue tracker. NFR-008's pack-manifest test MUST assert these fields are non-empty. | F-D-004.                                             |
| FR-DR-A-029 | P0  | `MultipartFetchResult<T>` MUST have shape `{ parts: T[]; bytes: number; elapsedMs: number; status: number; headers: Headers }`. The previously-considered `response: Response` field is REMOVED — the response body is consumed by the time the result returns, so exposing the `Response` is a foot-gun. Callers needing more than `status` + `headers` should restructure to use `parseMultipartRelated` directly. | JC-1 / F-A-004.                                     |

## Non-Functional Requirements

| ID      | Category          | Requirement                                                                                                                                                                                  |
| ------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-001 | Type safety       | Strict TS: `strict: true` + `exactOptionalPropertyTypes: true` + `noUncheckedIndexedAccess: true`. No `any`. No `as any`. The single `as never` cast on `Readable.fromWeb` from the reference must be replaced with a proper type assertion. |
| NFR-002 | Module shape      | Dual ESM (`dist/index.js`) + CJS (`dist/index.cjs`) + `.d.ts`. `sideEffects: false`. Single entry `src/index.ts`.                                                                            |
| NFR-003 | Runtime           | Node ≥ 20 (`engines.node: ">=20"`). No browser support claimed (uses `node:stream`).                                                                                                         |
| NFR-004 | Dependencies      | Exactly one runtime dependency: `dicer` pinned at exact version `"0.3.1"` (no caret, no tilde — `dicer` is unmaintained, reproducibility matters more than theoretical patches). No other runtime deps. |
| NFR-005 | Observability     | Zero silent catches anywhere in the codebase. Every `try { ... } catch` block MUST either: re-throw, transform-and-throw, or call `logger.warn`. Lint rule or CI grep MAY enforce.           |
| NFR-006 | Test rigor        | Tests MUST verify resource-leak hygiene (listener-count assertions before/after every termination path), abort/timeout fault injection, malformed-boundary handling, late-emit error handling, and concurrent abort + dicer-error race conditions. (Operator directive: "battle-tested, not a copy.") |
| NFR-007 | Test coverage     | Branch coverage ≥ 90% on `src/**`. Every public function has at least one happy-path test, at least one error-path test, and at least one abort/timeout test (where applicable).             |
| NFR-008 | Publish surface   | `pnpm pack --dry-run` MUST enumerate exactly: `dist/`, `README.md`, `LICENSE`, `package.json`. No source files, no tests, no fixtures, no `tsconfig*.json` leak into the published artifact. |
| NFR-009 | Lint/format       | `pnpm check` (= lint + typecheck + test) passes with zero warnings (`eslint --max-warnings=0`). Prettier 3, single quotes, 100-char width.                                                   |
| NFR-010 | Documentation     | `README.md` ships with: install, quickstart with one fetch + one parser callback example, full API summary, link to spec.                                                                    |
| NFR-011 | Performance       | The library MUST stream parts (no buffering of full body). Memory footprint MUST stay constant relative to part-body size, not response size.                                                |
| NFR-012 | Stability of types | Types of the public API surface MUST be importable as both runtime types (e.g., `import type { ... }`) and at runtime where appropriate. Error classes MUST be runtime-importable (for `instanceof`).                                                                                          |
| NFR-DR-A-013 | Type safety  | NFR-001's "no `any`" includes implicit `any` from untyped imports. Public option-bag input fields on `ParseMultipartOptions` and `MultipartHandlerOptions` MUST use the `field?: T \| undefined` form (not bare `field?: T`) so callers can spread-merge dynamically-built option records under `exactOptionalPropertyTypes`. Internal-only types MAY use the simpler `field?: T` form. (F-A-008.) |
| NFR-DR-A-014 | Runtime      | `engines.node` MUST be set to `">=20.18.0"` (the last Node 20 LTS as of 2026, with stabilized `Readable.fromWeb` backpressure fixes) rather than the looser `">=20"`. Bumping this floor is a major-version bump for the library. (F-A-006 / F-D-008.) |
| NFR-DR-D-002 | Documentation | `README.md` MUST contain (at minimum) the following H2 sections, each non-empty: `Install`, `Quickstart`, `API`, `Error handling`, `Compatibility`, `License`. The `Install` section MUST show `pnpm add @ubercode/multipart-stream`; the `Quickstart` section MUST show one runnable example using `fetchAndHandleMultipart`. (F-D-002.) |
| NFR-DR-D-007 | Stability of types | Every exported error class MUST set its `.name` to a stable string matching the class name (`MultipartIdleTimeoutError`, `MultipartTotalTimeoutError`, `MultipartAbortError`, `MultipartTruncatedError`, plus any new ones introduced by hardening FRs). Caller code that mixes ESM and CJS imports of this library MAY observe `instanceof` returning `false` across the module-format boundary; the documented fallback is `err.name === 'MultipartIdleTimeoutError'`. README's `Error handling` section MUST document this fallback. (F-D-007.) |
| NFR-DR-D-010 | Lint/format   | `tsconfig.base.json` MUST set `"verbatimModuleSyntax": true` so every import/export is unambiguous about value vs type. (F-D-010.) |
| NFR-DR-D-015 | Publish surface | A CI gate (or local pre-publish check) MUST run `pnpm dlx @arethetypeswrong/cli --pack` and exit 0 with no errors across all four moduleResolution scenarios (node10, node16-cjs, node16-esm, bundler). (F-D-015.) |
| NFR-DR-S-001 | Resource caps | `ParseMultipartOptions` and `MultipartHandlerOptions` MUST accept `maxPartBytes?: number` (per-part body-size cap). When set, a part body that exceeds the cap MUST cause the operation to reject with `MultipartPartTooLargeError` and cleanup per FR-010 to run. (F-S-001.) |
| NFR-DR-S-002 | Resource caps | `streamToString` and `streamToBuffer` MUST accept an optional `maxBytes` argument; on overflow they MUST destroy the source and reject with a clear error. (F-S-001.) |
| NFR-DR-S-004 | Resource caps | The library MUST cap per-part header count (default 100) and per-part total header bytes (default 16 KiB), configurable via `ParseMultipartOptions.maxHeadersPerPart` and `maxHeaderBytesPerPart`. On overflow, the operation MUST reject with `MultipartHeadersTooLargeError` and cleanup per FR-010 runs. (F-S-003.) |
| NFR-DR-S-005 | Validation    | `sanitizeFileName` MUST return a non-empty string. When sanitization would produce an empty string, OR a Windows reserved device name (case-insensitive `CON\|PRN\|AUX\|NUL\|COM[1-9]\|LPT[1-9]`, with or without extension), OR a single-/double-dot result (`.`, `..`), it MUST return the literal string `_` instead. (F-S-004.) |
| NFR-DR-S-006 | Info-leak     | Error messages that embed attacker-controlled response header values (FR-021's `<actual>`; `extractBoundary`'s error embeds) MUST: (a) truncate the embedded value to <= 120 characters; (b) replace control characters (0x00–0x1F, 0x7F) and ANSI escape sequences with the literal token `[redacted-control]`; (c) `JSON.stringify` the value so embedded quotes are visible. (F-S-005.) |
| NFR-DR-S-008 | Info-leak     | The library MUST NOT pass raw chunk bytes to `logger.warn` meta. When logging an `Error` whose source is dicer or the source stream, the library MUST log only `err.name` and a truncated `err.message` (<= 120 chars, control-chars stripped) under a key like `errSummary`. (F-S-007 — respects `kiln/standards/error-handling.md`'s no-silent-catch rule by still requiring observability.) |
| NFR-DR-S-009 | Validation    | `validatePositiveTimeout` MUST reject values greater than `2_147_483_647` (`2^31 - 1`) with a clear error message that explains Node's `setTimeout` clamping behavior. The valid range is `[1, 2_147_483_647]`. (F-S-009.) |
| NFR-DR-S-011 | Performance   | `extractBoundary` MUST use a non-backtracking regex or a hand-written tokenizer; a 64 KiB pathological `Content-Type` input MUST complete parsing in `< 50 ms`. A test asserting this MUST exist in the test plan. (F-S-011.) |
| NFR-DR-S-012 | Resource caps | `ParseMultipartOptions` and `MultipartHandlerOptions` MUST accept `maxParts?: number` (default `10_000`). When the part count is exceeded, the operation MUST reject with `MultipartTooManyPartsError` and cleanup per FR-010 runs. (F-S-012.) |

## Edge Cases & Error Scenarios

| Scenario                                                                         | Expected Behavior                                                                                                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `res.body` is `null` (server returned no body)                                   | Synchronous `Error('multipart: response body is null')` before any iteration starts.                                               |
| Missing `Content-Type` header on `Response`                                      | Synchronous error: `Content-Type required to extract boundary; pass an explicit boundary option if input is a raw Readable`.       |
| `Content-Type` present but no `boundary=...` parameter                           | Synchronous error: `boundary parameter missing from Content-Type`.                                                                 |
| Boundary contains quoted-string with embedded special chars                      | Quoted-string boundary parsing must work (RFC 2046).                                                                               |
| Caller `break`s out of iteration after the first part                            | `finally` drains remaining parts, removes all listeners, unpipes, destroys source. No leak.                                        |
| Caller throws inside the `for await` loop                                        | Same cleanup as `break`. The thrown error propagates.                                                                              |
| Network stalls (no chunks for `idleTimeoutMs`)                                   | `MultipartIdleTimeoutError` rejection. Source destroyed.                                                                           |
| Network arrives slowly enough that `totalTimeoutMs` fires before completion      | `MultipartTotalTimeoutError` rejection. Source destroyed.                                                                          |
| Caller-provided `AbortSignal` fires mid-stream                                   | `MultipartAbortError` rejection. Source destroyed. Any in-flight part body emits no further data.                                  |
| Caller-provided `AbortSignal` is already aborted at call time                    | Synchronous `MultipartAbortError`. `fetch` is never called.                                                                        |
| Two termination signals race (e.g., abort during idle timeout firing)            | First-to-fire wins; other listeners are removed; cleanup is idempotent.                                                            |
| Dicer emits `'error'` AFTER generator's `finally` ran                            | Logger.warn observes; no uncaught exception. The `'error'` listener stays attached for this exact reason.                          |
| Parser callback throws on a part                                                 | The throw propagates out of `fetchAndHandleMultipart`; cleanup runs; source destroyed.                                             |
| Parser callback returns `undefined`                                              | Part contributes nothing to `result.parts`; iteration continues.                                                                   |
| Part has zero-byte body                                                          | Yielded with `headers` and an immediately-ended `body`. `streamToBuffer(body)` resolves to a 0-length Buffer.                      |
| Part has no `Content-ID` header                                                  | `headers['content-id']` is `undefined`. Caller's parser handles.                                                                   |
| Part header name has unusual capitalization                                      | Headers are lowercased in `StreamingMultipartPart.headers` (consistent with Node `http`).                                          |
| `flattenHeaderValue` receives `undefined` / `string[]` / nested array            | Returns `undefined` / first string / first nested string. Pure function, must be exhaustive.                                       |
| `sanitizeFileName` receives a path-traversal attempt (`../etc/passwd`)           | Returns `_._etc_passwd` (or similar). No directory separators, no leading dots, no chars outside `[A-Za-z0-9._-]`. Capped at 255.  |
| `fetchAndHandleMultipart` gets a 200 with `Content-Type: application/json`       | Reject with `Error('multipart: response Content-Type is not multipart/related; got application/json')` before dicer is constructed. |
| Source ends mid-stream without closing boundary (server hangup)                  | Reject with `MultipartTruncatedError`. Cleanup per FR-010 runs.                                                                    |
| Web `ReadableStream` input where `fromWeb` produces an already-erroring readable | Error propagates as a normal source error; cleanup runs.                                                                           |
| Caller passes `idleTimeoutMs: 0`                                                 | Reject synchronously: `idleTimeoutMs must be a positive integer`. Same for `totalTimeoutMs: 0`.                                    |
| Caller passes `idleTimeoutMs: NaN` or non-finite                                 | Reject synchronously with a clear validation error.                                                                                |
| Caller passes `idleTimeoutMs` or `totalTimeoutMs` greater than `2^31 - 1`        | Reject synchronously with a validation error explaining `setTimeout` clamps to 1 ms above this bound (NFR-DR-S-009).               |
| Part body exceeds configured `maxPartBytes`                                      | Iterator rejects with `MultipartPartTooLargeError`; part body destroyed; cleanup per FR-010 runs (NFR-DR-S-001).                   |
| Single part has > `maxHeadersPerPart` headers OR header block > `maxHeaderBytesPerPart` | Iterator rejects with `MultipartHeadersTooLargeError`; cleanup per FR-010 runs (NFR-DR-S-004).                              |
| Envelope contains > `maxParts` parts                                             | Iterator rejects with `MultipartTooManyPartsError`; cleanup per FR-010 runs (NFR-DR-S-012).                                        |
| `streamToString` / `streamToBuffer` exceeds `maxBytes`                           | Reject with a clear error; source destroyed (NFR-DR-S-002).                                                                        |
| `sanitizeFileName('CON')` / `sanitizeFileName('aux.txt')` / `sanitizeFileName('..')` | Returns `'_'` (Windows reserved device name or pure-dot result mapped to fallback per NFR-DR-S-005).                           |
| `sanitizeFileName('...')` produces empty after leading-dot strip                 | Returns `'_'` (no empty results — NFR-DR-S-005).                                                                                   |
| Error message would embed an attacker-controlled `Content-Type` with control chars / ANSI escapes / multi-MB length | Embedded value is JSON-stringified, control chars replaced with `[redacted-control]`, truncated to 120 chars (NFR-DR-S-006). |
| Caller calls `iter.next()` twice without awaiting the first                      | Undefined behavior; not supported. The library MAY but is not required to detect and reject the concurrent call. (See Assumptions.) |
| Internal idle/total timer wins the abort race                                    | Operation rejects with `MultipartIdleTimeoutError` or `MultipartTotalTimeoutError` (NOT `MultipartAbortError`). `MultipartAbortError.reason` is reserved for caller-supplied signal reasons; the library MUST NOT synthesize a reason embedding the request URL, response headers, or server-derived bytes (F-S-006). |
| `extractBoundary` receives a 64 KiB pathological `Content-Type` with adversarial backslash/quote sequences | Completes in `< 50 ms` (NFR-DR-S-011); does not stall the event loop.                                                |

## Out of Scope

- ~~`multipart/form-data` request-side parsing~~ — different problem; covered by `@hapi/pez`, `@fastify/multipart`.
- ~~Multipart streaming UPLOADS~~ — this library only consumes responses.
- ~~Custom parser combinators or content-type registries~~ — caller uses the existing `PartParser<T>` callback.
- ~~Web-streams-only mode~~ — we accept `Response` (Web stream → Node Readable internally) and Node `Readable` directly. No "everything is Web Streams" rewrite.
- ~~React/UI components for progress bars~~ — out of library scope; caller drives UI from `onProgress`.
- ~~Built-in retry-on-network-error logic~~ — caller wraps `fetchAndHandleMultipart` with their own retry policy.
- ~~DICOM-specific parsers / `xml2js` / `.dcm` filename defaulting~~ — domain-specific; stays in the portal-ecia codebase.
- ~~Browser support~~ — uses `node:stream`; browser polyfilling is not promised. ESM/CJS dual-emit is for Node module-format compatibility, not browser.
- ~~Submodule exports~~ — single entry only. No `@ubercode/multipart-stream/utils` or similar — keeps publish surface tiny.
- ~~Dicer fork / replacement~~ — keep `dicer@0.3.1`. If dicer breaks in the future, we'll fork-and-absorb then; out of v1 scope.
- ~~GitHub Actions CI/CD pipeline (`.github/workflows/ci.yml`, `publish.yml`, npm `provenance: true`)~~ — Deferred (F-D-006). v1 enforces quality gates locally via `pnpm check`; CI/CD is operational polish and can be added before public release without spec changes.
- ~~`CHANGELOG.md` + automated release tooling (release-please, changesets)~~ — Deferred (F-D-005). Hand-edit a CHANGELOG before first publish; "what counts as breaking" rubric is operational policy, not spec scope for v1.
- ~~`SECURITY.md` (vulnerability-disclosure policy)~~ — Deferred (F-D-014). Stage the file at first publish; content is templated GitHub default and does not affect the library's runtime contract.
- ~~`DEPENDENCIES.md` / formal dicer EOL trigger policy / npm-audit CI gate / dicer-CVE patch SLA~~ — Deferred (F-D-012, F-S-008). The "fork-and-absorb if dicer breaks" plan stays informal for v1; codify operationally before v1.0 if/when a real CVE is filed.
- ~~Tree-shake validation test (`import { extractBoundary }` produces a bundle with no `dicer`)~~ — Deferred (F-D-011). `sideEffects: false` is asserted in `package.json`; an empirical bundler test is post-v1 polish.
- ~~`package.json#keywords` enforcement and `attw` dual-emit `package.json` shape audit~~ — Deferred (F-D-009, F-D-013) — these are publish-config nits resolved at first publish; not spec-level requirements (NFR-DR-D-015 already covers `attw` correctness).
- ~~`fetchAndHandleMultipart` warning when `fetchInit.headers` carries `Authorization`/`Cookie` without an explicit `redirect` setting~~ — Deferred (F-S-010). Cross-origin redirect-credential preservation is `fetch` semantics; caller's responsibility. Document in README's `Compatibility` / `Security` notes if relevant.

## Assumptions

- Callers consume from real `fetch` responses or already have a Node `Readable` from another source.
- `dicer@0.3.1` works correctly for `multipart/related` (validated by the reference impl in production).
- Node ≥ 20 means `Readable.fromWeb`, `AbortSignal.timeout`, `Buffer`, and `node:stream` are all available — no polyfills needed.
- Callers wanting structured logging (e.g., `pino`, `winston`) wrap with `{ warn: (m, meta) => myLogger.warn(meta, m) }` themselves; we do not depend on a logging library.
- Tests run on Node 20+ and use `vitest`.
- The published artifact is consumed by Node services; no bundler-specific concerns (no `"sideEffects"` per-file declarations beyond top-level `false`).
- The `AsyncGenerator` returned by `parseMultipartRelated` is consumed serially (one in-flight `next()` at a time, e.g., via `for await ... of`). Concurrent `next()` calls and restarting iteration after the generator has returned/thrown are NOT supported. The library MAY (but is not required to) detect and reject concurrent calls with a clear `Error`. (F-A-005.)
- Test suites and CI run on the package's `engines.node` floor (Node 20.18.0) and the current LTS major (Node 22.x). The CI matrix encoding itself is operational (out of scope for v1 spec); the requirement here is that local pre-publish testing exercises both. (F-A-006 partial.)

## Phase 2 CLARIFY — Coverage Summary

| Category               | Status                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Functional Scope       | Resolved (Q1: utility export surface — `extractBoundary` public, rest internal)                              |
| Domain/Data Model      | Clear (`StreamingMultipartPart`, `PartParser<T>`, `MultipartFetchResult<T>` defined; no entity ambiguity)    |
| Interaction/UX Flow    | N/A — library API surface only; ergonomics encoded as user stories                                           |
| Non-Functional Quality | Clear (NFR-001..NFR-012; coverage 90% branch + listener-leak assertions)                                     |
| Integration/Dependencies | Resolved (Q4: `dicer` pinned exact `0.3.1`; no other runtime deps)                                         |
| Edge Cases             | Resolved (Q2: fail-fast on non-multipart Content-Type → FR-021; Q3: truncated response → FR-022, MultipartTruncatedError) |
| Constraints/Tradeoffs  | Clear (Node 20+, no browser, no submodule exports, dicer is the parser)                                      |
| Terminology            | Clear ("battle-tested" operationalized as NFR-006/NFR-007: leak hygiene, fault injection, ≥90% branch)       |
| Completion Signals     | Clear (publish-surface NFR-008, `pnpm check` NFR-009, `pnpm pack --dry-run` NFR-008, full JSDoc FR-020)      |
| Security/Privacy       | Resolved (Q5: `sanitizeFileName` rule → FR-023). No authn/authz — library has no runtime data; transport security is caller's concern. |
| Misc Placeholders      | Clean — no `[TBD]` markers remain                                                                             |

## Domain Review Applied

Phase 5 ran three adversarial personas (Architect, Security/OWASP, Library Domain Expert) against the spec. Total findings: **35** (Architect 8 + Security 12 + Domain 15). After de-duplication, convergent findings collapsed to single resolutions. Severity totals: 4 Critical, 7 High, 16 Medium, 6 Low (counts include duplicates collapsed below).

### Convergent findings (one resolution citing both reviewers)

| Convergent ID | Reviewers           | Resolution                                          |
| ------------- | ------------------- | --------------------------------------------------- |
| dicer types   | F-A-002 + F-D-003   | Single FR `FR-DR-A-027` (ambient shim at `src/internal/dicer.d.ts`). |
| Node engines floor | F-A-006 + F-D-008 | Single NFR `NFR-DR-A-014` (`>=20.18.0`).         |

### Auto-applied findings (Action Rules 1–3)

| Finding ID            | Persona  | Sev      | Resolution                                                                                                              | Spec change                                                          |
| --------------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| F-A-001               | Arch     | Critical | Idle reset is per-chunk in Layer A; clarified FR-007; added `FR-DR-A-025`, `FR-DR-A-026`.                              | FR-007 text amended; two new FRs in FR table.                       |
| F-A-002 + F-D-003     | Arch+Dom | Crit/High | Hand-written ambient dicer shim, no `@types/dicer`. NFR-001 clarified to include implicit-any from imports.            | `FR-DR-A-027` in FR table; `NFR-DR-A-013` includes implicit-any rule. |
| F-A-003               | Arch     | High     | Defensive default-export normalization for `dicer`; CJS+ESM consumer test required.                                    | `FR-DR-A-028` in FR table.                                          |
| F-A-005               | Arch     | Medium   | Generator concurrency contract documented as Assumption (single in-flight `next()`).                                   | New row in Assumptions.                                             |
| F-A-006 + F-D-008     | Arch+Dom | Medium   | `engines.node` tightened to `">=20.18.0"`. CI matrix mention moved to Assumptions.                                     | `NFR-DR-A-014`; Assumptions row.                                    |
| F-A-008               | Arch     | Medium   | Public option-bag inputs must use `field?: T \| undefined`. Internal types unchanged.                                  | `NFR-DR-A-013`.                                                     |
| F-D-001               | Domain   | Critical | LICENSE file mandated before first publish.                                                                            | `FR-DR-D-001`.                                                      |
| F-D-002               | Domain   | Critical | README H2-section checklist (`Install`/`Quickstart`/`API`/`Error handling`/`Compatibility`/`License`).                | `NFR-DR-D-002`.                                                     |
| F-D-004               | Domain   | High     | `package.json#repository.url` and `bugs.url` mandated before first publish.                                            | `FR-DR-D-004`.                                                      |
| F-D-007               | Domain   | High     | Dual-emit `instanceof` limitation documented; `err.name` fallback documented in README.                                | `NFR-DR-D-007`.                                                     |
| F-D-010               | Domain   | Medium   | `verbatimModuleSyntax: true` mandated.                                                                                  | `NFR-DR-D-010`.                                                     |
| F-D-015               | Domain   | Medium   | `attw` gate added (CI or local pre-publish).                                                                            | `NFR-DR-D-015`.                                                     |
| F-S-001               | Security | High     | `maxPartBytes` cap + `streamToString`/`streamToBuffer` `maxBytes` cap; new `MultipartPartTooLargeError`.               | `NFR-DR-S-001`, `NFR-DR-S-002`; edge-case rows added.               |
| F-S-003               | Security | High     | Per-part header count + bytes caps; new `MultipartHeadersTooLargeError`.                                                | `NFR-DR-S-004`; edge-case row added.                                |
| F-S-004               | Security | Medium   | `sanitizeFileName` empty/Windows-reserved/dot-results map to `'_'`.                                                     | `NFR-DR-S-005`; edge-case rows added.                               |
| F-S-005               | Security | Medium   | Error-message embedded value sanitization (truncate, control-char redact, JSON.stringify).                              | `NFR-DR-S-006`; edge-case row added.                                |
| F-S-006               | Security | Low      | `MultipartAbortError.reason` contract: caller-signal reason verbatim or `undefined`; library never synthesizes server-derived bytes. | Edge-case row.                                              |
| F-S-007               | Security | Medium   | `logger.warn` meta sanitization (`errSummary` summary fields, no raw chunk bytes).                                      | `NFR-DR-S-008`. Respects `kiln/standards/error-handling.md` no-silent-catch rule by still logging via the configurable logger. |
| F-S-009               | Security | Low      | `validatePositiveTimeout` rejects values > `2^31 - 1`.                                                                  | `NFR-DR-S-009`; edge-case row.                                      |
| F-S-011               | Security | Medium   | `extractBoundary` non-backtracking; 64 KiB pathological completes < 50 ms.                                              | `NFR-DR-S-011`; edge-case row.                                      |
| F-S-012               | Security | Medium   | `maxParts` cap (default `10_000`); new `MultipartTooManyPartsError`.                                                    | `NFR-DR-S-012`; edge-case row.                                      |

### Deferred to Out of Scope (Action Rule 4)

| Finding ID | Why deferred                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| F-D-005    | CHANGELOG.md / release-please / changesets is operational policy; v1 hand-edits a CHANGELOG before first publish.    |
| F-D-006    | GitHub Actions CI/CD is post-Sprint-1 polish; v1 enforces quality gates locally via `pnpm check`.                    |
| F-D-009    | `package.json` "type":"module" + `main`:".cjs" shape audit — covered operationally by `NFR-DR-D-015` (`attw` gate).  |
| F-D-011    | `sideEffects: false` empirical tree-shake test — `package.json` claim is asserted; bundler validation is post-v1.    |
| F-D-012    | `DEPENDENCIES.md` / formal dicer-EOL trigger doc — informal "fork-and-absorb" plan stays for v1 (BRIEF aligned).     |
| F-D-013    | `package.json#keywords` discoverability — added at first publish; not a spec-level requirement.                      |
| F-D-014    | `SECURITY.md` — added at first publish; templated GitHub default does not affect runtime contract.                   |
| F-S-008    | Dicer CVE-monitor SLA + `npm audit` CI gate — operational policy; defers with F-D-006/F-D-012.                       |
| F-S-010    | `fetchInit.headers` cross-origin credential warning — `fetch` semantics; document in README, not as FR.              |

### Surfaced to operator (Action Rule 5 — judgment calls) — RESOLVED

| JC | Finding | Operator decision | Spec change |
| -- | ------- | ----------------- | ----------- |
| JC-1 | F-A-004 (`MultipartFetchResult.response` shape) | (a) Clean break — replace `response` with `status: number; headers: Headers`. | New `FR-DR-A-029`. |
| JC-2 | F-A-007 (`Logger` signature) | (c) Event-style `(event: { level, msg, meta? }) => void`. | FR-018 amended; US-009 amended. |
| JC-3 | F-S-002 (timeouts on `parseMultipartRelated`) | (a) Make both REQUIRED on `parseMultipartRelated` too — kills slow-loris when used server-side. | FR-006 amended; FR-006 now applies to both entry points. |

### Conflicts (Action Rule 6)

None. The two convergent findings on Node engines floor (F-A-006 vs F-D-008) recommend slightly different floors (`>=20.10.0` vs `>=20.18.0`); this is a graded recommendation, not a contradiction. Resolved by adopting the more conservative `>=20.18.0` (last Node 20 LTS as of early 2026).

## Domain Review

Phase 5 complete. See `## Domain Review Applied` above. Persona findings preserved at `kiln/spec/review-architect.md`, `kiln/spec/review-security.md`, `kiln/spec/review-domain.md`.
