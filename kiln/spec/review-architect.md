# Domain Review — Architect persona

**Adversarial framing applied:** "This spec has at least three architectural mistakes. Find them."

## Findings

### F-A-001 — Idle-timer reset is wired to `onProgress`, but `onProgress` does not fire per chunk

**Severity:** Critical
**Type:** Wrong shape (data-flow ownership error)
**Location:** `kiln/spec/architecture.md` §3 line 68 ("Constructs onProgress wrapper that doubles as idle-reset"); §4.2 line 156 ("onProgress: progressWrapper, (resets idle timer too)"); FR-013 in `kiln/spec/spec.md`; FR-007.

**Problem:** Architecture §3 and §4.2 say Layer B (`fetchAndHandleMultipart`) drives the idle reset by wrapping `onProgress`, but FR-013 explicitly defines the contract: `onProgress` fires "at least once per yielded part and at completion." That cadence is per-part, not per-chunk. FR-007 demands the idle timer reset on **every chunk** received from the source. A single multipart part can be megabytes streaming over many chunks across many seconds; if `onProgress` only ticks at part boundaries, a stream that's sending a large part body slowly but steadily will idle-timeout in the middle of a part it's actively delivering. The idle reset has to ride a real chunk-level event on the source `Readable` (`'data'` event), and that event lives in Layer A — but Layer A is being asked to expose only `onProgress`, which is the wrong granularity.

The deeper layering error: Layer B owns `TimerState` and Layer A owns the source-stream `'data'` listener. Architecture §3 forbids Layer A from importing Layer B, so Layer A cannot call `timers.resetIdle()` directly. There is no wired-up path from "chunk arrives at Layer A" to "Layer B's idle timer resets" except via `onProgress`, which is the wrong cadence. FR-007's "resets on every chunk" is currently un-implementable under the stated layering.

**Recommendation:** Move idle-timer ownership entirely into Layer A. `parseMultipartRelated` already attaches the per-chunk `'data'` listener (architecture.md §4.1 step 6), so it is the natural home for `resetIdle()`. Pass `idleTimeoutMs` and `totalTimeoutMs` from Layer B → Layer A on every call (architecture.md §4.2 step 5 currently passes `idleTimeoutMs: undefined`, which is the bug). Drop the "onProgress doubles as idle reset" trick. Concretely:

- Edit `kiln/spec/architecture.md` §3 layer-B box: replace "Constructs onProgress wrapper that doubles as idle-reset" with "Forwards `idleTimeoutMs`/`totalTimeoutMs`/`signal` to `parseMultipartRelated`; owns wallclock for `elapsedMs`/`bytes`."
- Edit `kiln/spec/architecture.md` §4.2 step 5: pass `idleTimeoutMs: opts.idleTimeoutMs, totalTimeoutMs: opts.totalTimeoutMs, signal: opts.signal` through to `parseMultipartRelated`.
- Add `FR-DR-A-025 The idle timer MUST be reset by the per-chunk 'data' listener attached at Layer A, not by the onProgress callback. onProgress's cadence (FR-013) is unchanged.`
- Add `FR-DR-A-026 fetchAndHandleMultipart MUST forward idleTimeoutMs and totalTimeoutMs to parseMultipartRelated (not consume them at the fetch layer). Timer ownership lives in one place (Layer A) for both entry points.`

**Action rule:** 1 (Critical missing feature → add to spec; correct an existing FR).

---

### F-A-002 — `dicer` ships no TypeScript types and the spec is silent about how the build acquires them

**Severity:** High
**Type:** Missing FR (build-system gap, library-specific)
**Location:** `kiln/spec/architecture.md` §6 (Build / publish architecture); NFR-001, NFR-004; `BRIEF.md` line 74.

