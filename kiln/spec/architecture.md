# Architecture — `@ubercode/multipart-stream`

## 1. What this is

A Node TypeScript library with **one** runtime dependency (`dicer@0.3.1`, exact pin) and **zero** dev-side framework code. It is consumed via `import`/`require` from a backend service. There is no UI, no DB, no server. The publish surface is one `dist/index.{js,cjs,d.ts}` triple.

**Engines floor.** Per NFR-DR-A-014, `package.json#engines.node` is `">=20.18.0"` (the last Node 20 LTS release with stabilized `Readable.fromWeb` backpressure fixes as of 2026). This is intentionally tighter than a vague `">=20"`: the library exercises `Readable.fromWeb`, `AbortSignal.timeout`, and modern `node:stream` semantics on every code path, and reproducibility matters more than a slightly wider compat window. Bumping this floor in the future is a major-version bump.

## 2. Module layout

```
multipart-stream/
├── src/
│   ├── index.ts                              # ONLY public re-exports. No logic.
│   ├── types.ts                              # Public type aliases & interfaces.
│   ├── errors.ts                             # 4 public error classes.
│   ├── extract-boundary.ts                   # Public utility (FR-016).
│   ├── stream-helpers.ts                     # streamToString, streamToBuffer.
│   ├── parse-multipart-related.ts            # Layer A: parser/dicer adapter.
│   ├── fetch-and-handle-multipart.ts         # Layer B: fetch orchestration.
│   └── internal/                             # Layer C: internal utilities.
│       ├── dicer.d.ts                        # FR-DR-A-027: hand-written ambient shim.
│       ├── flatten-headers.ts
│       ├── sanitize-filename.ts
│       ├── derive-name.ts
│       ├── queue-notifier.ts
│       ├── timers.ts
│       ├── normalize-input.ts
│       ├── validate-timeout.ts
│       ├── format-error-embed.ts             # NFR-DR-S-006: sanitize attacker bytes.
│       └── default-logger.ts
├── tests/
│   ├── unit/                                 # Pure-function unit tests.
│   │   ├── extract-boundary.test.ts
│   │   ├── flatten-headers.test.ts
│   │   ├── sanitize-filename.test.ts
│   │   ├── stream-helpers.test.ts
│   │   ├── errors.test.ts
│   │   └── validate-timeout.test.ts
│   ├── integration/                          # vitest + real Readable.from + http.
│   │   ├── parse-multipart-related.test.ts
│   │   ├── parse-cleanup.test.ts             # listener-leak + part-stream-leak.
│   │   ├── parse-timeouts.test.ts
│   │   ├── parse-truncation.test.ts
│   │   ├── fetch-and-handle.test.ts
│   │   └── fetch-content-type-validation.test.ts
│   └── fixtures/
│       └── multipart-builders.ts             # Helpers to construct envelopes.
├── kiln/spec/                                     # Spec, design docs, test plan.
├── kiln/standards/                                # Inherited kiln standards.
└── README.md
```

The `src/internal/` boundary is enforced two ways:

1. **Convention.** `src/index.ts` only re-exports from `src/*.ts`, never from `src/internal/`.
2. **CI gate.** A `pnpm pack --dry-run` smoke test (NFR-008) parses the emitted `dist/index.d.ts` and asserts that no internal symbol name appears in it.

## 3. Three-layer separation

The library has exactly three layers; each layer's source files live at the path indicated above.

