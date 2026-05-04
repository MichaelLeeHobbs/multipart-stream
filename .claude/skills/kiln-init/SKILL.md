---
description: Bootstrap a brand-new project from scratch with the kiln harness. Copies CLAUDE.md, standards, prompts, templates, and the /kiln-change skill into the new project; runs spec-agent (Phases 1-5) interactively; runs the planner; runs Sprint 1 (scaffold) with generator+evaluator. Use only in an empty directory or for a project that has not yet been kilned. Stops after Sprint 1 for operator review.
---

# /kiln-init

Operator-invoked skill that bootstraps a new project to use the kiln harness end-to-end.

This skill is the canonical encoding of the manual flow used to build `book-writer-app-v5` from scratch (the kiln test run on 2026-04-28).

## Sub-agent invocation discipline (READ THIS FIRST)

**Every phase below that says "spawn X" or "run X" means: use the Agent tool (`subagent_type: 'general-purpose'`) to launch a sub-agent. Do NOT execute the phase work inline in the parent session.**

Why: each phase does many file reads/writes/bash calls. Inline execution forces the operator to approve each tool individually (50-200+ prompts per `/kiln-init` run). Sub-agent execution requires only one Agent-tool approval per phase; the sub-agent runs autonomously inside that scope and returns a summary.

Concrete pattern for every "spawn X" step:

