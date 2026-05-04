# Domain Review — Library Domain Expert persona

**Adversarial framing applied:** "What's standard for a published TypeScript library on npm in 2026 that this spec is silently missing?"

Reviewer scope: package shape, publish hygiene, semver/release discipline, type-export mechanics, repository hygiene, dependency policy, CI/CD expectations. Architecture and security findings are out of scope for this persona.

Cross-checked against staged repo state at `C:\Users\mhobb\WebstormProjects\_published\multipart-stream\` (LICENSE absent, README absent, CHANGELOG absent, SECURITY.md absent, .github/ absent, src/index.ts is an 11-byte placeholder).

## Findings

### F-D-001 — LICENSE file is referenced but not staged

**Severity:** Critical
**Type:** Toolchain-gap
**Location:** Project root (expected at `LICENSE`); referenced from `package.json#files` (line 27) and `spec.md#NFR-008`.

**Gap:** `package.json#files` declares `["dist", "README.md", "LICENSE"]` and `NFR-008` asserts `pnpm pack --dry-run` MUST enumerate exactly `dist/`, `README.md`, `LICENSE`, `package.json`. Neither `LICENSE` nor `README.md` exists in the repo today (only `BRIEF.md` and the kiln scaffolding). `pnpm pack` will succeed but emit a warning and ship without a LICENSE; npm will display "License: MIT" from the manifest while the tarball has no actual license text. For a public release that's both a legal exposure (no copyright/permission notice attached to the distributed code) and a reviewer red flag. The spec mentions "License: MIT" in BRIEF but never lists "stage a LICENSE file with the MIT text and the copyright holder" as a deliverable.

**Recommendation:** Add an explicit FR or NFR mandating the file. Propose `FR-DR-D-001 The repository MUST contain a top-level LICENSE file with the MIT license text and copyright line "Copyright (c) <year> Michael Hobbs"; the file MUST be present BEFORE the first publish and NFR-008's pack-manifest test MUST fail when it is absent.` Add a Sprint 1 task: "stage LICENSE."

**Action rule:** 1

---

### F-D-002 — README.md is required by NFR-010 but absent and unscoped

**Severity:** Critical
**Type:** Documentation-gap
**Location:** Project root (expected at `README.md`); `spec.md#NFR-010`, `package.json#files`, `BRIEF.md#Sprint 1 expectations`.

**Gap:** NFR-010 says "README.md ships with: install, quickstart with one fetch + one parser callback example, full API summary, link to spec." That's a one-line aspiration — no acceptance criteria, no checklist for what a 2026 published TS library README must include. Modern minimum: package badge (npm version), install snippet (`pnpm add @ubercode/multipart-stream`), 30-second quickstart, error-class quick reference, license note, link to GitHub repo. Without these explicit, T-050 ("grep README.md for required sections") has nothing concrete to grep for, and the test as defined is undefined behavior.

**Recommendation:** Tighten NFR-010 into a checklist. Propose `NFR-DR-D-002 README.md MUST contain the following sections by H2 heading: "Install", "Quickstart", "API", "Error handling", "Compatibility" (Node version + supported module formats), "License" (MIT). Each section MUST be non-empty. The "Install" section MUST show "pnpm add @ubercode/multipart-stream". The "Quickstart" section MUST show one runnable example using fetchAndHandleMultipart. T-050 SHOULD be updated to grep for each H2 by name.`

**Action rule:** 2

---

### F-D-003 — `dicer` has no types on DefinitelyTyped; spec silently punts the ambient `.d.ts` to Sprint 1

**Severity:** Critical
**Type:** Missing-FR
**Location:** `spec.md#NFR-001`, `architecture.md#5.1`, `data-model.md#2.5` (`DicerHeadersRaw`).

**Gap:** `dicer@0.3.1` has no published types and `@types/dicer` does not exist on DefinitelyToday. With `strict: true` + `noImplicitAny`, every `import Dicer from 'dicer'` and every `dicer.on('part', ...)` callback will fail to compile until an ambient declaration is supplied. Architecture references "dicer's per-part Readable" (§5.3) and data-model defines `DicerHeadersRaw` (§2.5) — both presume types exist. Nothing in the spec says: write `src/internal/dicer.d.ts` (or `types/dicer.d.ts`) with module-augmenting declarations, ship it inside the package or just include it for build, and document the typing strategy. This is the #1 thing that bites an extractor on day one and there is no FR for it.