**Problem:** `dicer@0.3.1` is the single runtime dep, pinned exact, and the architecture is built around `new Dicer({ boundary })`, attaching listeners on `dicer`, `dicer.unpipe(...)`, etc. dicer itself is a 2014-era CJS package that ships no `.d.ts` and no `types` field in its `package.json`. There is a community `@types/dicer` on DefinitelyTyped, last updated years ago and not necessarily aligned with `0.3.1`'s actual emit shape (`Buffer | Buffer[] | Buffer[][]` for header values — see data-model §2.5). The spec mandates `strict: true` + `noUncheckedIndexedAccess: true` + "no `any`" (NFR-001), but says nothing about how dicer is imported under those rules.

Three concrete consequences if this is left unspecified:

1. The `import Dicer from 'dicer'` line will fail typecheck under `strict` because TS will resolve dicer to `any` and trigger `noImplicitAny` if `--noImplicitAny` is on. Even without that flag, downstream `dicer.on('part', ...)` will be implicitly `any`, defeating the strict-types contract for the actual core of the library.
2. Adding `@types/dicer` from DefinitelyTyped pulls in a *runtime-unrelated* author's idea of what dicer's API looks like, with no contractual link to `dicer@0.3.1`. NFR-004 ("dicer pinned exact") gets defeated at the type layer.
3. tsup's `--dts` mode will inline dicer's types into `dist/index.d.ts`. If those types are missing or `any`, the published `.d.ts` leaks `any` into consumer code, which silently violates NFR-001 *for consumers*.

**Recommendation:** Add a hand-written ambient `.d.ts` shim for dicer co-located with the library (e.g., `src/types/dicer.d.ts` declared via `tsconfig.json` `"types"` array) that types exactly the surface the library uses. This (a) keeps the type contract under our control (matches NFR-004's "fork-and-absorb" philosophy), (b) prevents `any` leakage, (c) survives a future dicer version with no community types update.

- Add `FR-DR-A-027 The library MUST ship a hand-written ambient declaration shim for dicer at src/types/dicer.d.ts that types only the surface the library uses (Dicer constructor, 'part'/'finish'/'error'/'header' events, per-part Readable shape). The shim MUST NOT depend on @types/dicer. tsup's --dts MUST emit a self-contained dist/index.d.ts that does not require @types/dicer at consumer install time.`
- Add to NFR-001: "no `any` includes implicit `any` from untyped imports."
- Update `kiln/spec/architecture.md` §6: add a row "dicer types" → "ambient shim at `src/types/dicer.d.ts`; @types/dicer NOT a devDependency."

**Action rule:** 1 (Critical missing feature → add to spec).

---

### F-A-003 — ESM consumers of dicer (CJS) — the import shape is undefined

**Severity:** High
**Type:** Spec gap (library-specific: CJS/ESM interop)
**Location:** `kiln/spec/architecture.md` §6; NFR-002; no FR addresses it.

**Problem:** dicer is published as CJS with a `module.exports = Dicer` default-export shape (no named exports). The library publishes both ESM (`dist/index.js`) and CJS (`dist/index.cjs`) with `tsup`. tsup will, by default, externalize a runtime dependency. That means:

- The CJS bundle does `const Dicer = require('dicer')` — works.
- The ESM bundle does `import Dicer from 'dicer'` — this resolves through Node's CJS-named-exports interop, which has known footguns: `import { Dicer } from 'dicer'` would fail because dicer has no named exports; only `import Dicer from 'dicer'` works, AND only because Node treats `module.exports` as the default export. Some bundlers (esbuild's CJS-interop helper, used by tsup) inject `__toESM` shims that work; some (rollup with `output.interop: 'auto'`) work differently. The spec doesn't pin which interop strategy tsup uses.

Worse: if a consumer uses a non-Node ESM environment (e.g., a Vite SSR build, a Deno runtime via npm: prefix, or a bundler with strict CJS-interop) the `import Dicer from 'dicer'` line may resolve to `{ default: Dicer }` instead of `Dicer`, and `new Dicer(...)` blows up with "is not a constructor". This is a published-library-grade bug that test-plan T-052 ("CJS+ESM consumer sanity") only superficially covers.

**Recommendation:**

