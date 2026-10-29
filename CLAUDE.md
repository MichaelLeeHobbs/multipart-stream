# @ubercode/multipart-stream

A focused TypeScript library for consuming `multipart/related` HTTP responses as a typed async-iterator of streaming parts, with production-grade timeout/abort/cleanup hygiene.

## Project layout

```
multipart-stream/
├── CLAUDE.md           # this file (AI-facing)
├── README.md           # operator-facing (install, quickstart, API)
├── docs/spec/          # spec, data-model, api, architecture, test-plan, design reviews
├── docs/standards/     # architecture, coding, error-handling, api-conventions, testing
├── src/                # parseMultipartRelated, fetchAndHandleMultipart, types, utils, index
├── tests/              # vitest unit + integration
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
- **Dependency:** `streamsearch@1.1.0` for boundary matching; the multipart parser is private TypeScript in `src/internal/multipart-parser.ts`.
- **Pkg manager:** pnpm 10
- **Module shape:** dual ESM + CJS, `.d.ts`, `sideEffects: false`, single entry `src/index.ts`

## Conventions

Read the full conventions in `docs/standards/` — every file there is mandatory.

- `docs/standards/architecture.md` — layering for a small library (parser / fetch-orchestration / utility)
- `docs/standards/error-handling.md` — silent catch banned; replace with observable patterns
- `docs/standards/api-conventions.md` — naming, return shapes, options-object pattern
- `docs/standards/coding.md` — TS strict, naming, imports
- `docs/standards/testing.md` — unit + integration split

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
npm pack --dry-run   # verify publish surface (pnpm@10.0.0 pack has no --dry-run)
```

## Public API surface (finalized in docs/spec/api.md)

- `parseMultipartRelated(res, opts)` — async-generator over parts; cleanup-safe
- `fetchAndHandleMultipart(url, options)` — `fetch` wrapper with idle/total timeout, AbortSignal, progress
- `streamToString(readable, encoding?)` — collect a small text part
- Utility helpers: `extractBoundary`, `flattenPartHeaders`, `flattenHeaderValue`, `deriveNameFromContentId` (some may stay internal — spec decides)
- Types: `StreamingMultipartPart`, `PartParser<T>`, `ParseMultipartOptions`, `MultipartFetchResult<T>`, `MultipartHandlerOptions<T>`

## What this project is NOT

- Not a `multipart/form-data` request-side parser (different problem; use `@hapi/pez`, `@fastify/multipart`)
- Not a multipart UPLOAD library (this consumes responses only)
- Not a content-type registry or parser-combinator framework — caller supplies a `PartParser<T>` callback
- Not Web-Streams-only — accepts Node `Readable`, converts Web `ReadableStream` via `Readable.fromWeb`
- Not a UI library — no React components, no progress bars
- Not a retry-on-network-error library — caller wraps with their own retry

The library was extracted from a reference implementation at `vns/portal/portal-ecia/src/libs/streamingMultipart.ts`. See `docs/spec/spec.md` for the full scope.