**Recommendation:** Add an FR. Propose `FR-DR-D-003 Because dicer has no published types and no @types/dicer package, the library MUST ship an ambient module declaration at src/internal/dicer.d.ts (NOT published; declarationDir excludes it from the dist bundle, BUT the runtime types it backs MUST be re-exported via the proper public types in data-model). The declaration MUST cover at minimum: default export class Dicer extends Writable; .on('part', cb: (part: Readable & { headers: DicerHeadersRaw }) => void); .on('finish', cb: () => void); .on('error', cb: (err: Error) => void). Sprint 1 acceptance criterion: "pnpm typecheck" passes with the declaration in place; removing it causes typecheck to fail.`

**Action rule:** 1

---

### F-D-004 — `package.json#repository.url` is empty; no GitHub repository URL set

**Severity:** High
**Type:** Convention-gap
**Location:** `package.json` lines 8-11.

**Gap:** `"repository": { "type": "git", "url": "" }`. npm's package page renders a "Repository" link from this field; with empty URL, the page shows "Repository: (none)" which is the universal "abandoned package" signal. Also breaks `npm view @ubercode/multipart-stream repository`, breaks GitHub's "Used by" detection, breaks `provenance: true` (which requires a discoverable repo URL). README "link to spec on GitHub" mentioned in BRIEF#Sprint 1 expectations becomes impossible without this field. Spec is silent on whether a GitHub repo will exist for v1.

**Recommendation:** Propose `FR-DR-D-004 Before the first publish, package.json#repository.url MUST be set to the canonical GitHub URL ("git+https://github.com/<org>/<repo>.git") and package.json#bugs.url MUST be set to the issue tracker. NFR-008's pack-manifest test SHOULD also assert these fields are non-empty.`

**Action rule:** 1

---

### F-D-005 — No semver / changelog / release discipline defined for a 0.x library

**Severity:** High
**Type:** Missing-NFR
**Location:** `spec.md` (no section), `package.json#version` (`0.1.0`).

**Gap:** The package is `0.1.0`. Strict semver permits "anything goes" pre-1.0, but every consumer expects SOME discipline. The spec never says: (a) what counts as a breaking change for this library, (b) how breaking changes are signaled (CHANGELOG, GitHub release notes, release-please?), (c) the path to 1.0, (d) what 0.x means as a stability promise to consumers. `version:major/minor/patch` scripts exist in package.json but there is no documented rubric for which to invoke when. For a library being extracted from a production codebase (so consumers may already be planning to depend on it), this is a credibility gap.

**Recommendation:** Add an NFR. Propose `NFR-DR-D-005 The repository MUST ship a CHANGELOG.md (Keep-a-Changelog format) updated for every published version. While at 0.x, every release MUST document breaking changes under "BREAKING CHANGES"; minor bumps add features; patch bumps fix bugs. The 1.0 release criterion MUST be documented (suggested: "the public API has shipped unchanged for 30 days and no consumer has reported a breaking issue"). The spec MAY remain agnostic about release-please vs changesets vs hand-edited CHANGELOG, but MUST commit to one.`

**Action rule:** 2

---

### F-D-006 — No CI/CD pipeline scoped; spec doesn't say whether GitHub Actions are in or out

**Severity:** High
**Type:** Toolchain-gap
**Location:** `spec.md` (no mention), repo `.github/` directory does not exist.

**Gap:** Modern published libraries on npm in 2026 ship CI: PR checks (lint, typecheck, test, coverage), publish workflow (gated on tag push), and ideally `provenance: true` for supply-chain attestation. The spec mandates `pnpm check` passes (NFR-009) and coverage ≥90% (NFR-007), but never says where this is enforced. If the answer is "operator runs it locally" — that's a fine v1 stance, but spec should say so explicitly. Otherwise it's a silent gap that a reviewer will flag on first look.

**Recommendation:** Propose `NFR-DR-D-006 The repository MUST include a GitHub Actions workflow at .github/workflows/ci.yml that runs "pnpm install --frozen-lockfile && pnpm check && pnpm build" on every push and PR to main, on Node 20.x and 22.x matrix. A separate .github/workflows/publish.yml MUST run on tag push (v*) and execute "pnpm publish --access public --provenance" — provenance:true is required for 2026 supply-chain hygiene.` If CI is deliberately deferred, spec MUST add a line to Out of Scope: "v1 ships without CI; quality gates run locally via pnpm check pre-publish."

