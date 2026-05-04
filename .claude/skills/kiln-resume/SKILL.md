---
description: Continue running sprints in a kilned project after /kiln-init's Sprint 1 stop. Defaults to the next pending sprint; accepts an explicit sprint id. Runs generator + evaluator + max-3 fix-loop, then STOPS for operator review. Single-sprint per invocation — does not auto-advance to the next sprint.
---

# /kiln-resume

Operator-invoked skill that runs one sprint of a kilned project. Picks up where `/kiln-init` left off, or where the operator paused after a fix-loop, or where `/kiln-change` produced new sprints that haven't been built yet.

## Sub-agent invocation discipline (READ THIS FIRST)

**Every phase below that says "spawn the generator" or "spawn the evaluator" means: use the Agent tool (`subagent_type: 'general-purpose'`) to launch a sub-agent. Do NOT execute the phase work inline in the parent session.**

Inline execution forces the operator to approve every Bash/Edit/Write call individually. Sub-agent execution requires one Agent-tool approval per phase; the sub-agent runs autonomously inside that scope and returns a summary. The parent session orchestrates and waits for sub-agents; sub-agents do the heavy lifting.

The parent session does inline only: pre-flight checks (docker compose up, db:push), reading sprint-N-1-report.json + sprint-N-1-qa.json (small files, ~200 lines each) for context to put in the next sub-agent's prompt, and final summary to the operator.

## Why single-sprint per invocation

`/kiln-init` stops after Sprint 1 because Sprint 1 (scaffold) is the highest-risk sprint and the right operator-checkpoint. The same logic applies to every subsequent sprint: PASS_WITH_ISSUES surfaces forwarded issues, FAIL surfaces unrecoverable problems, and the cheapest intervention point is between sprints. Auto-advancing through 8 sprints in one invocation is the "long-running autonomous loop" pattern that keeps producing 40+ minute runs with no chance for the operator to course-correct.

If you want to run multiple sprints unattended, run `/kiln-resume` repeatedly. Don't ask for `--all`.

## When to use

- After `/kiln-init` completed Sprint 1 — run Sprint 2
- After a sprint passed and you've reviewed it — run the next one
- After `/kiln-change` appended new sprints — run them one by one
- To re-run a failed sprint after fixing the spec or standards manually

## When NOT to use

- The directory is not a kilned project (no `kiln/spec/spec.md` + `kiln/standards/` + `kiln/sprints/plan.json`) — refuse, recommend `/kiln-init` or `/kiln-retrofit`
- All sprints in `plan.json` already have passing QA — refuse with "all sprints complete; nothing to resume"
- The operator wants to add a new feature (use `/kiln-change`)

## Inputs

```
/kiln-resume               # run the next pending sprint
/kiln-resume 5             # run sprint id=5 specifically
/kiln-resume 5 --force     # re-run a sprint that already passed (rare; use when you've manually edited the spec or want to validate fresh)
```

## Phase 1 — Locate the project + read state

1. Confirm cwd is a kilned project (per `/kiln-change` Phase 1). Refuse otherwise.
2. Read `kiln/sprints/plan.json` and enumerate sprints by id.
3. For each sprint, classify state:
   - **NOT_STARTED** — no `sprint-N-report.json`
   - **GENERATED_ONLY** — report exists, no QA
   - **FAILED** — QA exists with verdict `FAIL`
   - **PASS_WITH_ISSUES** — QA exists with verdict `PASS_WITH_ISSUES`
   - **PASSED** — QA exists with verdict `PASS`
4. Identify the target sprint:
   - If user passed an id: use it. Validate state is not `PASSED` (unless `--force`).
   - Else: find the lowest id whose state is NOT `PASSED`. That's the target.
   - If all sprints are `PASSED`: refuse with "all sprints complete; run `/kiln-change` to add features."
5. Read `CLAUDE.md` and ALL `kiln/standards/*.md`. Compute SHA-256 of concatenated standards.
6. Read the most recent prior sprint's report + QA (just one — N-1) for context. DO NOT bulk-read all prior reports.

## Phase 2 — Determine the action

| Target state | Action |
|---|---|
| NOT_STARTED | Run generator → evaluator (Phase 3) |
| GENERATED_ONLY | Run evaluator only (Phase 4) — generator already produced a report |
| FAILED or PASS_WITH_ISSUES (re-run requested) | Run fix-loop iteration (Phase 5) |
| PASSED + `--force` | Treat as NOT_STARTED — full re-run |

If the target sprint is FAILED with `fix-loop iteration count` already at 3 (check `sprint-N-report.json` for an `iteration` field or count by file timestamps), STOP. Do not run a 4th iteration. Print: "Sprint N has failed 3 fix-loop iterations. Manual operator intervention required — review `kiln/sprints/sprint-N-qa.json` and decide: fix the spec, fix the standards, or skip the sprint."

