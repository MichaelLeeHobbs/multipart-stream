# `@ubercode/multipart-stream` — project brief

This file is operator-staged context for `/kiln-init`. The skill should read it during Phase 1, infer project type from it (Phase 2), and feed it into the spec-agent (Phase 4) so that the SPECIFY round can skip generic "what are you building?" questions.

## What this project is

A small, focused TypeScript library for consuming `multipart/related` HTTP responses as a typed async-iterator of streaming parts, with production-grade timeout/abort/cleanup hygiene.

**Project type:** Library (use `kiln/templates/library/`).

**Package name:** `@ubercode/multipart-stream`.

**License:** MIT.

**Engines:** Node ≥ 20.

**Module shape:** dual ESM + CJS bundle via `tsup`, with `.d.ts`. `sideEffects: false`. Single entry point at `src/index.ts`.

## Why this exists (don't skip this — informs scope)

The actively-maintained `multipart/related` streaming-parser space on npm is empty as of 2026-05:

- `@mjackson/multipart-parser` — repository archived 2025-10-07
- `dicer` — last published 2021-12; functional but stale
- `multitars` — pre-release canary; unclear whether `multipart/related` is in scope
- Most other multipart packages target `multipart/form-data` for server-side request-body parsing, not response-side streaming consumption

The library fills a real gap: production-grade `multipart/related` streaming on top of `fetch`, with cancellation/timeout machinery that nobody else ships.

## Reference implementation (REQUIRED READING for spec-agent)

The library is being extracted from a working production implementation:

- **Source:** `C:\Users\mhobb\WebstormProjects\vns\portal\portal-ecia\src\libs\streamingMultipart.ts`
- **Tests:** `C:\Users\mhobb\WebstormProjects\vns\portal\portal-ecia\tests\libs\streamingMultipart.test.ts`

The reference file ships ~533 lines covering parsing + production-hardening + DICOM-specific parsers. **Only the parser + production-hardening layers belong in this library.**

### IN scope (extract)

- `parseMultipartRelated(res, opts)` — async-generator over parts; queue+notifier bridge; cleanup-safe under cancellation (drains unyielded parts, removes listeners, unpipes source)
- `fetchAndHandleMultipart(url, options)` — wraps `fetch` with idle timeout + total timeout + AbortSignal + progress callback; routes parts through a caller-supplied parser function
- `streamToString(readable, encoding?)` — convenience helper for collecting small text parts
- `extractBoundary(contentTypeHeader)`, `flattenDicerHeaders`, `flattenHeaderValue`, `sanitizeFileName`, `deriveNameFromContentId` — supporting utilities (some may be promoted to internal-only — spec-agent decides)
- TypeScript types: `StreamingMultipartPart`, `PartParser<T>`, `ParseMultipartOptions`, `MultipartFetchResult<T>`, `MultipartHandlerOptions<T>`

### OUT of scope (do NOT include)

- `dicomBinaryParser`, `regexDicomUrlParser`, `xml2jsDicomUrlParser` — domain-specific DICOM parsers stay in the portal-ecia codebase
- `xml2js` dependency — not needed in the library
- DICOM-specific filename conventions (e.g., `.dcm` extension defaulting in `deriveNameFromContentId`)

### Known issues from prior code review (address during /kiln-init)

- 3 silent-catch blocks (lines 121, 192, 314 in the reference) violate kiln's `error-handling.md` standard. Replace with `console.warn` (or a small internal `logger` shim) so they're observable.
- `as never` cast on `Readable.fromWeb(res.body as never)` — needs a comment or a proper type
- Mixed concerns OK at current size, but planning should keep parser / fetch-orchestration / utility layers cleanly separated

## Production-hardening features (the value-prop)

Capture all of these in the spec as P0 functional requirements:

- **Idle timeout** — abort if no source bytes arrive on the network for N ms (caller-configurable; resets on every chunk)
- **Total timeout** — abort if the entire multipart download exceeds N ms (caller-configurable)
- **AbortSignal propagation** — caller-provided `AbortSignal` aborts the in-flight stream cleanly
- **Progress callback** — `onProgress({bytes, elapsedMs, rateBps})` for UI feedback / monitoring
- **Cleanup-safe** — generator's `finally` block drains any unyielded parts (real GC hazard with streams), removes all listeners, unpipes source, destroys source if not already destroyed, but **keeps** the dicer 'error' listener so late-emit errors are swallowed instead of crashing the process
- **Pre-pipe listener wiring** — listeners attached BEFORE `pipe()` so early errors aren't lost
- **Custom parser callback** — caller supplies a `PartParser<T>` that decides per-part what to do (read, skip, transform); library accumulates results into `MultipartFetchResult<T>`

## Tech stack

- TypeScript 5+, strict mode + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`
- `dicer@0.3.1` as the underlying multipart-MIME parser (keep this dependency — it works in production; if dicer ever breaks, fork-and-absorb)
- `vitest` for unit + integration tests
- `tsup` for build (dual ESM/CJS + `.d.ts`)
- `eslint` 9 flat config + `prettier` 3
- pnpm 10

## Reference for project shape

`C:\Users\mhobb\WebstormProjects\_published\chronicler\` is the closest shape match: TypeScript library, vitest, tsup, eslint flat config, multi-file tsconfig, dual ESM/CJS exports. The kiln library template (`kiln/templates/library/`) is derived from chronicler stripped down for KISS — start there, don't re-derive from chronicler directly.

## Out of scope for v1 (spec-agent should add to Out of Scope)

- Generic `multipart/form-data` request-side parsing (different problem; covered by `@hapi/pez`, `@fastify/multipart`, etc.)
- Multipart streaming UPLOADS (this library only consumes responses)
- Custom parser combinators or content-type registries (use the existing `PartParser<T>` callback)
- Web-streams-only mode (Node `Readable` is fine; Web ReadableStream is converted internally via `Readable.fromWeb`)
- React/UI components for progress bars
- Built-in retry-on-network-error logic (caller can wrap `fetchAndHandleMultipart` with their own retry)

## Sprint 1 expectations

`/kiln-init` should produce, after Sprint 1:

- A buildable, importable package: `pnpm build` produces clean `dist/` with ESM + CJS + `.d.ts`
- The core public API surface (parseMultipartRelated, fetchAndHandleMultipart, streamToString, types) exported from `src/index.ts`
- A real test suite — the existing tests at `vns/portal/portal-ecia/tests/libs/streamingMultipart.test.ts` should be adapted as the starting point (operator gives the agent permission to read them)
- README.md with: install, quickstart (one curl/fetch + one parser callback example), API summary, link to source on GitHub once published
- `pnpm pack --dry-run` cleanly enumerates `dist/` + `README.md` + `LICENSE` only
- All silent catches from the reference replaced with observable patterns
- Internal architecture: `src/parseMultipartRelated.ts`, `src/fetchAndHandleMultipart.ts`, `src/types.ts`, `src/utils.ts`, `src/index.ts`

## Future GitHub release context

The `book-writer-app-v5` operator notes apply here too — the project may be released publicly. Quality bar stays high (no `any`, no silent catches, full JSDoc on exported symbols), but scope stays minimal — no extra features added speculatively for hypothetical external users.