**Action rule:** 2

---

### F-D-007 — Dual ESM/CJS produces dual error-class identities; `instanceof` breaks across consumers mixing module formats

**Severity:** High
**Type:** Convention-gap
**Location:** `api.md` §"Discriminating errors at runtime" (claims it works), `architecture.md#6` (dual-emit table), `spec.md#NFR-012`.

**Gap:** `api.md` line 483 asserts: "instanceof works across import/require boundaries because there is exactly one entry point bundle per module format (no duplicated class identities via deep imports)." This is **wrong** in the dual-emit case. If consumer A imports via ESM (`dist/index.js`) and consumer B requires via CJS (`dist/index.cjs`), they each get their own copy of `MultipartIdleTimeoutError` constructor. An error thrown from a library function imported via ESM and caught by code that did `require('@ubercode/multipart-stream')` will fail `instanceof MultipartIdleTimeoutError` even though the names match. This is a well-known dual-emit footgun (see `node-fetch` v3's writeup, `chalk`'s ESM-only switch). The library's tests reference T-052 ("CJS+ESM consumer sanity") but the test description punts: "live instanceof cross-bundle is asserted via single-bundle re-import only."

**Recommendation:** Either acknowledge the limitation or fix it. Propose `FR-DR-D-007 The api.md note "instanceof works across import/require boundaries" MUST be replaced with: "instanceof discrimination works WITHIN a single module format. Consumers that mix ESM and CJS imports of @ubercode/multipart-stream (e.g. an ESM app that loads a CJS dependency that itself imports the library via require) MAY observe instanceof returning false across boundaries; in that case, branch on err.name === 'MultipartIdleTimeoutError' instead." Additionally, NFR-DR-D-007 MUST require that every error class has a stable readonly instance name property AND a static readonly type-tag property, AND README MUST document the err.name fallback in the Error handling section.`

**Action rule:** 2

---

### F-D-008 — `engines.node: ">=20"` is over-broad; spec doesn't pick a stable Node 20 baseline

**Severity:** Medium
**Type:** Convention-gap
**Location:** `package.json#engines.node`, `spec.md#NFR-003`.

**Gap:** `>=20` means any Node ≥20.0.0 satisfies, but `Readable.fromWeb` was unstable until 20.x and several `node:stream` fixes landed in 20.10+. `AbortSignal.timeout` and `AbortSignal.any` (used in composition recipes) became stable at different points. Pinning the floor at `>=20.0.0` invites bug reports from users on 20.0.x where the stream/abort behavior differs subtly. 2026 best practice is to pick a stable LTS-ish floor: `>=20.18.0` (last 20.x LTS as of early 2026) or `>=22.0.0` if the project will only support active LTS. Spec is silent — neither version was researched against the API surface.

**Recommendation:** Propose `NFR-DR-D-008 engines.node MUST be set to ">=20.18.0" (last Node 20 LTS) OR justified at "20.0.0" with a comment in spec.md citing the specific APIs the library uses and confirming each was stable at 20.0. The pack-manifest test SHOULD assert engines.node matches the spec's chosen value exactly.` Aim for the higher floor unless there's a real reason to keep the wider range.

**Action rule:** 2

---

### F-D-009 — `package.json#type: "module"` combined with `main: "./dist/index.cjs"` is unusual

**Severity:** Medium
**Type:** Convention-gap
**Location:** `package.json` lines 12-15.

**Gap:** Setting `"type": "module"` makes every `.js` file in the package an ESM file. The package then declares `"main": "./dist/index.cjs"` (CJS) — legal but confusing. Legacy consumers that don't read `exports` (older bundlers, ts-node configurations) follow `main` to the `.cjs` file, which works. Consumers reading `exports` get either ESM or CJS based on conditions, which works. The mismatch is not a bug, but it's a head-scratcher and `arethetypeswrong/cli` (`attw`) flags it as "False CJS" suspicion. Modern libraries either: (a) drop `"type": "module"` for dual-emit and let `.cjs`/`.js` extensions disambiguate, or (b) keep `"type": "module"` and set `"main": "./dist/index.js"` (ESM). Spec doesn't address this.