## Phase 3 — Run generator + evaluator (NOT_STARTED case)

1. **Pre-flight checks:**
   - For app projects: `docker compose up -d` + wait for healthcheck + `pnpm --filter server db:push`
   - For library projects: nothing
2. **Spawn generator sub-agent.** Use `kiln/prompts/generator.md` as the contract reference. Input includes:
   - CLAUDE.md, all kiln/standards/, kiln/sprints/plan.json
   - The most recent prior sprint's `sprint-N-1-report.json` + `sprint-N-1-qa.json` (just one — N-1, not all prior)
   - Spec docs per `relevantSpecDocs[]` from plan.json sprint N
   - The standards SHA-256 hash from Phase 1
3. **Spawn evaluator sub-agent.** Use `kiln/prompts/evaluator.md` as the contract reference. Step 0 regression gate runs all existing tests; if any pre-existing test fails, verdict = FAIL with reason `regression`.
4. Read the QA verdict.

## Phase 4 — Run evaluator only (GENERATED_ONLY case)

1. Pre-flight checks (same as Phase 3 step 1).
2. Spawn evaluator with the existing report + spec context. Skip generator.
3. Read the QA verdict.

## Phase 5 — Fix-loop iteration (FAILED / PASS_WITH_ISSUES case)

1. Read the existing `sprint-N-qa.json` to identify what failed.
2. **Spawn the generator in fix mode.** Pass the QA findings as the targeted task: "Sprint N failed QA. Read `kiln/sprints/sprint-N-qa.json` for the failures. Fix all violations and bugs listed. Do not rebuild — fix in place. Update `kiln/sprints/sprint-N-report.json` when done."
3. **Spawn the evaluator** to re-evaluate.
4. Track iteration count (the orchestrator can append a `fixLoopIteration` field to the sprint-N-report.json or count `_iter-K` suffixed files; pick the simpler convention and document).
5. If the verdict is now PASS or PASS_WITH_ISSUES with all axes ≥ 2: stop fix-loop, proceed to Phase 6.
6. If FAIL and iteration < 3: loop back to step 1.
7. If FAIL and iteration == 3: escalate (see Phase 2 escalation text).

## Phase 6 — Stop and summarize

After the target sprint reaches a final verdict (PASS, PASS_WITH_ISSUES, or escalated FAIL after 3 fix-loop iterations), **stop**. Do NOT auto-advance to the next sprint.

Reply to the operator with:
- Sprint id + name + final verdict + axis scores
- Test count delta (e.g., "224 → 247")
- Bug / violation counts (critical / major / minor)
- Most important issue from `knownIssues[]` if any
- Forwarded issues that the next sprint should address (from this sprint's QA, items in `suggestions[]`)
- Suggested next step:
  - PASS → "review the diff, then `/kiln-resume` (will pick sprint N+1) or `/kiln-resume <N+2>` to skip ahead"
  - PASS_WITH_ISSUES → "review the QA, then `/kiln-resume` if the issues are forwardable, or `/kiln-resume <N>` to fix-loop here"
  - FAIL after 3 iterations → "review `kiln/sprints/sprint-N-qa.json`. Likely causes: spec ambiguity, standards conflict, or a real implementation problem outside the sprint scope. Fix the root cause, then `/kiln-resume <N>` to re-run."

## Critical rules

- **Never auto-advance.** One sprint per invocation. Always.
- **Standards re-injection** at every sub-agent boundary. Re-compute the hash if `kiln/standards/*.md` changed since last run; flag if so (the orchestrator should normally not see drift, but operator-edited standards is a legitimate case).
- **Step 0 regression gate is non-negotiable.** Pre-existing tests must pass before sprint criteria are evaluated. Skipping the gate to "make progress" defeats the harness.
- **Max 3 fix-loop iterations.** Industry consensus (MindStudio, Shiplight 2026) is 2-3. Beyond that, the loop is usually oscillating between two broken states.
- **Ports / docker / db-push handled identically per sprint.** No surprises.
- **No CMMC/HIPAA/FedRAMP scaffolding.** Out of scope per kiln charter.

## Anti-patterns to refuse

- Operator asking to "run sprints 2 through 8 unattended" — refuse, explain the per-sprint review philosophy
- Operator asking to skip Step 0 regression gate "just this once" — refuse
- Operator asking to bypass the 3-iteration cap on a stubborn sprint — refuse, surface the QA findings instead
- Sprint that has been failing the same way for 3 iterations — escalate; do not retry blindly
- Project that has no kiln markers (no `kiln/spec/`, no `kiln/standards/`, no `kiln/sprints/plan.json`) — refuse, recommend `/kiln-retrofit`

## Reference

`book-writer-app-v5` Sprints 11-12 (the `/kiln-change` validation run) demonstrated the exact pattern this skill encodes: spawn generator, spawn evaluator, fix-loop only on FAIL, stop between sprints. The skill is just that pattern packaged.