```
┌────────────────────────────────────────────────────────────────────┐
│  Layer B: fetch orchestration                                      │
│  src/fetch-and-handle-multipart.ts                                 │
│  - Validates options (parser, timeouts, fetchInit.signal forbidden).│
│  - Calls fetch(); validates response Content-Type (FR-021).        │
│  - Captures status + headers from the Response BEFORE consuming    │
│    body (FR-DR-A-029).                                             │
│  - Forwards idleTimeoutMs / totalTimeoutMs / signal / resource     │
│    caps DOWN to parseMultipartRelated; does NOT own timers itself  │
│    (FR-DR-A-026). Timer ownership lives in Layer A for both entry  │
│    points, so parsing-from-Readable-on-server-side and parsing-    │
│    from-Response share the same hang-protection mechanism.         │
│  - Drives the for-await loop, accumulates parts via parser.        │
│  - Owns the wallclock for elapsedMs/bytes result.                  │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ uses
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Layer A: parser/dicer adapter                                     │
│  src/parse-multipart-related.ts                                    │
│  - Validates input shape (Response | Readable + boundary).         │
│  - Validates required timeouts via validatePositiveTimeout         │
│    (FR-006 / JC-3 — required on this entry point too, NFR-DR-S-009).│
│  - Constructs Dicer({ boundary }) using the FR-DR-A-028 import-    │
│    normalization shape (`const Dicer = dicerMod.default ?? dicerMod`).│
│  - Wires queue-notifier bridge (internal/queue-notifier.ts).       │
│  - Owns the idle timer (FR-DR-A-025): the per-chunk source 'data'  │
│    listener calls timers.resetIdle(). onProgress is NOT used as    │
│    an idle-reset hook (it's per-part, too coarse).                 │
│  - Enforces resource caps: maxPartBytes, maxParts, maxHeadersPerPart,│
│    maxHeaderBytesPerPart (NFR-DR-S-001/004/012).                   │
│  - Attaches all listeners BEFORE pipe() (FR-012).                  │
│  - Yields parts; on finally, drains queue, removes listeners,      │
│    keeps dicer.error listener (FR-010, FR-011).                    │
│  - Detects truncation: if dicer 'finish' has not fired but src     │
│    'end' has, push MultipartTruncatedError before END.             │
└────────────────────────────────┬───────────────────────────────────┘
                                 │ uses
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Layer C: internal utilities (pure where possible)                 │
│  src/internal/                                                     │
│  - flatten-headers.ts:    Buffer/array → string                    │
│  - sanitize-filename.ts:  FR-023 path-safe rule                    │
│  - derive-name.ts:        Content-ID → filename hint               │
│  - queue-notifier.ts:     The push/wait bridge                     │
│  - timers.ts:             setupTimers(...) → TimerState            │
│  - normalize-input.ts:    Response | Readable → ParseInput         │
│  - validate-timeout.ts:   Centralized FR-007/FR-008 validation     │
│  - default-logger.ts:     console.warn-backed default Logger       │
└────────────────────────────────────────────────────────────────────┘
```

**Forbidden imports:**
- Layer A MUST NOT import from Layer B. (Reverse only.)
- Layer C MUST NOT import from Layer A or B.
- `src/internal/*` MUST NOT import from anywhere outside `src/internal/` and `src/types.ts`/`src/errors.ts`.

**Allowed imports:**
- Layer B → Layer A, Layer C, types, errors.
- Layer A → Layer C, types, errors.
- Layer C → types, errors. Pure where possible (no I/O in `flatten-headers`, `sanitize-filename`, `derive-name`, `validate-timeout`, `extract-boundary`).

## 4. Data flow

### 4.1 `parseMultipartRelated(res)` happy path

```
Caller
  │
  │ for await (const part of parseMultipartRelated(res))
  ▼
┌────────────────────────────────────┐
│ parse-multipart-related.ts         │
│ 1. normalizeInput(res) → ParseInput│
│ 2. extractBoundary(ct)             │       Layer C
│ 3. Readable.fromWeb(res.body)─────────────────────────► node:stream
│ 4. dicer = new Dicer({ boundary }) │
│ 5. queue = makeQueueNotifier()     │
│ 6. attach listeners (data, abort,  │
│    'part', 'finish', 'error')      │  ← FR-012: BEFORE pipe()
│ 7. src.pipe(dicer)                 │
│ 8. loop: yield queue.next()        │
│    until END / Error               │
│ 9. finally: cleanup()              │  ← FR-010, FR-011
└────────────────────────────────────┘
```

### 4.2 `fetchAndHandleMultipart` happy path

```
Caller
  │
  │ await fetchAndHandleMultipart(url, opts)
  ▼
┌────────────────────────────────────┐
│ fetch-and-handle-multipart.ts      │
│ 1. validate opts (timeouts, parser,│
│    fetchInit.signal forbidden —    │
│    FR-024).                        │
│ 2. fetch(url, {                    │
│      ...opts.fetchInit,            │
│      signal: opts.signal,          │
│    })                              │  (caller signal forwarded raw;
│                                    │   timers live in Layer A — see
│                                    │   FR-DR-A-026.)
│ 3. assertContentType(res)          │  ← FR-021 (formatErrorEmbed
│                                    │     sanitizes embedded bytes —
│                                    │     NFR-DR-S-006).
│ 4. capture status + headers        │  ← FR-DR-A-029
│ 5. for await (part of              │
│      parseMultipartRelated(res, {  │
│        idleTimeoutMs,              │
│        totalTimeoutMs,             │  ← Layer A owns the timers
│        signal: opts.signal,        │     (FR-DR-A-025/026).
│        onProgress: opts.onProgress,│  ← onProgress is INFORMATIONAL
│        maxPartBytes, maxParts,     │     ONLY — does NOT drive idle
│        maxHeadersPerPart,          │     reset (per-chunk listener
│        maxHeaderBytesPerPart,      │     in Layer A handles that).
│        logger: opts.logger,        │
│      })                            │
│    ) {                             │
│      const v = await opts.parser(part);  ← FR-014
│      if (v !== undefined) parts.push(v); │
│    }                               │
│ 6. return { parts, bytes,          │
│             elapsedMs, status,     │  ← FR-DR-A-029: no `response`.
│             headers }              │
└────────────────────────────────────┘
```