**Recommendation:** Propose `FR-DR-D-009 The published package MUST pass attw (arethetypeswrong/cli) with no errors. Specifically: tsup's --cjsInterop mode emits dist/index.cjs as CJS regardless of the package "type"; the "main" field SHOULD point to dist/index.js (ESM) to align with "type": "module", and the "exports.require" condition picks up the .cjs path for require() consumers. Add an automated check: pnpm dlx @arethetypeswrong/cli --pack && [pass]. Add this as a CI gate.`

**Action rule:** 2

---

### F-D-010 — `verbatimModuleSyntax` not enabled; type-vs-value import discipline is implicit

**Severity:** Medium
**Type:** Convention-gap
**Location:** `tsconfig.base.json` (does not set `verbatimModuleSyntax`), `coding.md` line 33 ("Prefer inline type imports").

**Gap:** TypeScript 5.0 added `verbatimModuleSyntax: true` which forces every type-only import to use `import type` and every type-only re-export to use `export type`. Without it, the compiler is free to elide type imports silently, which is forgiving but masks errors when a consumer reads the emitted `.d.ts` and finds runtime values referenced through type-only paths (or vice versa — runtime constants that disappear from the emitted JS because they look type-only). For a published library where the `.d.ts` IS part of the public contract, `verbatimModuleSyntax` is the right default in 2026. Coding standard says "prefer inline type imports" but the compiler isn't enforcing it.

**Recommendation:** Propose `NFR-DR-D-010 tsconfig.base.json MUST set "verbatimModuleSyntax": true so that every import/export is unambiguous about value vs type. Combined with the existing strict mode, this catches re-export mistakes at compile time rather than at consumer runtime. The kiln/standards/coding.md "Prefer inline type imports" rule becomes enforceable.`

**Action rule:** 2

---

### F-D-011 — `sideEffects: false` claim is not validated against dicer's CJS shape

**Severity:** Medium
**Type:** Missing-NFR
**Location:** `package.json#sideEffects` (line 30), `spec.md#NFR-002`, `architecture.md#6`.

**Gap:** `sideEffects: false` tells bundlers (webpack, rollup, esbuild) that they may tree-shake any unused export from this package. This is true of the library's own code (pure types + classes + functions), but `dicer` is a 2021-vintage CJS module with `EventEmitter` subclasses; it has its own `package.json` without `sideEffects: false`, and a CJS module is treated as side-effect-ful by default. When a consumer imports only `extractBoundary` from this library, modern bundlers SHOULD tree-shake `parseMultipartRelated` and therefore the dicer dependency — but only if the library's `sideEffects: false` actually holds. The spec asserts it without testing that an `import { extractBoundary } from '@ubercode/multipart-stream'` final bundle does not contain dicer.

**Recommendation:** Propose `NFR-DR-D-011 An automated test MUST validate that "import { extractBoundary } from '@ubercode/multipart-stream'" produces a bundle (via esbuild --bundle --metafile) that does NOT contain "dicer". If the test fails, either (a) sideEffects: false is wrong for this library and must be removed, OR (b) the import path that pulls dicer must be refactored. Add as T-NEW-1 to the test plan.`

**Action rule:** 2

---

### F-D-012 — No explicit dependency-EOL operational policy for `dicer`

**Severity:** Medium
**Type:** Missing-NFR
**Location:** `spec.md#NFR-004`, `spec.md` Out of Scope ("Dicer fork / replacement").

**Gap:** Spec pins `dicer@0.3.1` and notes the "fork-and-absorb plan" if dicer breaks. What's missing: a stated trigger and a stated owner. "If dicer breaks under a future Node release" is vague — does that include: (a) npm yanking dicer 0.3.1 (registry-side removal — `pnpm install` would then fail for new installs of THIS library); (b) a CVE published against dicer that npm audit flags; (c) a new Node major that breaks dicer's `Streams2` shim? Without the trigger documented, the spec is silent on the operational risk that an unmaintained dependency can take a published library offline overnight. There is no NFR for "the package MUST remain installable from npm for the lifetime of v1."

