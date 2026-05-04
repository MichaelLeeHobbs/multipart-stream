---
description: Add a feature or change to a kilned project. Captures the change in 1-3 clarifying questions, updates spec + user stories + functional requirements, propagates the delta to data-model/api/ui/test-plan, runs the planner on the delta, then runs generator+evaluator per new sprint with up to 3 fix-loop iterations.
---

# /kiln-change

Operator-invoked skill for adding a feature or making a change to a project that was bootstrapped with `/kiln-init` (or has the same layout: `kiln/spec/`, `kiln/standards/`, `kiln/sprints/`, `CLAUDE.md`).

The change flow mirrors the initial harness — same rigor, smaller scope. **Do NOT do a full re-spec.** That's `/kiln-respec`'s future job.

## Sub-agent invocation discipline (READ THIS FIRST)

**Every phase below that says "spawn X" or "run X" means: use the Agent tool (`subagent_type: 'general-purpose'`) to launch a sub-agent. Do NOT execute the phase work inline in the parent session.**

Inline execution forces the operator to approve every individual Bash/Edit/Write call (often 50+ per phase). Sub-agent execution requires one Agent-tool approval per phase; the sub-agent runs autonomously and returns a summary. The parent session orchestrates and asks the operator the few interactive questions; sub-agents do the heavy lifting.

The exception: Phase 3 (clarifying questions) is interactive — the parent session asks them directly.

## When to use

- Adding a feature to an existing kilned project
- Making a non-trivial behavior change (anything that should produce a new test row in test-plan.md)
- Fixing a bug that requires a spec adjustment

For pure code-only fixes that don't change the spec (rename a variable, refactor a method), edit directly. Don't use this skill — it's overkill.

## Inputs

The user invokes with an optional change description:

```
/kiln-change Add DOCX export
/kiln-change                  # no arg — ask the user
```

Plus the current working directory should be a kilned project root (one with `kiln/spec/spec.md`, `kiln/standards/`, `kiln/sprints/plan.json`).

## Phase 1 — Locate the project + read context

