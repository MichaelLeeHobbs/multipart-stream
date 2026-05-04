# Test Plan — `@ubercode/multipart-stream`

This plan satisfies NFR-006 ("battle-tested") and NFR-007 (≥90% branch coverage). Every acceptance criterion in `kiln/spec/spec.md` and every functional requirement appears in the Coverage Map at least once.

## Conventions

- **Test framework:** `vitest`. NO Playwright (not a UI). NO Jest.
- **Test types:**
  - `Unit` — pure-function tests in `tests/unit/`. No I/O. Each <100 ms (per `kiln/standards/testing.md`).
  - `Integration` — multi-module tests in `tests/integration/`. Use real `Readable.from(buffer)` and an in-process `node:http` server. No mocked sources.
- **Test IDs:** `T-001` through `T-NNN`, sequential. Reused IDs in multiple tables (e.g., a Coverage Map row and a Negative/Edge row pointing at the same `T-014`) are intentional.
- **Listener-leak harness:** the helper `captureDicerActivity()` patches `Dicer.prototype.emit` to record every emitted part `Readable` and every Dicer instance; tests assert on `listenerCount('part')`, `listenerCount('error')`, and `destroyed` flags after every termination path.
- **Time control:** `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })` for timeout-class tests; `vi.advanceTimersByTimeAsync` to drive idle/total firings deterministically.
- **HTTP fixture:** `tests/fixtures/start-multipart-server.ts` exposes a function that starts an `http.createServer` returning a configurable `multipart/related` body (or a malformed one, or a hung connection) on `PORT`.
- **Multipart envelope builder:** `tests/fixtures/multipart-builders.ts` (mirrors the reference test's `buildMultipartBody` but parameterized for malformed cases — missing closing boundary, embedded CRLFs, quoted boundary, etc.).

---

## Coverage Map

Maps every acceptance criterion (and every FR/NFR with a testable surface) to at least one test.

| User Story / FR | Acceptance Criterion | Test ID | Test Type | Test Description |
|---|---|---|---|---|
| US-001 | GIVEN multipart/related Response WHEN parseMultipartRelated and for-await THEN receive each part as `{headers, body, index}` in order | T-001 | Integration | Build 3-part envelope; assert `parts.length === 3`, `parts[i].index === i`, headers-lowercased, bodies streamed in dicer-emit order |
| US-001 | GIVEN response body is null WHEN parseMultipartRelated THEN throws synchronously before iterator yields | T-002 | Integration | Construct mock-shape `{ headers: { get: () => 'multipart/related; boundary=x' }, body: null }`; assert `parseMultipartRelated(res).next()` rejects with `Error /response body is null/` |
| US-001 | GIVEN Content-Type missing boundary WHEN parseMultipartRelated THEN throws synchronously | T-003 | Integration | `new Response('', { headers: { 'content-type': 'multipart/related' } })`; assert `next()` rejects with `Error /boundary parameter missing/` |
| US-001 | GIVEN Web ReadableStream input WHEN parseMultipartRelated THEN library converts via Readable.fromWeb | T-004 | Integration | `new Response(buffer)` produces a Web ReadableStream body; assert iteration succeeds and yields all parts; assert no `as never` regression by exercising both array-like and stream-like body backings |
| US-001 | GIVEN Node Readable + explicit boundary option WHEN parseMultipartRelated THEN parsing proceeds without Content-Type | T-005 | Integration | `Readable.from(envelopeBuffer)` + `{ boundary: 'BOUNDARY' }`; assert all parts yielded |
| US-002 | GIVEN PartParser that returns parsed value for some parts and undefined for others WHEN fetchAndHandleMultipart runs THEN only kept parts contribute | T-006 | Integration | 3 parts; parser returns string for `content-id === '<meta>'` only; assert `result.parts.length === 1` and `result.parts[0]` is the parsed string; assert other 2 part bodies were drained (no listener leak via harness) |
| US-002 | GIVEN parser returns undefined for a part WHEN parsing completes THEN that part contributes nothing to result.parts | T-007 | Integration | parser always returns undefined; assert `result.parts.length === 0`, `result.bytes === envelope.length` |
| US-002 | GIVEN parser throws WHEN that part is processed THEN error propagates and source destroyed cleanly | T-008 | Integration | parser throws Error('boom') on part 2; assert `await rejects with Error('boom')`; assert `source.destroyed === true`; assert listener counts back to baseline; assert no late-emit error escapes |
| US-003 | GIVEN idleTimeoutMs:5000 WHEN no bytes for 5+ seconds THEN rejects with MultipartIdleTimeoutError, source destroyed | T-009 | Integration | http server writes envelope start then sleeps 6s; `idleTimeoutMs: 5000`; assert rejects with `MultipartIdleTimeoutError` whose `idleTimeoutMs === 5000`; assert source destroyed; fake-timers driven |
| US-003 | GIVEN bytes every 4s WHEN op runs 30s THEN does NOT idle-timeout (timer resets each chunk) | T-010 | Integration | http server writes one byte per 4s for 30s with `idleTimeoutMs: 5000, totalTimeoutMs: 60_000`; assert success |
| US-004 | GIVEN totalTimeoutMs:60_000 WHEN op exceeds 60s total THEN rejects with MultipartTotalTimeoutError even if bytes still arriving | T-011 | Integration | http server writes 1 byte/sec indefinitely with `totalTimeoutMs: 60_000`; advance fake timers 60_000ms; assert rejects with `MultipartTotalTimeoutError` whose `totalTimeoutMs === 60000` |
| US-005 | GIVEN signal:controller.signal and abort() mid-stream WHEN abort fires THEN rejects with MultipartAbortError, source destroyed, in-flight body emits no more data | T-012 | Integration | start streaming; abort after first part yielded; assert `await for-await rejects with MultipartAbortError`, `source.destroyed`, no further `'data'` events on the in-flight part body |
| US-005 | GIVEN AbortSignal already aborted at call time WHEN fetchAndHandleMultipart called THEN rejects synchronously with MultipartAbortError | T-013 | Integration | `ctrl.abort('user'); await fetchAndHandleMultipart(url, { signal: ctrl.signal, ... })`; assert rejects with `MultipartAbortError`; assert `fetch` was NEVER called (spy on global fetch) |
| US-006 | GIVEN onProgress callback WHEN bytes arrive THEN called with `{bytes, elapsedMs, rateBps}` ≥1× per yielded part and at completion | T-014 | Integration | 3-part envelope; spy `onProgress`; assert `calls.length >= 4` (3 parts + completion); assert each call's `bytes` is monotonic non-decreasing; assert each call has finite `rateBps` |
| US-007 | GIVEN break out of for-await after first part WHEN finally runs THEN every listener removed, dicer unpiped, source destroyed, no late 'error' escapes | T-015 | Integration | 5-part envelope; break after part 1; `await settle()`; assert `dicer.listenerCount('part') === 0`, `dicer.listenerCount('error') >= 1`, `source.destroyed`, no leaked part streams |
| US-007 | GIVEN dicer emits 'error' AFTER finally has run WHEN error fires THEN observed via logger never thrown | T-016 | Integration | break after part 1; manually emit `'error'` on dicer post-finally; assert no uncaught exception (via `process.on('uncaughtException')` spy); assert `mockLogger` (event-style fn) called once with `{ level: 'warn', msg: 'multipart: late parser error after generator close', meta: { errSummary: { name, message } } }` (NFR-DR-S-008: meta carries `errSummary` only — NO raw chunk bytes, no full Error object) |
| US-008 | GIVEN Readable of small text WHEN streamToString(readable, 'utf-8') THEN full string and readable consumed | T-017 | Unit | `Readable.from([Buffer.from('hello'), Buffer.from(' world')])`; assert resolves to `'hello world'`; assert `readable.readableEnded === true`. Variant T-017b: `streamToString(readable, 'utf8', { maxBytes: 5 })` against a 100-byte source → rejects with `Error /exceeded maxBytes/`, source `destroyed === true` (NFR-DR-S-002) |
| US-008 | GIVEN Readable of binary bytes WHEN streamToBuffer THEN full Buffer | T-018 | Unit | `Readable.from([Buffer.from([0,1,2]), Buffer.from([3,4,5])])`; assert resolves to `Buffer.from([0,1,2,3,4,5])`. Variant T-018b: `streamToBuffer(readable, { maxBytes: 3 })` against a 6-byte source → rejects with `Error /exceeded maxBytes/`, source `destroyed === true` (NFR-DR-S-002) |
| US-009 (JC-2) | GIVEN logger: event-style fn WHEN internal warning fires THEN it is called with `{level:'warn', msg, meta?}` | T-019 | Integration | inject `const mockLogger = vi.fn<[{level:'warn';msg:string;meta?:unknown}]>()`; force a late-emit error scenario (T-016 path); assert `mockLogger` called once with arg matching `{ level: 'warn', msg: /late parser error/, meta: expect.any(Object) }`; assert `mockLogger` called as a FUNCTION (not as a `.warn(...)` method) |
| US-009 | GIVEN logger omitted THEN warnings default to console.warn(msg, meta) | T-020 | Integration | `vi.spyOn(console, 'warn')`; force the same scenario without `logger`; assert `console.warn` called with `(msg: string, meta: unknown)` (positional, NOT event-object) |
| US-010 | Errors are discriminable via instanceof | T-021 | Unit | construct each of the 7 error classes (`MultipartIdleTimeoutError`, `MultipartTotalTimeoutError`, `MultipartAbortError`, `MultipartTruncatedError`, `MultipartPartTooLargeError`, `MultipartHeadersTooLargeError`, `MultipartTooManyPartsError`); assert `e instanceof MultipartXxxError === true` and `instanceof Error === true`; assert `name` is the stable string matching the class name verbatim (NFR-DR-D-007); assert `cause` plumbing works; assert structured-property fields (e.g. `MultipartPartTooLargeError.{maxPartBytes,partIndex,bytesReceived}`) are correctly populated |
| US-011 | Listeners attached BEFORE pipe so synchronous early errors are not lost | T-022 | Integration | feed an envelope with garbage in the first byte such that dicer emits `'error'` synchronously on the first chunk; assert the error is captured by the queue and surfaces from the first `await iterator.next()` |
| FR-001 | Library MUST export parseMultipartRelated returning AsyncGenerator<StreamingMultipartPart> | T-023 | Unit | static type test (`tsd`-style) and runtime: `typeof parseMultipartRelated === 'function'`; calling returns object with `Symbol.asyncIterator`, `next`, `return`, `throw` |
| FR-002 | Accepts Response or Readable; boundary required when Readable | T-024 | Integration | (a) Response path covered by T-001; (b) Readable + boundary path covered by T-005; (c) Readable WITHOUT boundary throws — see T-025 |
| FR-002 | Readable input without boundary throws synchronously | T-025 | Integration | `parseMultipartRelated(Readable.from(buffer)).next()` (no opts); assert rejects with `/boundary option is required/` |
| FR-003 | Web ReadableStream body converted via Readable.fromWeb internally | T-004 | Integration | (see T-004) |
| FR-004 | Synchronous throws on null body / missing boundary / fundamentally invalid input | T-002, T-003, T-025 | Integration | (see referenced rows) |
| FR-005, FR-DR-A-029 | fetchAndHandleMultipart wraps fetch + parser; resolves to MultipartFetchResult<T> with `{parts, bytes, elapsedMs, status, headers}` | T-006, T-007 | Integration | (see referenced rows); also assert `typeof result.status === 'number'`, `result.headers instanceof Headers`, `result.bytes > 0`, `result.elapsedMs > 0`; assert `'response' in result === false` (FR-DR-A-029 — old `response: Response` field is REMOVED) |
| FR-006 (fetchAndHandleMultipart) | fetchAndHandleMultipart REQUIRES idleTimeoutMs and totalTimeoutMs (no defaults) | T-026 | Integration | call `fetchAndHandleMultipart(url, { parser })` (omitting timeouts); assert rejects with `TypeError /idleTimeoutMs/`; same for missing totalTimeoutMs |
| FR-006 (parseMultipartRelated, JC-3) | parseMultipartRelated REQUIRES idleTimeoutMs and totalTimeoutMs on BOTH overloads (Response + Readable + boundary) | T-026b | Integration | call `parseMultipartRelated(res, {})` and `parseMultipartRelated(readable, { boundary: 'X' })` (timeouts omitted); assert iterator's first `.next()` rejects with `TypeError /idleTimeoutMs/` and `/totalTimeoutMs/` respectively; also assert that supplying just one of the two still rejects (test the cross-product) |
| FR-007 | idleTimeoutMs elapses → MultipartIdleTimeoutError; idle timer resets on every chunk | T-009, T-010 | Integration | (see referenced rows) |
| FR-008 | totalTimeoutMs elapses → MultipartTotalTimeoutError regardless of activity | T-011 | Integration | (see referenced row) |
| FR-009 | AbortSignal fires (or already aborted) → MultipartAbortError | T-012, T-013 | Integration | (see referenced rows) |
| FR-010 | All termination paths drain unyielded parts, remove listeners, unpipe, destroy source | T-015 (break), T-008 (parser throw), T-012 (abort), T-009 (idle), T-011 (total), T-027 (success) | Integration | (see rows) — covered across termination types |
| FR-010 | Success-path cleanup symmetry | T-027 | Integration | full successful 3-part run; after `for await` completes, assert `dicer.listenerCount('part') === 0`, `dicer.listenerCount('error') >= 1`, `source.destroyed`, no leaked part streams |
| FR-011 | dicer 'error' listener stays attached through finally; late emissions logger.warn'd | T-016 | Integration | (see referenced row) |
| FR-012 | All listeners attached BEFORE pipe() | T-022 | Integration | (see referenced row) |
| FR-013 | onProgress fires ≥1× per yielded part and at completion | T-014 | Integration | (see referenced row) |
| FR-014 | PartParser returning undefined contributes nothing; parser throw rejects + cleans up | T-007, T-008 | Integration | (see referenced rows) |
| FR-015 | streamToString(readable, encoding?) and streamToBuffer(readable) exported | T-017, T-018, T-028 | Unit | T-017/T-018 + T-028: zero-length readable for both helpers (`Readable.from([])` → `''`, `Buffer.alloc(0)`) |
| FR-016 | extractBoundary public; flattenDicerHeaders/flattenHeaderValue/sanitizeFileName/deriveNameFromContentId internal | T-029, T-030 | Unit + Integration | T-029 unit: extractBoundary handles bare token, quoted string, mixed params; T-030 integration: `pnpm pack --dry-run` smoke test asserts internal symbols absent from `dist/index.d.ts` |
| FR-017 | 3 silent-catch sites replaced with logger.warn observable patterns | T-031, T-032, T-033 | Integration | each reference-impl silent site exercised: (a) onSourceBytes throws → logger.warn; (b) src.unpipe throws → logger.warn; (c) onProgress throws → logger.warn — and parsing continues |
| FR-018 | Optional logger option in both options interfaces; defaults to console.warn | T-019, T-020 | Integration | (see referenced rows) |
| FR-019 | Error classes exported and instanceof-discriminable | T-021 | Unit | (see referenced row) |
| FR-020 | All exported symbols have JSDoc with @param @returns @throws @example | T-034 | Unit | static check: load `dist/index.d.ts`, scan for required JSDoc tags on every public symbol — fails if any missing |
| FR-021 | fetchAndHandleMultipart validates Content-Type starts with multipart/related (case-insensitive); reject before dicer constructed | T-035, T-036 | Integration | T-035: server returns `application/json`; assert rejects with `Error /Content-Type is not multipart\/related; got application\/json/` and dicer never constructed (Dicer instance count from harness === 0); T-036: case-insensitive — server returns `Multipart/Related; boundary=foo` → success |
| FR-022 | Source ends without closing boundary → MultipartTruncatedError; cleanup runs | T-037 | Integration | server writes 2-part envelope BUT cuts the connection before closing `--boundary--`; assert rejects with `MultipartTruncatedError` whose `bytesReceived` matches what was sent; assert listener cleanup |
| FR-023 | sanitizeFileName: strip path separators, control chars, leading dots, replace non `[A-Za-z0-9._-]` with `_`, cap 255 | T-038 | Unit | table-driven: `../etc/passwd` → `_._etc_passwd` (or `etc_passwd` after leading-dot strip); embedded `\x00\x07` removed; `.hidden` → `hidden`; `'a'.repeat(300)` → 255 chars; spaces → `_` |
| NFR-DR-S-005 | sanitizeFileName empty/Windows-reserved/dot-only → `'_'` fallback (never returns empty) | T-038b, T-038c | Unit | T-038b: Windows reserved-name table (`'CON'`, `'con'`, `'AUX'`, `'aux.txt'`, `'COM1'`, `'com9.dat'`, `'LPT1'`, `'lpt9.foo'`, `'PRN'`, `'NUL'`) ALL → `'_'`; non-reserved (`'CONsole'`, `'auxiliary'`) NOT mapped. T-038c: pure-dot inputs (`'.'`, `'..'`, `'...'`) and inputs that empty after pipeline (e.g. control-char-only string) → `'_'`. Assert NEVER returns `''` |
| NFR-001 | Strict TS with no `any`, no `as any`, no `as never` on Readable.fromWeb | T-039 | Unit | static gate: grep `src/**/*.ts` for `any|as never|as any`; fails on match |
| NFR-002 | Dual ESM+CJS+`.d.ts`, sideEffects:false, single entry | T-040 | Unit | post-build: assert `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` exist; `package.json#exports['.']` matches; `package.json#sideEffects === false` |
| NFR-003, NFR-DR-A-014 | Node ≥ 20.18.0 (engines floor — NFR-DR-A-014 tightens NFR-003) | T-041 | Unit | `package.json#engines.node === '>=20.18.0'` |
| NFR-004 | dicer pinned exactly 0.3.1 | T-042 | Unit | `package.json#dependencies.dicer === '0.3.1'` (no caret/tilde); no other runtime deps |
| NFR-005 | Zero silent catches anywhere | T-043 | Unit | grep `src/**/*.ts` for `catch \(\) {\s*}` and `catch \([^)]*\) {\s*}`; any match fails (companion to T-031..T-033) |
| NFR-006 | Battle-tested resource hygiene | T-044, T-045, T-046 | Integration | T-044: listener counts before AND after every termination path are equal (regression suite); T-045: malformed-boundary fuzz (10 random boundaries with embedded LF/CR/null bytes) handled gracefully; T-046: concurrent abort + idle-timeout race — first-fire-wins; cleanup idempotent |
| NFR-007 | Branch coverage ≥ 90% on src/**; happy + error + abort/timeout per public function | T-047 | Unit | CI runs `vitest --coverage`; threshold gate `branches: 90` |
| NFR-008 | pnpm pack --dry-run enumerates exactly dist/, README.md, LICENSE, package.json | T-048 | Unit | shell out to `pnpm pack --dry-run --json`; assert files === expected set |
| NFR-009 | pnpm check passes with zero warnings (eslint --max-warnings=0) | T-049 | Unit | `pnpm check` exits 0 in CI |
| NFR-010 | README ships with install + quickstart + API summary + spec link | T-050 | Unit | grep `README.md` for required sections |
| NFR-011 | Memory footprint constant relative to part-body size, not response size | T-051 | Integration | feed 100 MB envelope (10×10MB parts); use `process.memoryUsage().heapUsed` snapshots; assert peak heap < 50 MB above baseline |
| NFR-012 | Error classes runtime-importable (instanceof works across CJS+ESM consumers) | T-052 | Integration | spawn child Node process that requires `dist/index.cjs`, throws an idle-timeout error; parent imports from `dist/index.js`; (sanity check) assert child's error stringification matches expected; live `instanceof` cross-bundle is asserted via single-bundle re-import only — see implementation note |
| NFR-DR-A-013 | Public option-bag fields use `field?: T \| undefined` form | T-070 | Unit | `tsd`-style static check: a synthesized `const opts = { idleTimeoutMs: 1000, totalTimeoutMs: 5000, signal: maybeUndefined } satisfies ParseMultipartOptions` compiles under `exactOptionalPropertyTypes: true` even when `signal` is statically typed `AbortSignal \| undefined`; same for `MultipartHandlerOptions` |
| FR-DR-A-027 | Hand-written ambient dicer shim; published `dist/index.d.ts` does NOT import from `dicer` | T-071 | Unit | post-build: read `dist/index.d.ts` as text; assert it contains NO substring matching `from ['"]dicer['"]` and NO `import.*dicer`; also assert `src/internal/dicer.d.ts` exists and is well-formed (parses as TS without `@types/dicer`) |
| FR-DR-A-028 | CJS/ESM dicer interop normalization works under both module formats | T-072 | Integration | spawn child Node process #1 that does `require('dist/index.cjs')` and exercises a multipart parse; child process #2 does dynamic `import('dist/index.js')` and exercises the same parse; both succeed without `TypeError /Dicer is not a constructor/`. Asserts the `dicerMod.default ?? dicerMod` shape works under both bundle formats |
| FR-DR-A-025, FR-DR-A-026 | Idle timer ownership lives in Layer A; reset by per-chunk `'data'` listener (NOT onProgress) | T-073 | Integration | Layer-A direct test: feed `Readable` of slow chunks (1B every 4s) into `parseMultipartRelated(readable, { boundary, idleTimeoutMs: 5000, totalTimeoutMs: 60_000 })` WITHOUT supplying `onProgress`; assert success (proves idle reset is independent of `onProgress`). Companion: spy on `timers.resetIdle`; assert it fires per source chunk, NOT per part |
| FR-DR-A-029 | `MultipartFetchResult` shape has `{parts,bytes,elapsedMs,status,headers}` and NOT `response` | T-074 | Integration | covered as part of T-005's expanded assertions; standalone unit row asserts `Object.keys(result).sort()` equals `['bytes','elapsedMs','headers','parts','status']`; assert `result.headers instanceof Headers` |
| NFR-DR-S-001 | `maxPartBytes` cap → `MultipartPartTooLargeError`; cleanup runs | T-075 | Integration | feed envelope with one 10 KiB part body; `maxPartBytes: 4096`; assert iterator rejects with `MultipartPartTooLargeError` whose `maxPartBytes === 4096`, `partIndex === 0`, `bytesReceived >= 4096`; assert source destroyed; listener-leak harness clean |
| NFR-DR-S-002 | `streamToString` / `streamToBuffer` `maxBytes` overflow | T-017b, T-018b | Unit | (see T-017 / T-018 rows above) |
| NFR-DR-S-004 | `maxHeadersPerPart` (count) and `maxHeaderBytesPerPart` (bytes) caps → `MultipartHeadersTooLargeError` | T-076 | Integration | (a) envelope with a part carrying 200 headers, `maxHeadersPerPart: 100`; assert reject with `MultipartHeadersTooLargeError { limit: 'count', cap: 100, observed: > 100 }`; (b) envelope with one part carrying a 32 KiB single header value, `maxHeaderBytesPerPart: 16_384`; assert reject with `{ limit: 'bytes', cap: 16384, observed: > 16384 }`; both: source destroyed, listener-leak harness clean |
| NFR-DR-S-005 | `sanitizeFileName` Windows-reserved + dot-only fallbacks | T-038b, T-038c | Unit | (see T-038 row above) |
| NFR-DR-S-006 | Embedded attacker bytes sanitized via `formatErrorEmbed` (truncate / control-char redact / JSON.stringify) | T-077 | Unit | direct unit test on `formatErrorEmbed` — table-driven: (a) 5 KB ASCII input → truncated to 120 chars + `…`; (b) input with `\x00`, `\x07`, `\x1B[31m` (ANSI red) → all replaced with `[redacted-control]`; (c) input with embedded `"` → JSON.stringified output preserves quotes visibly. Companion integration row: trigger FR-021 with a `Content-Type` header containing CRLF + 5 KB garbage; assert thrown error message length <= ~250 chars and contains no raw control bytes |
| NFR-DR-S-008 | Logger `meta` carries only `errSummary: { name, message }` (truncated, no raw bytes) for late-emit errors | T-078 | Integration | trigger T-016 path with a dicer error whose `.message` is 500 chars + control bytes; assert `mockLogger` event arg's `meta.errSummary.message.length <= 120` and contains no `\x00`-`\x1F` bytes; assert `meta` does NOT contain a `chunk` / `bytes` / raw `Error` field; asserts NFR-DR-S-008 contract |
| NFR-DR-S-009 | `validatePositiveTimeout` rejects values `> 2_147_483_647` (`2^31 - 1`) | T-079 | Unit | direct unit on `validatePositiveTimeout`: input `2_147_483_647` PASSES (boundary-inclusive); inputs `2_147_483_648`, `2^31`, `Number.MAX_SAFE_INTEGER` all throw `TypeError` whose message mentions `setTimeout` clamping. Companion: `parseMultipartRelated(res, { idleTimeoutMs: 2**31, totalTimeoutMs: 5000 })` first `.next()` rejects sync |
| NFR-DR-S-011 | `extractBoundary` non-backtracking (ReDoS-resistant); 64 KiB pathological < 50 ms | T-080 | Unit | construct `pathological = 'multipart/related; boundary="' + '\\"'.repeat(32_000) + '"'` (~64 KiB of escaped quotes); call `extractBoundary(pathological)` 10 times; record total wall time via `performance.now()`; assert mean < 50 ms (the >5x slack absorbs CI noise; failing means a backtracking regex regression) |
| NFR-DR-S-012 | `maxParts` cap (default 10_000) → `MultipartTooManyPartsError` | T-081 | Integration | feed envelope of 50 parts with `maxParts: 10`; assert iterator rejects with `MultipartTooManyPartsError { maxParts: 10, observed: 11 }`; assert source destroyed; listener-leak harness clean. Companion T-081b: omit `maxParts` (default `10_000`); programmatically generated 10_001-part envelope rejects with `observed: 10_001` |
| NFR-DR-D-007 | `err.name` fallback for cross-format `instanceof` | T-082 | Unit | for each of the 7 error classes, construct an instance and assert `err.name` is the class name verbatim; companion integration: spawn ESM child that throws `MultipartIdleTimeoutError`, parent imports from CJS bundle; assert `err.name === 'MultipartIdleTimeoutError'` even if cross-bundle `instanceof` returns `false` |
| F-A-005 | AsyncGenerator concurrency: library MAY but is NOT required to detect concurrent `next()` | T-083 | Integration | call `iter.next()` twice without awaiting; assert the library does NOT crash the process (no uncaughtException); whether the second `.next()` resolves, hangs, or rejects with an `Error` is acceptable per Assumption text — the test asserts only the no-crash contract |

---

## Negative / Edge Coverage

Every edge case in `kiln/spec/spec.md` § "Edge Cases & Error Scenarios" is tested.

| Scenario (from spec edge cases) | Test ID | Test Description |
|---|---|---|
| `res.body` is `null` | T-002 | (see Coverage Map) |
| Missing `Content-Type` header on Response | T-053 | `new Response(body)` with `headers: {}`-equivalent; assert sync throw `/Content-Type header is required/` |
| Content-Type present but no `boundary=` | T-003 | (see Coverage Map) |
| Boundary contains quoted-string with embedded special chars | T-054 | server returns `Content-Type: multipart/related; boundary="weird;boundary"`; multipart body uses `--weird;boundary--`; assert success |
| Caller `break`s out after first part | T-015 | (see Coverage Map) |
| Caller throws inside `for await` loop | T-008 | (see Coverage Map) |
| Network stalls (idle timeout) | T-009 | (see Coverage Map) |
| Total timeout fires | T-011 | (see Coverage Map) |
| AbortSignal fires mid-stream | T-012 | (see Coverage Map) |
| AbortSignal already aborted | T-013 | (see Coverage Map) |
| Two termination signals race | T-046 | concurrent `controller.abort()` + idle-timer fire on the SAME tick; assert only the first-fire error type surfaces; cleanup runs once (counted via spy) |
| Dicer late-emit error after `finally` | T-016 | (see Coverage Map) |
| Parser callback throws | T-008 | (see Coverage Map) |
| Parser callback returns `undefined` | T-007 | (see Coverage Map) |
| Part with zero-byte body | T-055 | envelope contains a part with empty body; assert yielded with headers, `body` ends immediately, `await streamToBuffer(body)` resolves to `Buffer.alloc(0)` |
| Part with no `Content-ID` header | T-056 | envelope part has Content-Type but no Content-ID; assert `part.contentId === undefined`, parser handles |
| Header name with unusual capitalization | T-057 | envelope uses `CONTENT-TYPE`, `Content-Id`, etc.; assert `part.headers['content-type']` lowercased |
| `flattenHeaderValue` undefined / array / nested array | T-058 | unit table: `undefined` → `''`; `Buffer('foo')` → `'foo'`; `[Buffer('a'), Buffer('b')]` → `'ab'`; `[[Buffer('a')], [Buffer('b')]]` → `'ab'`; non-Buffer items in array → fallback to `String(x)` join |
| `sanitizeFileName` path traversal | T-038 | (see Coverage Map) |
| Non-multipart Content-Type on response | T-035 | (see Coverage Map) |
| Source ends mid-stream w/o closing boundary | T-037 | (see Coverage Map) |
| Web ReadableStream that errors | T-059 | construct a Web ReadableStream whose pull rejects; pass to `parseMultipartRelated`; assert rejects with the same Error; cleanup runs |
| `idleTimeoutMs: 0` | T-060 | assert sync throw `TypeError /idleTimeoutMs must be a positive finite integer/` |
| `idleTimeoutMs: NaN` | T-061 | assert sync throw `TypeError /idleTimeoutMs must be a positive finite integer/` |
| `idleTimeoutMs: Infinity` | T-062 | assert sync throw |
| `idleTimeoutMs: -1` | T-063 | assert sync throw |
| `idleTimeoutMs: 1.5` | T-064 | assert sync throw (must be integer) |
| `totalTimeoutMs: 0/NaN/Infinity/-1/1.5` | T-065 | mirror of T-060..T-064 |
| Malformed boundary fuzz (NFR-006) | T-045 | (see Coverage Map): 10 generated boundaries with embedded LF, CR, NUL — assert no process crash; either successful parse or clean rejection |
| Truncated response w/ partial part header | T-066 | server writes envelope opening + partial part header (no terminating CRLF) then closes; assert rejects with either `MultipartTruncatedError` or a dicer-derived parse error (whichever fires first); cleanup runs |
| Server returns 4xx with multipart-shaped body (FR-021) | T-067 | server returns 404 `Content-Type: application/json`; assert rejects with the FR-021 message and Dicer never constructed |
| Source emits `'error'` after first part yielded | T-068 | inject `Readable` that emits `'error'` after 1 chunk; assert iterator's next `.next()` rejects with that error; cleanup runs |
| Caller sets `fetchInit.signal` (FR-024) | T-069 | call `fetchAndHandleMultipart(url, { fetchInit: { signal: ctrl.signal }, idleTimeoutMs: 1000, totalTimeoutMs: 5000, parser })`; assert sync throw `Error /fetchInit.signal is reserved/`; mirror with both `options.signal` AND `fetchInit.signal` set; assert same throw |
| Late-emit listener-count assertion | T-044 | (see Coverage Map): on every termination path, snapshot `dicer.listenerCount('part')` and `('error')` and `('finish')` immediately after `finally`; assert no leaked listeners (other than the intentionally-retained `'error'`) |

---

## Resource-Leak Hygiene Suite (NFR-006)

Per the operator's "battle-tested" directive, this suite is a separate axis. Each row asserts ZERO listener leak and ZERO part-stream leak.

| Termination path | Test ID | Listener-count check | Part-stream check |
|---|---|---|---|
| Successful full iteration | T-027 | `part === 0`, `error >= 1`, `finish === 0` | all parts destroyed |
| Caller `break` after part 1 | T-015 | same | unyielded parts destroyed |
| Caller throws inside loop | T-008 | same | unyielded parts destroyed |
| Idle timeout fires | T-009 | same | unyielded parts destroyed |
| Total timeout fires | T-011 | same | unyielded parts destroyed |
| Abort signal fires | T-012 | same | unyielded parts destroyed |
| Already-aborted signal | T-013 | n/a (dicer never constructed) | n/a |
| Truncated source | T-037 | same | unyielded parts destroyed |
| Source `'error'` event | T-068 | same | unyielded parts destroyed |
| Parser throws | T-008 | same | unyielded parts destroyed |
| Wrong Content-Type | T-035 | n/a (dicer never constructed) | n/a |
| Concurrent abort + idle timeout | T-046 | same; cleanup idempotent (no double-`destroy`) | unyielded parts destroyed exactly once |
| Late emit after finally | T-016 | `error >= 1` retained; logger.warn fires | n/a |
| `maxPartBytes` overflow | T-075 | same; cleanup idempotent | offending part body destroyed; remaining unyielded parts destroyed |
| `maxHeadersPerPart` / `maxHeaderBytesPerPart` overflow | T-076 | same | unyielded parts destroyed |
| `maxParts` overflow | T-081 | same | unyielded parts destroyed |

---

## Test Type Mix

- **Unit tests** (`tests/unit/*.test.ts`):
  - `extract-boundary.test.ts` — RFC 2046 parser cases (T-029, T-054 unit subset); ReDoS-resistance perf (T-080).
  - `flatten-headers.test.ts` — Buffer / array / nested-array / undefined cases (T-058).
  - `sanitize-filename.test.ts` — path-traversal, control chars, length cap (T-038); Windows-reserved + dot-only fallback (T-038b, T-038c).
  - `stream-helpers.test.ts` — happy paths + zero-byte (T-017, T-018, T-028); `maxBytes` overflow (T-017b, T-018b).
  - `errors.test.ts` — class identity, instanceof, name, cause for all 7 classes (T-021, T-082); structured-property fields.
  - `validate-timeout.test.ts` — 0 / NaN / Infinity / negative / non-integer (T-060..T-065); `2^31 - 1` boundary (T-079).
  - `format-error-embed.test.ts` — truncate / control-char redact / JSON.stringify (T-077).
  - `static-gates.test.ts` — grep gates (no `any`, no silent catch), JSDoc presence (T-039, T-043, T-034); `dist/index.d.ts` does not import from `dicer` (T-071).
  - `package-shape.test.ts` — `package.json` invariants (T-040, T-041, T-042); pack manifest (T-048).
  - `option-types.test.ts` — `tsd`-style spread-merge under `exactOptionalPropertyTypes` (T-070).

- **Integration tests** (`tests/integration/*.test.ts`):
  - `parse-multipart-related.test.ts` — happy path, header normalization, ordering (T-001, T-004, T-005, T-024, T-027, T-056, T-057); idle-reset ownership (T-073); result shape (T-074).
  - `parse-cleanup.test.ts` — leak hygiene suite (T-008, T-015, T-016, T-027 cleanup, T-046, T-068, T-044).
  - `parse-timeouts.test.ts` — idle, total, validation (T-009, T-010, T-011, T-026, T-026b, T-060..T-065, T-079).
  - `parse-truncation.test.ts` — truncated streams, partial headers (T-037, T-066).
  - `parse-resource-caps.test.ts` — `maxPartBytes` (T-075), `maxHeaders*` (T-076), `maxParts` (T-081/T-081b).
  - `fetch-and-handle.test.ts` — orchestration, parser, progress (T-006, T-007, T-014).
  - `fetch-content-type-validation.test.ts` — FR-021 path (T-035, T-036, T-067); embedded-byte sanitization (T-077 integration companion).
  - `abort.test.ts` — signal mid-stream, already-aborted (T-012, T-013).
  - `logger.test.ts` — event-style logger, default console.warn (T-019, T-020, T-031, T-032, T-033); meta sanitization (T-078).
  - `boundary-edge-cases.test.ts` — quoted-string boundary, fuzz (T-054, T-045).
  - `webstream-input.test.ts` — Web ReadableStream errors (T-004, T-059).
  - `memory.test.ts` — bounded heap usage (T-051).
  - `cross-format.test.ts` — CJS+ESM consumer sanity (T-052); CJS dicer interop (T-072); `err.name` cross-format fallback (T-082 integration).
  - `concurrency.test.ts` — concurrent `iter.next()` does not crash (T-083).

- **Test discipline:**
  - No mocked sources where a real `Readable` works (per `kiln/standards/testing.md`).
  - No Playwright (not a UI).
  - No real network — `fetchAndHandleMultipart` tests use `node:http.createServer` on `127.0.0.1:0`.
  - Every test that mutates `Dicer.prototype` MUST restore it in `afterEach` (the existing reference test gets this right; we keep the same pattern in `tests/fixtures/capture-dicer.ts`).
  - Every termination-path test MUST `await settle()` (5× `setImmediate`) before asserting on listener counts, to let dicer's nextTick emissions land.

---

## Coverage accounting

| Source                                              | Count |
|-----------------------------------------------------|-------|
| Acceptance criteria in user stories                 | 22    |
| Functional requirements (FR-001..FR-023 + 5 FR-DR)  | 28    |
| Non-functional requirements (NFR-001..NFR-012 + 13 NFR-DR with testable surface) | 25 |
| Edge-case rows in spec table                        | 30+   |
| **Distinct test IDs in plan (T-001..T-083, plus a/b/c variants)** | ~92 |
| **Coverage Map rows**                               | 70+ (some rows reference multiple criteria; all are mapped) |
| **Edge/Negative Coverage rows**                     | 22 (one per spec edge case; new caps are tested in Coverage Map rows above and in Resource-Leak Hygiene Suite) |

Every Coverage Map row has a non-empty Test ID, Test Type, and Test Description. Every spec acceptance criterion appears in the Coverage Map at least once. Every FR (including the 5 `FR-DR-*` rows added in Phase 5 domain review) appears at least once. Every NFR with a testable surface (including the 13 `NFR-DR-*` rows) appears at least once. The `NFR-DR-D-002`, `NFR-DR-D-010`, `NFR-DR-D-015`, `FR-DR-D-001`, and `FR-DR-D-004` rows are deliberately NOT in this plan because they are Sprint 1 deliverables / publish-config concerns rather than runtime-testable contracts; they are tracked in the planner queue.