### 4.3 Termination paths (FR-010, FR-011)

Six ways for an operation to end. All five non-success paths land in the same `finally` block — cleanup is **idempotent** and **first-fire-wins**.

| Trigger source                | Initiator                                         | Error surfaced            | Cleanup runs |
| ----------------------------- | ------------------------------------------------- | ------------------------- | ------------ |
| Source `'end'` + dicer `'finish'` | dicer                                         | (none — success)          | yes          |
| Source `'end'` w/o dicer `'finish'` | parse-multipart-related on END dispatch     | `MultipartTruncatedError` | yes          |
| Idle timer fires              | `internal/timers.ts`                              | `MultipartIdleTimeoutError` | yes        |
| Total timer fires             | `internal/timers.ts`                              | `MultipartTotalTimeoutError` | yes       |
| Caller signal aborts          | `internal/timers.ts` (forwards to combined sig)   | `MultipartAbortError`     | yes          |
| Parser throws                 | `fetch-and-handle-multipart.ts`                   | (parser's error, propagated) | yes       |
| Caller `break`                | parse-multipart-related's `for await` consumer    | (none)                    | yes          |
| Source / dicer `'error'`      | dicer                                             | (the underlying error)    | yes          |

### 4.4 Late-emit error path (FR-011)

```
[generator's finally has run; dicer.removeAllListeners('part') called]
[dicer.removeAllListeners('error') NOT called — listener stays]
                  │
                  ▼
dicer emits 'error' on next tick (e.g. unexpected internal finish)
                  │
                  ▼
the lingering 'error' listener fires; library calls
  logger({ level: 'warn',
           msg: 'multipart: late parser error after generator close',
           meta: { errSummary: { name, message } } })   ← NFR-DR-S-008
                  │
                  ▼
no uncaught exception escapes
```

This is the single most expensive bug in the reference impl to verify. The test plan dedicates `T-021` to it.

## 5. Key decisions and rationale

### 5.1 Why dicer (and why pin to `0.3.1`)

| Option                          | Pros                                  | Cons                                                              |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `dicer@0.3.1`                   | Works in production today; small      | Last published 2021-12; unmaintained                              |
| `@mjackson/multipart-parser`    | Modern API                            | Repository archived 2025-10-07                                    |
| Roll our own MIME parser        | Full control; no dependency           | New code = new bugs; out of v1 scope                              |
| `multitars`                     | Modern, alive                         | Pre-release canary; `multipart/related` scope unclear             |

**Decision:** Keep dicer. Pin to exactly `0.3.1` (no caret, no tilde — `dependencies.dicer = "0.3.1"`) for two reasons:

1. **Reproducibility.** An unmaintained dep that floats is a future regression risk for nobody's benefit.
2. **Fork-and-absorb plan.** If dicer breaks under a future Node release, we copy the source into `src/internal/dicer/` and treat it as our own. The library's own surface area (the queue-notifier bridge, timer machinery, error classes) is what carries the value-prop, not dicer itself.

(Captured in NFR-004.)

### 5.2 Why custom error classes (vs. tagged objects, vs. `Error` w/ `code`)

| Option                | Pros                                          | Cons                                                       |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| `class …Error`        | `instanceof` is the natural JS pattern; survives serialization for logging; readable in DevTools stack traces | Slight bundle-size cost (~150 bytes per class); requires `instanceof` to discriminate |
| Tagged object `{ kind: 'idle-timeout', … }` | Smaller; cleanly serializable | Ergonomically awkward (`if (err.kind === …)` instead of `instanceof`); throwing requires wrapping in `Error` anyway |
| `Error` with `code` string | Familiar from `node:errors`              | Brittle: typo'd `code` checks, no static type narrowing    |

**Decision:** Custom classes. Spec calls for `instanceof`-discrimination directly (US-010, FR-019, NFR-012). The runtime cost is negligible against the readability win.

### 5.3 Why drain-on-finally

Reference impl comment lines 198–207 explain it: dicer's per-part `Readable`s hold buffered chunks and are not GC-eligible until destroyed. If the consumer `break`s, those streams are still live in the queue. The leak is silent (no listener-count change, no warning) but real — under load it surfaces as RSS climbing and eventual OOM.

The fix is unconditional `for (const item of queue) if (isPart(item)) item.body.destroy()` in the iterator's `finally`. Cost: `O(pending parts)` synchronous calls, negligible.

(Captured in FR-010, US-007, T-014.)

### 5.4 Why pre-pipe listener wiring

If listeners are attached AFTER `src.pipe(dicer)`, a synchronous `'error'` from dicer (e.g. malformed boundary at the first byte) is emitted before the listener is attached and becomes an unhandled `'error'` event — Node terminates the process. The reference impl gets this right; the fix has to survive every refactor.

(Captured in FR-012, US-011, T-022.)

### 5.5 Why `Readable.fromWeb` and not "everything is Web Streams"

| Option                    | Pros                                               | Cons                                                       |
| ------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Convert at boundary       | dicer is a Node `Writable`; conversion is local    | One conversion point; well-known type assertion needed     |
| Web Streams everywhere    | Forward-looking                                    | dicer doesn't speak Web Streams; need an adapter layer; doubles surface area |
| Two parallel APIs         | Both worlds covered                                | Twice the test load; twice the doc; KISS violation         |

**Decision:** Convert at the boundary. The cast `Readable.fromWeb(res.body as ReadableStream<Uint8Array>)` (NOT `as never`) is correct per the `node:stream` typings; we add a one-line comment justifying the cast. (NFR-001 explicitly forbids `as never`.)

### 5.6 Why no submodule exports

`@ubercode/multipart-stream/utils`, `…/errors`, etc., would force us to maintain N publish surfaces, write `package.json#exports` for each, and answer "do these export the same instance of `MultipartAbortError` or different ones?" (instanceof breakage when consumed via different specifiers). For 8 public symbols, one entry point is correct. (Captured in spec Out of Scope.)

### 5.7 Why no built-in retry

Retry policies are caller-specific:

- "Retry on network error but not on 4xx" (HTTP semantic).
- "Retry on truncation but not on parser error" (this library's semantic).
- "Retry up to 3 times with exponential backoff and jitter, except if the operation has already produced any results" (very domain-specific).

The library exposes the discriminable error classes; callers wrap. `p-retry`, `async-retry`, hand-rolled — all work. Adding retry would force a `RetryStrategy` interface and a `retry: { attempts, backoff, shouldRetry }` option that few callers would use as we wrote it. (Captured in spec Out of Scope.)

### 5.8 Why required timeouts on BOTH `fetchAndHandleMultipart` AND `parseMultipartRelated` (JC-3)

FR-006 (post-domain-review, JC-3): timeouts have no defaults on EITHER entry point. Both `fetchAndHandleMultipart` and `parseMultipartRelated` require `idleTimeoutMs` and `totalTimeoutMs`.

The original Phase 6 plan made timeouts optional on `parseMultipartRelated` ("low-level callers know what they're doing"). The Phase 5 Security review (F-S-002) demonstrated that this leaves a slow-loris attack surface when a server uses `parseMultipartRelated` directly on `req.body`: an attacker who trickles bytes one-per-many-seconds can hold a connection open indefinitely. Making timeouts required on both entries closes the vector at the type system, with no escape hatch — exactly the "battle-tested means deliberate" discipline the operator has called for from day one.

The implementation cost is: `validatePositiveTimeout` (already centralized in Layer C) is invoked unconditionally at the top of `parseMultipartRelated`, throwing `TypeError` if either timeout is missing. The `MultipartHandlerOptions<T>` interface unchanged (timeouts were already required there).

### 5.9 Why `extractBoundary` is the only public utility

FR-016. The other utilities (`flattenDicerHeaders`, `flattenHeaderValue`, `sanitizeFileName`, `deriveNameFromContentId`) are tightly coupled to dicer's internal data shape and to a specific naming convention. Exporting them creates an obligation to never break their signatures, and they are not useful outside the multipart-parsing context.

`extractBoundary`, by contrast, is a pure RFC-2046 parser useful in many adjacent contexts (e.g. when a caller has a `Content-Type` string but is using a different downstream parser). Public, documented, stable.

### 5.10 Why `Logger` is event-style `(event) => void` (JC-2)

The library only ever calls the logger to emit warnings (late-emit errors, listener-attach quirks, `unpipe` failures, `onProgress` throws). The original `{ warn(msg, meta) }` method-bag shape worked but inverts the dominant structured-logger ordering (`pino`/`bunyan` use `(meta, msg)`), forcing callers into wrapper boilerplate.

The event-style shape — `(event: { level: 'warn'; msg: string; meta?: unknown }) => void` — fixes three things at once:

1. **Forward-compatibility.** Adding `'info'` or `'error'` levels later is a non-breaking widening of the `level` union, not a new method.
2. **Adapter ergonomics.** `(event) => log[event.level](event.meta, event.msg)` is one line for any structured logger.
3. **Explicit metadata contract.** The `meta` payload is always a single value, easy to inspect and easy to constrain via NFR-DR-S-008's `errSummary` rule.

Default fallback: `console.warn(msg, meta)` (positional, matching console's signature) when `logger` is omitted.

### 5.11 Why `MultipartFetchResult.errors` was removed

Reference impl: `errors: Error[]` and `hadError: boolean` were a soft-fail pattern that violates `kiln/standards/error-handling.md`. The standard requires errors to either re-throw, return a Result error, or structured-log + propagate. The new shape rejects the promise on any error; the result struct is success-only. Callers who want soft-fail wrap in their own try/catch.

### 5.12 Why drop `name` from `StreamingMultipartPart`

`name` was a DICOM-specific helper (defaulting `.dcm` extension). Per BRIEF "OUT of scope," DICOM-specific filename conventions stay in portal-ecia. Callers who want a filename derive it from `contentId` themselves (or use the internal `deriveNameFromContentId` if a future feature surfaces it intentionally).

### 5.13 Why an ambient dicer shim instead of `@types/dicer`

`@types/dicer` does not exist on npm; community-published shims exist but are stale. Per FR-DR-A-027, the library ships a hand-written `src/internal/dicer.d.ts` that types only the surface actually used (default-export `Dicer` constructor, `'part'`/`'finish'`/`'error'`/`'header'` events, per-part `Readable` shape with raw header bag).

This single decision avoids three problems: (1) implicit-`any` from `import Dicer from 'dicer'` against a typeless package (NFR-001 forbids implicit `any` from imports — clarified in NFR-DR-A-013); (2) a runtime dependency on `@types/dicer` floating across consumers; (3) leakage of `dicer` types into the published `dist/index.d.ts` (a test asserts the absence of `from 'dicer'` in the published types — see test-plan.md `T-073`).

### 5.14 Why default-export normalization for the dicer import (FR-DR-A-028)

`dicer` is a CJS package whose `module.exports` is the constructor. Under ESM (`dist/index.js`) Node wraps that as `{ default: Dicer }`; under CJS (`dist/index.cjs`) the import is the raw constructor. The portable shape is:

```ts
import dicerMod from 'dicer';
const Dicer = (dicerMod as { default?: typeof DicerType }).default ?? dicerMod;
```

This is typed (no `as any`), works correctly under both ESM (`new Dicer({ boundary })`) and CJS, and is asserted by a CJS-consumer child-process test (test-plan.md `T-074`). The same normalization shape is referenced in the ambient shim's `export default Dicer; export = Dicer;` declaration (data-model.md §2.12).

### 5.15 Embedded-value sanitization in error messages (NFR-DR-S-006)

Several error sites embed attacker-controlled values into messages: FR-021's `Content-Type is not multipart/related; got <actual>`; `extractBoundary`'s `Content-Type: <header>` embeds. A naive concat is a log-injection vector — a malicious upstream could ship a `Content-Type` header full of CRLFs, ANSI escape sequences, or megabyte-long garbage that breaks downstream log aggregation.

The library funnels every such embed through an internal helper:

```ts
// src/internal/format-error-embed.ts
export function formatErrorEmbed(value: string): string;
```

Behavior:

1. Truncate to <= 120 chars (with `…` suffix if truncated).
2. Replace control characters (0x00–0x1F, 0x7F) and CSI/ANSI escape sequences with the literal token `[redacted-control]`.
3. `JSON.stringify` the result so embedded quotes are visible.

Test plan `T-075` covers the truncate / control-char redact / JSON.stringify path.

### 5.16 ReDoS-resistant `extractBoundary` (NFR-DR-S-011)

The reference implementation's regex for the `boundary=` parameter has an alternation between quoted-string and bare-token forms. A pathological input (megabytes of backslash-quote sequences) could trigger catastrophic backtracking under `RegExp` engines that allow it. Per NFR-DR-S-011, the production implementation is non-backtracking — either a possessive-quantifier-equivalent form or a hand-written tokenizer. The asserted bound is `< 50 ms` on a 64 KiB pathological input. Test plan `T-076` enforces this.

## 6. Build / publish architecture

| Concern                | Decision                                                                       |
| ---------------------- | ------------------------------------------------------------------------------ |
| Bundler                | `tsup` (zero-config, dual ESM+CJS+`.d.ts`, sourcemaps).                        |
| ESM entry              | `dist/index.js` (`"type": "module"` not set; we ship both formats explicitly). |
| CJS entry              | `dist/index.cjs`.                                                              |
| Types                  | `dist/index.d.ts` (one file; `tsup --dts`).                                    |
| `package.json#exports` | `"."` only — `{ "import": "./dist/index.js", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" }`. |
| `package.json#sideEffects` | `false` (NFR-002).                                                         |
| `package.json#engines` | `"node": ">=20.18.0"` (NFR-DR-A-014; tightened from NFR-003's `>=20` floor).   |
| Files in publish       | `dist/`, `README.md`, `LICENSE`, `package.json` (NFR-008).                     |

## 7. Observability strategy (replaces 3 silent catches in reference)

The reference's silent catches at lines 121, 192, 314 (per BRIEF) become:

| Reference site                                  | Replacement                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| L121: `try { onSourceBytes?.(n) } catch {}`     | `try { onSourceBytes?.(n) } catch (err) { logger({ level: 'warn', msg: 'multipart: onSourceBytes threw', meta: { errSummary: summarizeError(err) } }); }` |
| L192: `try { src.unpipe(dicer) } catch {}`     | `try { src.unpipe(dicer) } catch (err) { logger({ level: 'warn', msg: 'multipart: unpipe failed', meta: { errSummary: summarizeError(err) } }); }` |
| L314: `try { onProgress(snap) } catch {}`       | `try { onProgress(snap) } catch (err) { logger({ level: 'warn', msg: 'multipart: onProgress threw', meta: { errSummary: summarizeError(err) } }); }` |

(`summarizeError(err)` is the internal helper that returns `{ name: err.name, message: formatErrorEmbed(err.message) }` — see NFR-DR-S-006 / NFR-DR-S-008. The shape mirrors what `formatErrorEmbed` produces for raw header values: <= 120-char message with control bytes redacted.)

All three are: (a) caller-callback / cleanup paths that MUST NOT derail parsing, and (b) cases where re-throwing would cascade to "the caller's `for await` blew up because their progress callback threw" — bad UX. Logging is the right discipline.

NFR-005: zero silent catches anywhere. CI grep gate will enforce.

## 8. Testing architecture

(Full content in `kiln/spec/test-plan.md`.) Briefly:

- **Unit tests** in `tests/unit/` for pure functions (no I/O): `extractBoundary`, `flattenHeaderValue`, `flattenDicerHeaders`, `sanitizeFileName`, `validatePositiveTimeout`, error class properties.
- **Integration tests** in `tests/integration/` for parser/fetch behavior. These use real `Readable.from(buffer)` for input and a small in-process `node:http` server (`http.createServer`) for `fetchAndHandleMultipart` tests. **No mocked sources** where a real `Readable` works (per `kiln/standards/testing.md`).
- **Listener-leak harness** patches `Dicer.prototype.emit` (per existing reference test) to capture all part `Readable`s and dicer instances; assertions on `listenerCount` and `destroyed` flags after every termination path.
- **Fault-injection harness** for timeouts and abort uses `vi.useFakeTimers` and a `Readable` that emits a single byte then sits silent.

## 9. Out-of-band concerns

- **No telemetry / no metrics emission.** The library doesn't know your metrics pipeline. Callers wrap.
- **No request signing.** Caller passes `Authorization` etc. via `fetchInit.headers`.
- **No locale-sensitive output.** Error messages are English-only; we do not provide i18n.
- **No Web ReadableStream output mode.** Part bodies are always Node `Readable`. Callers who want Web Streams call `Readable.toWeb(part.body)` themselves (Node 20+, available).