- Add `FR-DR-A-028 The dicer import MUST be written defensively to handle both __esModule-wrapped and bare CJS interop: import the module via a single helper that normalizes the default export. Example: import dicerMod from 'dicer'; const Dicer = (dicerMod as any)?.default ?? dicerMod; — except without the any. The library MUST verify in CI that both dist/index.js and dist/index.cjs construct a working Dicer when consumed.`
- Strengthen test T-052 to actually instantiate the library from a child Node process running in `--input-type=module` (ESM) AND in CJS, parse a real envelope end-to-end, and assert success — not just "stringification matches expected." A surface-level instanceof check from a single bundle (current T-052) does not exercise the dicer interop path.
- Add to `kiln/spec/architecture.md` §6: row "dicer import shape" → "via a normalized default-export helper; verified by E2E child-process tests in both ESM and CJS modes."

**Action rule:** 1 (Critical missing feature → add to spec). This is exactly the class of bug that ships and bites the first external consumer.

---

### F-A-004 — `MultipartFetchResult.response` exposes a Response with a consumed body — public-API footgun

**Severity:** Medium
**Type:** Leaky abstraction
**Location:** `kiln/spec/data-model.md` §1.3 (`MultipartFetchResult`); `kiln/spec/api.md` §2.

**Problem:** `MultipartFetchResult<T>.response: Response` returns the original `fetch` `Response` object after the multipart envelope has been fully consumed. The data-model JSDoc admits this in plain English ("Headers and status are preserved; the body stream is already consumed"). But `Response` does not have a way to be "headers/status only" — the type is the whole thing. A caller will reasonably write:

```ts
const result = await fetchAndHandleMultipart(url, opts);
const text = await result.response.text(); // throws TypeError: Body has already been consumed
```