**Recommendation:** Propose `NFR-DR-D-012 The repository MUST document, in a top-level DEPENDENCIES.md or in spec.md "Dependency policy" section: (a) the explicit triggers for fork-and-absorb of dicer ("npm yank, CVE rated High+, Node major-version breakage with no upstream patch in 30 days"), (b) the absorption plan (copy dicer@0.3.1 source into src/internal/dicer/, retain MIT license, treat as own code), and (c) the responsible maintainer. Without this, "fork-and-absorb later" is a wish, not a plan. Acceptance criterion: a one-page DEPENDENCIES.md exists before v1.0.`

**Action rule:** 2

---

### F-D-013 — `package.json#keywords` is empty; npm discovery suffers

**Severity:** Low
**Type:** Convention-gap
**Location:** `package.json#keywords` (line 5).

**Gap:** `"keywords": []`. The whole reason this library exists per BRIEF.md is that the multipart/related space on npm is empty — but with no keywords, this library will not appear in npm search for "multipart", "multipart-related", "multipart-parser", "streaming", etc. Discoverability is the value-prop here.

**Recommendation:** Propose `NFR-DR-D-013 package.json#keywords MUST contain at minimum: ["multipart", "multipart-related", "multipart-parser", "streaming", "fetch", "async-iterator", "rfc-2046", "node"]. The pack-manifest test MAY assert non-empty keywords.`

**Action rule:** 4 (minor; can be added as a single line in NFR-008's existing assertions).

---

### F-D-014 — No SECURITY.md for a public-release library

**Severity:** Low
**Type:** Documentation-gap
**Location:** Project root (expected at `SECURITY.md`); `spec.md` no mention.

**Gap:** Public npm libraries in 2026 are expected to ship a `SECURITY.md` documenting how to report vulnerabilities (private email or GitHub Security Advisories link) and the supported versions for security patches. GitHub flags the absence in its repo "community standards" check; security-conscious consumers grep for it; OpenSSF Scorecard penalizes its absence. Spec is silent.

**Recommendation:** Propose `NFR-DR-D-014 The repository MUST ship a top-level SECURITY.md documenting: (a) how to report a vulnerability (email or GitHub Security Advisories private report link), (b) the supported version line (initially "v0.x: latest only"). The file MAY be templated from GitHub's default; content can be 10 lines.`

**Action rule:** 4

---

### F-D-015 — No `attw` (arethetypeswrong) gate; dual-types resolution is asserted but never tested

**Severity:** Medium
**Type:** Toolchain-gap
**Location:** `architecture.md#6` (dual ESM/CJS+`.d.ts`), `spec.md#NFR-002`, `spec.md#NFR-012`, test-plan T-040.

**Gap:** T-040 asserts the three files exist (`dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`) and that `package.json#exports` is shaped right. That's necessary but not sufficient. The actual test for "does this package's types resolve correctly under TypeScript's `node16` / `nodenext` / `bundler` moduleResolution modes for both the ESM and CJS consumer entry?" is `arethetypeswrong/cli` (`attw`). Without it, the library can ship with broken types resolution under one of the moduleResolution modes and nobody catches it until a consumer files a bug. This is the #1 thing reviewers nitpick on a fresh-published TS library in 2026.

**Recommendation:** Propose `NFR-DR-D-015 A CI gate MUST run "pnpm dlx @arethetypeswrong/cli --pack" and exit 0 with no errors. The package MUST resolve types correctly under all four module-resolution scenarios attw checks (node10, node16-cjs, node16-esm, bundler). Add as T-NEW-2 in the test plan, replacing or augmenting T-040.`

**Action rule:** 2

---

## Findings summary

| Severity | Count |
|----------|-------|
| Critical | 3 (F-D-001, F-D-002, F-D-003) |
| High     | 4 (F-D-004, F-D-005, F-D-006, F-D-007) |
| Medium   | 6 (F-D-008, F-D-009, F-D-010, F-D-011, F-D-012, F-D-015) |
| Low      | 2 (F-D-013, F-D-014) |
| **Total** | **15** |

## Action-rule legend (per kiln/prompts/spec-agent.md lines 347-365)

- **1** = MUST add to spec before Phase 6 PLAN
- **2** = SHOULD add to spec; defer to pre-publish if Sprint scope is locked
- **3** = MAY add (operator preference)
- **4** = Trivial — can be added as a one-liner without re-running validation
- **5** = Document as Out of Scope
- **6** = Reject (finding does not apply)
