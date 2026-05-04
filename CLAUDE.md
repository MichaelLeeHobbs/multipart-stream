# @ubercode/multipart-stream

A focused TypeScript library for consuming `multipart/related` HTTP responses as a typed async-iterator of streaming parts, with production-grade timeout/abort/cleanup hygiene.

## Project layout

```
multipart-stream/
├── CLAUDE.md           # this file (AI-facing)
├── README.md           # operator-facing (install, quickstart, API)
├── BRIEF.md            # operator-staged project intent
├── kiln/spec/               # data-model, api, ui (n/a), architecture, design, test-plan
├── kiln/standards/          # architecture, coding, error-handling, api-conventions, testing
├── kiln/sprints/            # plan.json + sprint-N-report.json + sprint-N-qa.json
├── src/                # parseMultipartRelated, fetchAndHandleMultipart, types, utils, index
├── tests/              # vitest unit + integration
├── kiln/prompts/            # planner / generator / evaluator / spec-agent contracts
├── tsconfig.{base,build,}.json   # strict TS, Node 20+
├── tsup.config.ts      # dual ESM/CJS + .d.ts
├── vitest.config.ts
├── eslint.config.mjs
└── package.json        # @ubercode/multipart-stream
```

## Stack (locked — do not switch frameworks mid-project)

- **Language:** TypeScript 5+ (strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`)
- **Runtime:** Node 20+
- **Build:** `tsup` (dual ESM/CJS bundle + `.d.ts`)
- **Test:** `vitest`
- **Lint/format:** `eslint` 9 flat config + `prettier` 3
- **Dependency:** `dicer@0.3.1` (underlying multipart-MIME parser; keep — fork-and-absorb if it ever breaks)
- **Pkg manager:** pnpm 10
- **Module shape:** dual ESM + CJS, `.d.ts`, `sideEffects: false`, single entry `src/index.ts`

## Conventions

Read the full conventions in `kiln/standards/` — every file there is mandatory.

- `kiln/standards/architecture.md` — layering for a small library (parser / fetch-orchestration / utility)
- `kiln/standards/error-handling.md` — silent catch banned; replace with observable patterns
- `kiln/standards/api-conventions.md` — naming, return shapes, options-object pattern
- `kiln/standards/coding.md` — TS strict, naming, imports
- `kiln/standards/testing.md` — unit + integration split

## Commands

```bash
pnpm install
pnpm build           # tsup → dist/index.{js,cjs,d.ts}
pnpm dev             # tsup --watch
pnpm test            # vitest run
pnpm test:watch
pnpm coverage
pnpm lint
pnpm typecheck
pnpm check           # lint + typecheck + test
pnpm pack --dry-run  # verify publish surface
```

## Public API surface (per BRIEF.md, finalized in kiln/spec/api.md)

- `parseMultipartRelated(res, opts)` — async-generator over parts; cleanup-safe
- `fetchAndHandleMultipart(url, options)` — `fetch` wrapper with idle/total timeout, AbortSignal, progress
- `streamToString(readable, encoding?)` — collect a small text part
- Utility helpers: `extractBoundary`, `flattenDicerHeaders`, `flattenHeaderValue`, `sanitizeFileName`, `deriveNameFromContentId` (some may stay internal — spec decides)
- Types: `StreamingMultipartPart`, `PartParser<T>`, `ParseMultipartOptions`, `MultipartFetchResult<T>`, `MultipartHandlerOptions<T>`

## What this project is NOT

- Not a `multipart/form-data` request-side parser (different problem; use `@hapi/pez`, `@fastify/multipart`)
- Not a multipart UPLOAD library (this consumes responses only)
- Not a content-type registry or parser-combinator framework — caller supplies a `PartParser<T>` callback
- Not Web-Streams-only — accepts Node `Readable`, converts Web `ReadableStream` via `Readable.fromWeb`
- Not a UI library — no React components, no progress bars
- Not a retry-on-network-error library — caller wraps with their own retry

See `BRIEF.md` for the extraction context (reference impl at `vns/portal/portal-ecia/src/libs/streamingMultipart.ts`) and `kiln/spec/spec.md` (after Phase 4) for the full scope.