1. Build a self-contained prompt for the sub-agent that includes: the contract reference (e.g., `kiln/prompts/spec-agent.md` Phase N), all relevant file paths, the standards SHA-256, the expected output, and instructions to reply ≤200 words summarizing what was done.
2. Call the Agent tool with that prompt and `subagent_type: 'general-purpose'`.
3. Wait for the sub-agent to return. Read its summary.
4. Spot-check the artifacts it wrote (don't blindly trust the summary).
5. Proceed to the next phase only after the current sub-agent completes.

The ONLY work that should happen inline in the parent session is: orchestration (deciding which sub-agent to spawn next), reading small artifacts to inform the next sub-agent's prompt, and brief status updates to the operator.

If a phase explicitly says "interactive" (e.g., spec-agent Phase 1 SPECIFY), the parent session asks the operator the questions directly — that's the one exception.

## When to use

- Starting a brand-new application
- Operator is ready to spend a few hours interactively (Phases 1-5 of spec-agent are conversational)
- The kiln toolkit at `C:\Users\mhobb\WebstormProjects\kiln\` is up to date

## When NOT to use

- The directory already has code or specs (use `/kiln-retrofit` instead)
- The operator only wants to add a feature to an existing kilned project (use `/kiln-change`)
- The target stack is not one of the supported templates in `kiln/templates/`. Currently supported: `app/` (Hono + Drizzle + MUI + pnpm) and `library/` (TypeScript published library — tsup + vitest + dual ESM/CJS). For anything else, refuse and recommend extending `kiln/templates/` first.

## Inputs

The user invokes optionally with a project name:

```
/kiln-init my-new-app
/kiln-init                  # no arg — ask the user
```

The current working directory must be near-empty before scaffolding. The skill allows a small set of pre-staging files (see Phase 1).

## Phase 1 — Validate the working directory

1. **Allowed pre-existing entries** (skip but don't refuse):
   - `.git/`, `.gitignore`
   - `README.md`
   - `LICENSE`
   - `.claude/skills/kiln-init/` — the skill itself, when pre-staged so the operator can invoke `/kiln-init` here
   - `BRIEF.md` or `GOAL.md` — operator-staged "what this project is" doc to feed into Phase 4
   - `.kiln/` — any pre-staged kiln metadata
2. **Refuse on anything else.** Print: "Directory has unrecognized files — `/kiln-init` requires a clean slate (allowed: `.git/`, `.gitignore`, `README.md`, `LICENSE`, `.claude/skills/kiln-init/`, `BRIEF.md`/`GOAL.md`, `.kiln/`). Move them aside, or run `/kiln-retrofit` if this is an existing project."
3. Confirm the kiln source path exists at `C:\Users\mhobb\WebstormProjects\kiln\` and contains the subfolders `prompts/`, `standards/`, `templates/app/`, `templates/library/`, `skills/kiln-change/` (i.e., `<KILN_SRC>/prompts/`, `<KILN_SRC>/standards/`, etc.). Refuse if any are missing.
4. If `BRIEF.md` or `GOAL.md` exists, READ IT before Phase 2 — the operator pre-staged the project intent for spec-agent.

## Phase 2 — Capture project basics

If the user provided a project name as an argument, use it. Otherwise ask:

> "Project name (kebab-case, becomes the directory name and pnpm workspace name)?"

Then ask up to **2** more grouping questions (multiple choice, recommended answer):

- **Project type:**
  - `(a) App` — full-stack web app (Hono server + Vite/React/MUI client + Postgres + pnpm workspace). Uses `templates/app/`.
  - `(b) Library` — published TypeScript library (tsup dual-emit + vitest + single src/ tree). Uses `templates/library/`.
  - `(c) Other — explain` — refuse and recommend extending `kiln/templates/` first.
- **Project location:** `(a) cwd (already-staged directory)` / `(b) C:\Users\mhobb\WebstormProjects\<name>` (recommended for fresh init) / `(c) other — specify`

If a `BRIEF.md`/`GOAL.md` was found in Phase 1, infer (a) vs (b) from its contents and confirm with the operator instead of asking blind.

## Phase 3 — Copy the kiln toolkit into the new project

Add to the new project root (additively — don't overwrite operator-staged `.git/`, `.gitignore`, `README.md`, `LICENSE`, `BRIEF.md`/`GOAL.md`):

**Common to both project types:**
- `CLAUDE.md` — generated from `kiln/CLAUDE.md` template, with project name + description substituted
- `kiln/standards/architecture.md`, `error-handling.md`, `api-conventions.md`, `coding.md`, `testing.md` — copied verbatim from upstream `<KILN_SRC>/standards/`
- `kiln/prompts/` — copy from upstream `<KILN_SRC>/prompts/{planner,generator,evaluator,spec-agent,orchestrator,evaluator-playwright}.md`
- `.claude/skills/kiln-change/SKILL.md` — the change skill travels with the project
- `.claude/skills/kiln-resume/SKILL.md` — the resume skill travels with the project (operator runs sprints 2+ via this)
- `.claude/settings.json` — copy from `kiln/templates/<app|library>/settings.json` (the chosen project type's variant). Includes `StopFailure` + `PreCompact` hooks AND a permission allowlist for common safe tools (Read/Edit/Write/Agent/git status/pnpm/etc.) so sub-agent runs don't trigger 50+ approval prompts. Operator can edit later via `update-config` skill.
- `kiln/spec/` — empty; spec-agent fills it
- `kiln/sprints/` — empty; planner fills it

**App-type projects (templates/app/):**
- Copy `kiln/templates/app/{shared,server,client}/` into the project
- `.gitignore` — `.env`, `.data/`, `node_modules/`, `dist/`, `.claude/settings.local.json`, `.claude/logs/`
- `.env.example` — `DB_PORT`, `SERVER_PORT`, `CLIENT_PORT`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `LOG_LEVEL`, `NODE_ENV`
- `package.json` — pnpm workspace root with `dev` / `dev:up` / `db:push` / `test` / `lint` / `typecheck` scripts (sprint 1 generator finalizes)
- `pnpm-workspace.yaml` — `client` + `server` packages

**Library-type projects (templates/library/):**
- `package.json` — derived from `kiln/templates/library/package.json.template` with placeholders substituted (`<NAME>`, `<DESCRIPTION>` from BRIEF.md if present, `<AUTHOR>` from `git config user.name` + email, `<REPO_URL>` left empty if not asked — operator fills later)
- `tsconfig.base.json`, `tsconfig.json`, `tsconfig.build.json` — copied verbatim
- `tsup.config.ts`, `vitest.config.ts`, `eslint.config.mjs`, `.prettierrc.json` — copied verbatim
- `.gitignore` — copied from `kiln/templates/library/.gitignore.template` (rename, drop the `.template` suffix)
- `src/index.ts` — single line: `export {};` (sprint 1 generator replaces with real exports)
- `tests/index.test.ts` — placeholder smoke test that imports `../src/index.ts` and asserts true (so `pnpm test` is green out of the box)

Compute the SHA-256 of concatenated `kiln/standards/*.md` and remember it for sub-agent reports.

## Phase 4 — Spec-agent Phase 1: SPECIFY (interactive, ~30 min)

Spawn spec-agent following `<project>/kiln/prompts/spec-agent.md` Phase 1 contract. Agent asks the operator about objective, user stories, requirements. Operator answers up to 3 questions per round. Output: `kiln/spec/spec.md`.

DO NOT proceed past this phase until the operator confirms the spec looks right. The spec is the foundation — getting it wrong cascades.

## Phase 5 — Spec-agent Phase 2: CLARIFY (interactive, ~15 min)

Spawn spec-agent Phase 2. Scans 11 categories of ambiguity, asks up to 5 follow-up questions, integrates answers into `kiln/spec/spec.md`.

## Phase 6 — Spec-agent Phase 3: PLAN (mostly autonomous, ~10 min)

Spawn spec-agent Phase 3 with `thinking_effort: xhigh`. Produces `kiln/spec/data-model.md`, `kiln/spec/api.md`, `kiln/spec/ui.md`, `kiln/spec/architecture.md`, `kiln/spec/design.md`, `kiln/spec/test-plan.md`.

Spot-check the outputs after the agent returns. If anything is conspicuously wrong (e.g., `design.md` defaulted to "modern minimal" instead of picking a named aesthetic), fix it inline before proceeding.

## Phase 7 — Spec-agent Phase 4: VALIDATE (automated, ~2 min)

Run the validation checklist from `kiln/prompts/spec-agent.md`. If anything fails, go back to the relevant phase. Don't proceed until checklist is clean.

## Phase 8 — Spec-agent Phase 5: DOMAIN REVIEW (3 parallel personas, ~10 min)

Spawn 3 parallel sub-agents (Architect, Security-OWASP, Domain Expert) per `kiln/prompts/spec-agent.md` Phase 5. Each writes `kiln/spec/review-<persona>.md` with adversarial findings.

After all 3 return, spawn a merge agent to apply Action Rules 1-4 (auto-apply convergent + clear-cut findings) and surface Action Rules 5-6 (judgment calls, conflicts) to the operator. Operator picks resolutions for judgment calls. Update `kiln/spec/spec.md` with the `## Domain Review Applied` section.

Then spawn a downstream-sync agent to propagate the new FRs into `data-model.md`, `api.md`, `ui.md`, `test-plan.md` (mirror `/kiln-change` Phase 5).

## Phase 9 — Planner

Spawn the planner agent following `kiln/prompts/planner.md`. Produces `kiln/sprints/plan.json` with all sprints needed to ship the spec.

Spot-check sprint count and Sprint 1 success criteria. The expectation differs by project type:
- **App:** Sprint 1 must include "boots end-to-end with `pnpm dev:up`" + Postgres healthcheck + dashboard route renders empty state
- **Library:** Sprint 1 must include "`pnpm build` produces dist/index.{js,cjs,d.ts}" + a representative public API exposed from `src/index.ts` + at least one real unit test (not just the placeholder)

## Phase 10 — Sprint 1 (generator + evaluator)

Spawn the generator following `kiln/prompts/generator.md` for sprint id=1. The Sprint 1 generator MUST produce:

**App-type Sprint 1 deliverables:**
- A running scaffold (server + client + Postgres via docker-compose)
- All v1 schema in `db/schema.ts` (declared, even if unused this sprint)
- `README.md` (operator-facing — separate from CLAUDE.md which is AI-facing)
- `.env.example` finalized
- A passing test suite (sprint 1's own tests + the smoke test for `pnpm dev:up`)

**Library-type Sprint 1 deliverables:**
- A buildable, importable package: `pnpm build` produces a clean `dist/` with both ESM and CJS + `.d.ts`
- The core public API surface from the spec exported from `src/index.ts` with proper types (no `any`, no missing JSDoc on exported symbols)
- `README.md` with: install instructions, quick-start example, API summary, link to kiln/spec/spec.md (operator-facing)
- A real test suite covering the happy path of every exported symbol — not just the placeholder
- `pnpm check` passes (lint + typecheck + test)
- `pnpm pack --dry-run` cleanly enumerates `dist/` + `README.md` + `LICENSE` (no stray test or source files leaking into the published artifact)

After generator returns, spawn the evaluator following `kiln/prompts/evaluator.md`. Step 0 regression gate runs the new tests. Verdict must be PASS or PASS_WITH_ISSUES with all axes ≥ 2.

If verdict is FAIL: run fix-loop (max 3 iterations). After 3 failures, escalate to operator.

## Phase 11 — Stop and summarize

After Sprint 1 PASSes, **stop**. Don't auto-run sprints 2+. Reasons:
- The operator should verify the scaffold by running it before continuing
- The operator may want to adjust the plan based on what Sprint 1 surfaced
- Sprints 2+ are run one at a time via `/kiln-resume` (installed in the project's `.claude/skills/` during Phase 3)

Reply to the operator with:
- Project name + location
- Spec doc summary (FR count, user story count, sprint count from plan.json)
- Sprint 1 verdict + test count
- Sprint 1 known issues (if any)
- Run instructions:
  - **App:** `cd <path> && pnpm dev:up`
  - **Library:** `cd <path> && pnpm build && pnpm test`
- Suggested next step: verify the scaffold, then `/kiln-resume` to run Sprint 2

## Critical rules

- **Auto-proceed inside sub-agents.** Operator only answers spec-agent's interactive questions in Phases 4-5 and any judgment calls from Phase 8 merge. All other sub-agents (planner, generator, evaluator, downstream-sync, domain personas) run autonomously.
- **Standards re-injection at every sub-agent boundary.** Pass the SHA-256 hash from Phase 3 in each prompt.
- **Stop after Sprint 1.** Don't get clever and keep running. Operator review is non-negotiable.
- **Single source of truth for ports.** All ports in `.env`. Never hardcode.
- **No CMMC/HIPAA/FedRAMP scaffolding.** Out of scope per kiln charter.

## Anti-patterns to refuse

- Initializing in a non-empty directory — refuse, recommend `/kiln-retrofit`
- Targeting a stack that has no template (anything other than Hono+Drizzle+MUI+pnpm today) — refuse, ask operator to extend `kiln/templates/` first
- Running all sprints autonomously — refuse, stop after Sprint 1
- Skipping Phase 5 domain review for "small" projects — refuse; the adversarial review consistently surfaces real architectural gaps (validated 30 FR-DR-### additions on book-writer-app-v5)

## Reference

The `book-writer-app-v5` project at `C:\Users\mhobb\WebstormProjects\book-writer-app-v5\` is the canonical reference of what `/kiln-init` produces (Sprints 1-10 ran, Sprint 11-12 added via `/kiln-change`). Its `kiln/sprints/plan.json` + `kiln/spec/` are the shape your output should match.