1. Confirm cwd is a kilned project: `kiln/spec/spec.md` exists, `kiln/standards/` exists, `kiln/sprints/plan.json` exists. If any is missing, stop with a clear error: "Not a kilned project — run `/kiln-init` first or `cd` to a kilned root."
2. Read in this order (JIT — only what's needed):
   - `CLAUDE.md`
   - `kiln/standards/*.md` (ALL FIVE)
   - `kiln/spec/spec.md`
   - `kiln/sprints/plan.json` — to know the next sprint id
3. Compute SHA-256 of concatenated standards files. Hold it for sub-agent reports.

## Phase 2 — Capture the change

If the user provided an argument, use it as the initial change description. If not, ask:

> "What feature or change do you want to add? Describe in 1-3 sentences."

Then echo back what you understood in one sentence and continue.

## Phase 3 — Clarify (≤3 questions, multiple choice)

Read the existing spec.md to identify what's already there. Ask up to **3** clarifying questions that gate scope decisions. Each question is multiple-choice with a recommended answer.

Examples of useful questions:
- Priority? `(a) P0 — must have` / `(b) P1 — should have` / `(c) P2 — nice to have` (recommend P1 for most additions)
- Should this require AI involvement? `(a) yes — uses Claude SDK` / `(b) no — pure local logic`
- Should this be exposed via UI? `(a) yes — new component` / `(b) no — API only` / `(c) both`
- Affects existing data? `(a) new entity / table` / `(b) modify existing` / `(c) read-only — no schema change`

**Stop at 3 questions max.** If more are needed, the change is too big for `/kiln-change` — recommend `/kiln-respec` (when it exists) or break into multiple `/kiln-change` invocations.

If the user provided enough detail in Phase 2 to skip clarification, skip it. Don't ask theatrical questions.

## Phase 4 — Persist the change request + update spec.md

1. Determine next change-request number: `ls kiln/sprints/change-request-*.md | wc -l` + 1. Call it CR-N.
2. Write `kiln/sprints/change-request-N.md`:
   ```markdown
   # Change Request N — <short title>
   **Date:** <today>
   **Source:** /kiln-change

   ## Change description
   <user's description as captured>

   ## Clarifications
   <Q&A from Phase 3, if any>

   ## Resolved scope
   <one paragraph: what will be built, at what priority, in how many sprints estimated>
   ```
3. Update `kiln/spec/spec.md`:
   - Add new functional requirements to the FRs table with id `FR-CR-N-001`, `FR-CR-N-002`, etc. The CR-N prefix makes the change traceable.
   - Add new user stories to the User Stories section with id `US-CR-N-001` etc., each with at least one Given/When/Then acceptance criterion.
   - Add a `## Change Request N Applied` section at the bottom listing what was added (mirrors the existing `## Domain Review Applied` pattern).
   - Update `## Out of Scope` if the user explicitly said "deferred" to anything.

## Phase 5 — Propagate the delta (downstream sync)

Spawn a downstream-sync sub-agent (Agent tool, general-purpose). Its job: read the new FRs in spec.md, update `data-model.md` / `api.md` / `ui.md` / `test-plan.md` as needed.

Use this sub-agent prompt template (adapt as needed):

```
You are the downstream-sync agent for change request N. Read:
1. <project>/kiln/spec/spec.md — the new section "Change Request N Applied" lists what to propagate
2. <project>/kiln/spec/data-model.md, api.md, ui.md, test-plan.md — current state
3. <project>/kiln/standards/architecture.md, error-handling.md — invariants

Add (do not delete or rename):
- data-model.md: new entities/columns/services for FR-CR-N-### (Result types mandatory; Drizzle sketches if entity)
- api.md: new endpoints with request/response shapes; error codes
- ui.md: new components/pages/dialogs
- test-plan.md: Coverage Map row for every new acceptance criterion

Cite FR-CR-N-### in every new entry. Cap files under 800 lines if possible.
Reply under 150 words: lines added per file + 2-3 most consequential entries.
```

After it returns, spot-check the diffs. If the sync added something that contradicts a standard (e.g., a service that throws instead of returning Result), fix it inline before continuing.

## Phase 6 — Plan the delta

Spawn the planner sub-agent (Agent tool) with this prompt template:

```
You are the planner agent in delta mode for change request N. Existing project at <cwd>.

Inputs:
- <cwd>/CLAUDE.md
- <cwd>/kiln/standards/*.md (ALL)
- <cwd>/kiln/spec/spec.md (focus on `## Change Request N Applied` section)
- <cwd>/kiln/spec/data-model.md, api.md, ui.md, test-plan.md (just-updated by downstream sync)
- <cwd>/kiln/sprints/plan.json (existing — your output APPENDS to this; do not modify existing sprints)
- <cwd>/kiln/sprints/change-request-N.md (the request itself)
- C:\Users\mhobb\WebstormProjects\kiln\prompts\planner.md (your contract)

Task: produce 1-3 NEW sprints that deliver FR-CR-N-### items. Append to kiln/sprints/plan.json `sprints[]` with new ids continuing from the last existing id. Standard sprint schema applies (name/goal/userStories/functionalRequirements/successCriteria/relevantSpecDocs/technicalNotes).

Rules:
- 3-5 user stories or FRs per new sprint (tighter is fine for small changes)
- Group FR-CR-N-### items by surface area (don't fragment what shares a feature folder)
- successCriteria[] must be Playwright/curl-testable
- Do NOT renumber or modify existing sprints
- Do NOT touch totalSprints (you can update it; pick whichever — document the choice)

Reply under 200 words: # of new sprints, titles, FR-CR-N-### items per sprint.
```

After it returns, eyeball the new sprint definitions in plan.json. If any sprint's success criteria are vague, add specificity inline.

## Phase 7 — Generator + Evaluator loop per new sprint

For each new sprint added by Phase 6:

1. Spawn generator sub-agent. Use `kiln/prompts/generator.md` as the contract reference. The sprint id is the new one. Standard generator inputs apply (CLAUDE.md, kiln/standards/, plan.json, prior sprint reports — at minimum the most recent one, plus the change-request-N.md).
2. After generator returns, spawn evaluator sub-agent. Use `kiln/prompts/evaluator.md` contract. Standard 5-axis rubric, Step 0 regression gate.
3. If verdict is `PASS` or `PASS_WITH_ISSUES` (and all axes ≥ 2): proceed to next sprint.
4. If verdict is `FAIL`: run fix-loop (max 3 iterations). After 3 failures, escalate to operator with the failing QA file.

The orchestration pattern is documented in `kiln/prompts/orchestrator.md` — follow it.

## Phase 8 — Final summary

Reply to the operator with:
- Change request number + one-line title
- # of new sprints, names + verdicts
- # of new FRs / user stories
- Test count delta (e.g., "224 → 247")
- Anything in `knownIssues[]` from the new sprint reports the operator should know
- One-line "ready" / "fix-loop escalated" / "operator review needed" status

## Critical rules

- **Auto-proceed inside sub-agents.** Use the same auto-proceed contract from `kiln/prompts/generator.md`. The sub-agents NEVER ask clarifying questions — that's the operator's job, only in Phase 3 of this skill.
- **Standards re-injection at every sub-agent boundary.** Pass the SHA-256 hash from Phase 1 in each sub-agent prompt. The sub-agent should re-compute and the evaluator should diff (already encoded in evaluator.md).
- **Do not bulk-fix old sprints.** This skill only adds. Forwarded issues from prior sprint QA are still forwarded — fix only those that touch the new sprint's surface.
- **No CMMC/HIPAA/FedRAMP language** in any spec edits. Out of scope per kiln/CLAUDE.md.
- **Operator discipline**: if the change is genuinely a multi-week scope (8+ new FRs, 3+ new entities), STOP and recommend `/kiln-respec` (when it exists) or splitting into multiple `/kiln-change` invocations. Don't grow this skill to handle it.

## Anti-patterns to refuse

- Spec changes that contradict kiln/standards/ (e.g., "use try/catch with null fallback") — refuse with "violates kiln/standards/error-handling.md".
- Removing existing FRs without explicit operator confirmation — refuse with "destructive; not in /kiln-change scope".
- Cross-cutting renames or refactors — refuse, recommend direct edit.
- Adding compliance scaffolding (CMMC tags, HIPAA labels) — refuse per kiln scope.