This is a foot-gun the type system cannot warn about. The architecture is leaking an internal artifact (the raw `Response`) into the result struct. The two fields that callers actually want — status and headers — are not separately surfaced. Worse, when one of the four `MultipartXxxError` paths fires, the spec is silent about whether the user can still retrieve the response status/headers from the error (architecturally they cannot, because the error doesn't carry the response).

**Recommendation:** Either (a) replace `response: Response` with `status: number` and `headers: Headers` (or a flat record) in `MultipartFetchResult`, OR (b) keep `response` but add a redirect via the architecture decisions section that says "callers MAY NOT call `.text()`/`.json()`/`.arrayBuffer()` on `result.response`; the body is already consumed. Use `result.response.headers` and `result.response.status` only." The current data-model note is buried in a JSDoc paragraph and not surfaced as an FR.

Option (a) is cleaner architecturally. Option (b) is preserved-by-convention. Recommendation: option (a).

- Replace `MultipartFetchResult.response: Response` with `status: number` and `headers: Headers`. Update `kiln/spec/data-model.md` §1.3 and `kiln/spec/api.md` §2.
- If option (b) is preferred (operator's call), add `FR-DR-A-029 MultipartFetchResult.response MUST be documented as headers/status-inspection-only; calling response.text/json/arrayBuffer is undefined behavior.` and surface the warning in the API doc, not just the type's JSDoc.

**Action rule:** 5 (Genuine judgment call → ask operator). The choice between (a) clean break vs (b) preserve `response` parity is a deliberate API trade-off.

---

### F-A-005 — Generator re-entrancy and concurrent `next()` not addressed

**Severity:** Medium
**Type:** Spec gap (battle-tested concern)
**Location:** `kiln/spec/spec.md` (no FR); `kiln/spec/data-model.md` §2.2 (`QueueNotifier`); `kiln/spec/architecture.md` §4.

**Problem:** The library claims battle-tested NFR-006 (resource-leak hygiene under concurrent abort + dicer-error race conditions), and the queue-notifier (`QueueNotifier.next()` returns `Promise<QueueItem>`) is the heart of the data flow. But nothing in the spec addresses what happens when:

- A caller calls `iter.next()` twice without awaiting the first (e.g., racing two consumers off the same generator).
- A caller calls `parseMultipartRelated(res)` again on the same `Response` (whose body is already consumed/destroyed).
- A caller restarts iteration on an already-completed generator.

Real async generators in Node are not concurrent-safe by default — calling `.next()` twice in flight produces overlapping pulls and undefined order. The queue-notifier likely uses a single resolver `Promise<void>` for the wakeup; two parallel `next()` calls would race for that resolver and either drop wakeups or duplicate them. The spec's resource-leak hygiene NFR doesn't list this case.

For a library that explicitly markets "battle-tested" this is a real gap. The reference impl was lucky-correct because typical `for await` consumes serially; a bug-fix that introduces concurrent consumption is a regression that no test in the current plan would catch.

**Recommendation:** Add an FR pinning the contract:

- Add `FR-DR-A-030 The AsyncGenerator returned by parseMultipartRelated MUST NOT be consumed concurrently. Calling next() while a prior next() is in-flight is undefined behavior. The library MAY (but is not required to) detect and reject the concurrent call with an Error. Restarting iteration after the generator has returned/thrown is not supported.`
- Add a corresponding test: T-NEW: spawn two `for await` loops over the same generator; assert only one consumes (or library throws cleanly). Place under "Resource-Leak Hygiene Suite" in test-plan.md.
- If the operator wants stronger semantics (concurrent-safe), that's a different design — say so explicitly in OOS instead of leaving it ambiguous.

**Action rule:** 3 (Spec gap → add to Assumptions with default; OR 1 if the operator wants the explicit "throw on concurrent next()" guard).

---

### F-A-006 — `engines.node: ">=20"` is too loose given known `Readable.fromWeb` semantic shifts

**Severity:** Medium
**Type:** Smell (library-specific: runtime contract)
**Location:** `kiln/spec/spec.md` NFR-003; `kiln/spec/architecture.md` §6 ("engines: node >=20"); `kiln/spec/spec.md` Assumptions line 150.

**Problem:** The library leans hard on `Readable.fromWeb(res.body as ReadableStream<Uint8Array>)` (architecture.md §5.5; FR-003). `Readable.fromWeb` was introduced as experimental in Node 17, stabilized in 20, but had backpressure-handling fixes in 20.6, 20.10, and 22.x. NFR-003 says ">=20" with no minor pin. The CI matrix is not specified anywhere — test-plan.md says "Tests run on Node 20+" (Assumptions). For a library that publishes to npm and claims "battle-tested," this is too loose:

- A consumer running Node 20.0.0 (released 2023-04) hits the unpatched `Readable.fromWeb` bugs.
- The CI matrix doesn't specify 20.x AND 22.x, so the library could pass tests on one but ship a regression on the other.
- The spec has zero language about which Node minor versions are supported, which makes the SemVer contract (NFR-001 type stability) ambiguous: "do we break on Node 24 if `Readable.fromWeb` changes?"

**Recommendation:**

- Tighten `engines.node` to a known-good minor: `">=20.10.0"` (last LTS pre-22 with the relevant `fromWeb` fixes), or `">=20"` PLUS an explicit CI matrix.
- Add `FR-DR-A-031 The CI matrix MUST run the full test suite on at least two Node major versions: the package.json#engines floor and the current LTS. The matrix MUST be encoded in CI config (not informally mentioned in spec).`
- Add an NFR row: NFR-013: "Node version contract: `engines.node` floor is the lowest Node version on which the library is tested in CI. Bumping the floor is a major-version bump."

**Action rule:** 2 (Recommended pattern → add as NFR/edge case).

---

### F-A-007 — `Logger` interface signature `(msg, meta?)` is host-hostile for the dominant Node logger ecosystem

**Severity:** Low
**Type:** Smell (configuration/observability ergonomics)
**Location:** `kiln/spec/data-model.md` §1.7; `kiln/spec/api.md` "Wiring a structured logger"; FR-018.

**Problem:** The chosen `Logger.warn(msg: string, meta?: unknown)` signature matches `console.warn` but inverts the dominant structured-logger convention (`pino`, `bunyan`: `logger.warn(meta, msg)`; `winston`: `logger.warn(msg, meta)` — only winston actually matches). The result: every pino/bunyan caller writes the `{ warn: (msg, meta) => log.warn(meta, msg) }` adapter. The recipe in `kiln/spec/api.md` even shows this. This isn't fatal, but it's a tax.

A more host-friendly contract would be a level-tagged function:

```ts
export type LogFn = (level: 'warn', msg: string, meta?: unknown) => void;
```

…or a `LogEvent` object:

```ts
export type LogEvent = { level: 'warn'; msg: string; meta?: unknown };
export type LogFn = (event: LogEvent) => void;
```

Either is more host-pluggable than the current shape because hosts typically have a `forward(level, msg, meta)` or `(event) => write(...)` wrapper already.

**Recommendation:** This is a judgment call; the current signature is workable, just lightly suboptimal. If the operator is set on `{ warn(msg, meta?) }` keep it and explicitly note the tradeoff. Otherwise, switch to a `LogFn` shape and write the adapter recipe for both pino and console.

- Either: keep current signature; add design-decision note in `kiln/spec/architecture.md` §5.10 acknowledging the asymmetry with pino/bunyan.
- Or: change `Logger` to `(level, msg, meta) => void` and update the three call sites (late-emit error, unpipe-failed, onProgress-threw).

**Action rule:** 5 (Genuine judgment call → ask operator).

---

### F-A-008 — `exactOptionalPropertyTypes` applied inconsistently across public types

**Severity:** Medium
**Type:** Type safety gap
**Location:** `kiln/spec/data-model.md` §1 note + §1.4 (`ParseMultipartOptions`) + §1.5 (`MultipartHandlerOptions`).

**Problem:** The data-model document opens with a thoughtful note acknowledging that `exactOptionalPropertyTypes` forces a choice between `field?: T` (cannot pass `undefined` explicitly) and `field?: T | undefined` (can). The note says "Each field's comment makes the choice explicit" — but in practice the public option types are inconsistent without comments justifying the choice:

- `ParseMultipartOptions.boundary?: string` — pure optional; cannot pass `{ boundary: undefined }`.
- `ParseMultipartOptions.signal?: AbortSignal` — same.
- `ParseMultipartOptions.idleTimeoutMs?: number` — same.
- `StreamingMultipartPart.contentId?: string | undefined` — explicit.
- `StreamingMultipartPart.contentLength?: number | undefined` — explicit.

Callers spread-merging options (`{ ...defaults, signal: maybeSignal }` where `maybeSignal` is `AbortSignal | undefined`) will hit a TS error today: `"signal: AbortSignal | undefined" is not assignable to "signal?: AbortSignal"` under `exactOptionalPropertyTypes`. This is a real ergonomic bug that bites every caller that builds options dynamically.

**Recommendation:** Adopt one rule for the public option types: every optional **input** field on `ParseMultipartOptions` and `MultipartHandlerOptions` is `field?: T | undefined`. Read-only **output** fields on `StreamingMultipartPart` are `field?: T | undefined` too (as currently typed). Internal-only types stay simple.

- Edit `kiln/spec/data-model.md` §1.4 and §1.5: change every optional input field to `field?: T | undefined`.
- Add to the §1 leading note: "Public option-bag inputs always use `field?: T | undefined` to support spread-merge ergonomics; internal types use the simpler `field?: T` form."

**Action rule:** 1 (concrete bug-class fix → add to spec / change types).

---

## Severity Breakdown

| Severity | Count |
|---|---|
| Critical | 1 (F-A-001) |
| High | 2 (F-A-002, F-A-003) |
| Medium | 4 (F-A-004, F-A-005, F-A-006, F-A-008) |
| Low | 1 (F-A-007) |
| **Total** | **8** |

Findings most likely to bite production are F-A-001 (idle-reset wiring is broken-by-construction), F-A-002 (no dicer types means strict-mode compilation will fail or leak `any`), and F-A-003 (ESM consumers may construct a non-Dicer at runtime). The first two are ship-blockers in the literal sense — the spec as written will not produce a working strict-typed library. The third ships, then breaks downstream.
