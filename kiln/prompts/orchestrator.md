# Orchestrator Guide

The orchestrator manages the agent pipeline: planner → generator → evaluator → fix loop. This can be a human running Claude Code sessions or the automated runner (Phase 3).

## Pipeline Flow

```
1. Spec Agent (xhigh)        → kiln/spec/ docs (interactive, see spec-agent.md)
2. Planner (xhigh)            → kiln/sprints/plan.json
3. For each sprint:
   a. Generator (high/xhigh)  → kiln/sprints/sprint-N-report.json
   b. Evaluator (medium)      → kiln/sprints/sprint-N-qa.json
   c. If verdict = FAIL or PASS_WITH_ISSUES:
      - Generator (fix)       → kiln/sprints/sprint-N-report.json (updated)
      - Evaluator (re-eval)   → kiln/sprints/sprint-N-qa.json (updated)
      - Max 3 fix iterations, then escalate to human
   d. If verdict = PASS: next sprint
```

## Per-agent thinking and budget settings

The legacy `ultrathink` keyword was deprecated 2026-01-16. Set thinking effort explicitly per agent.

| Agent | thinking_effort | task_budget | Rationale |
|---|---|---|---|
| Spec Agent / DOMAIN REVIEW personas | `xhigh` | 1_000_000 | Creative work, benefits from headroom |
| Planner | `xhigh` | 1_000_000 | Creative work, benefits from headroom |
| Generator (Sprint 1 / complex) | `xhigh` | 2_000_000 | Scaffold or audit-style sprints; headroom for `xhigh` thinking |
| Generator (CRUD / standard) | `high` | 2_000_000 | Same budget; trust the model to use less when it can |
| Evaluator | `medium` | 200_000 | Systematic verification; xhigh makes evals more lenient |
| Fix-loop generator | `high` | 500_000 | Targeted fixes shouldn't need full sprint budget |

**Why budgets matter even on Max plans:** Task budgets aren't about cost — they're about run integrity. They give the model a countdown across the entire agentic loop so it can pace itself and finish gracefully rather than be cut off mid-thought by a rate limit. A bug-induced fix-loop oscillation is a *correctness* problem; the budget caps damage.

**CLI-only constraint:** The harness invokes `claude -p` from the CLI, not the Anthropic SDK. `task_budget` and `thinking_effort` in API form are not directly settable from the CLI; Claude Code applies its own defaults (Opus 4.7 → `xhigh` for sustained agentic work). The numbers in the table above are **documentation of intent** — guardrails for human review and any future automated runner. They are not API-enforced today. See `HARNESS.md` "Decisions Log" for the full reasoning.

## Reset, don't compact, between sprints

Each sub-agent should start in a **fresh context**, not a compacted continuation. From Anthropic's "Effective harnesses for long-running agents" (Apr 2026): *"Compaction preserves but makes models cautious."*

Each sub-agent re-hydrates from artifacts:
- `CLAUDE.md` (project conventions)
- `kiln/standards/` (all 5 docs — see Standards Re-injection below)
- `kiln/sprints/plan.json` (canonical plan)
- Previous sprint reports + QA files (history)
- Git log (what was actually committed)

Do not pass context across sprint boundaries. Do not run `/compact` mid-sprint unless absolutely necessary; use full resets at sub-agent boundaries instead.

## Standards re-injection (and drift detection)

Every sub-agent invocation must include the full `kiln/standards/` block, not just `CLAUDE.md`. With prompt caching this is cheap. Without it, agents drift away from documented conventions over a long run — formalized as "Safety Drift" in Yu et al., 2026.

Mechanism:
1. Concatenate `kiln/standards/*.md` into the agent prompt (or pass the directory path with explicit "READ ALL FILES" instruction).
2. Compute a SHA-256 hash of the concatenated standards block.
3. Log the hash to each sprint report under `standardsHash`.
4. The orchestrator can diff hashes across sprints to detect that standards changed mid-run (intentionally or accidentally).

```bash
STANDARDS_HASH=$(cat book-writer/kiln/standards/*.md | sha256sum | cut -d' ' -f1)
```

## Post-compaction agent amnesia

Known issue (Claude Code 2.1.x): after a `/compact`, references to background tasks launched earlier are lost from the agent's view, even though the status line still shows them running.

Mitigation:
1. **Don't run `/compact` while background sub-agents are active.** Wait for them to complete first.
2. Before any compaction, query `/agents` and snapshot the running list to a file the post-compaction agent can read.
3. Better: structure runs so each sprint is a fresh session — no compaction needed.

If you must compact mid-run, the `PreCompact` hook (Claude Code 2.1.105+) can auto-snapshot the agent list. See `.claude/settings.json`.

## Concurrency Rules

- **Generator and evaluator are sequential** — evaluator needs generator output.
- **Research and monitoring are independent** — run in background while agents work.
- **Never poll with sleep loops.** Use background tasks with notifications.
- **Parallel personas in DOMAIN REVIEW** — fan out to 3 sub-agents (Architect, Security, Domain) in fresh sessions, then merge findings.

```
DO:    Run generator in background, get notified when done, then start evaluator.
DON'T: sleep 120 && check if file exists && sleep 120 && check again
```

## App Lifecycle Management

The evaluator (or orchestrator) must manage the app lifecycle for Playwright testing:

```bash
# 1. Start infrastructure
docker compose up -d
sleep 5  # wait for postgres to be ready

# 2. Push schema
pnpm db:push

# 3. Start app in background
pnpm dev &
APP_PID=$!
sleep 5  # wait for vite + express to start

# 4. Run evaluator with Playwright MCP
claude -p "<evaluator prompt>" --dangerously-skip-permissions

# 5. Cleanup
kill $APP_PID
docker compose down  # optional — leave running between sprints
```

**Alternative:** The evaluator agent itself can start/stop the app via Bash tool. This is simpler but means the evaluator manages its own test environment.

## Port Configuration

All ports live in the root `.env` file. One source of truth.

```
DB_PORT=5435
SERVER_PORT=3003
CLIENT_PORT=5176
DATABASE_URL=postgresql://user:pass@localhost:${DB_PORT}/dbname
```

Before starting, verify ports are free:
```bash
netstat -an | grep "5435\|3003\|5176"
```

Docker-compose, vite.config, and server/index.ts all read from `.env`. No hardcoded ports.

## Agent Invocation

`--dangerously-skip-permissions` is the right choice for autonomous harness runs in a controlled local environment. (`--auto-mode` is the safer option if you ever run against a less-controlled environment like a cloud sandbox.)

### Planner
```bash
claude -p "You are a planner agent. [rest of planner prompt]" \
  --dangerously-skip-permissions
```
Thinking effort `xhigh` is the Claude Code default on Opus 4.7+. Do not prepend the literal word `ultrathink` — deprecated 2026-01-16.

### Generator
```bash
claude -p "You are a generator agent building Sprint N. [rest of generator prompt]" \
  --dangerously-skip-permissions
```

### Evaluator (without Playwright)
```bash
claude -p "You are an evaluator agent. [rest of evaluator prompt]" \
  --dangerously-skip-permissions
```

### Evaluator (with Playwright)
```bash
claude -p "You are an evaluator agent. [rest of evaluator-playwright prompt]" \
  --dangerously-skip-permissions \
  --mcp-config .claude/.mcp.json
```

## Fix Loop

When the evaluator's verdict is `FAIL` or `PASS_WITH_ISSUES`:

1. Read the QA report (`sprint-N-qa.json`).
2. Decide: are the failures fixable or does the sprint need a rewrite?
   - **Fixable:** Feed QA report to generator with fix instructions.
   - **Rewrite:** Delete sprint code, re-run generator (rare — last resort).
3. Run generator with QA context:
   ```bash
   claude -p "You are a generator agent. Sprint N failed QA.
   Read kiln/sprints/sprint-N-qa.json for the failures.
   Fix all violations and bugs listed. Do not rebuild — fix in place.
   Update kiln/sprints/sprint-N-report.json when done." \
     --dangerously-skip-permissions
   ```
4. Re-run evaluator.
5. **Max 3 fix iterations.** After 3 failures, escalate to human review. Industry consensus (MindStudio, Shiplight, 2026): 2-3 rounds is the right cap. Beyond that, the loop is usually oscillating between two broken states and a human needs to break the tie.

## Monitoring

- **Process alive?** `tasklist | grep claude` (Windows) or `ps aux | grep claude`
- **Making progress?** Check for new/modified files in the project
- **Done?** Sprint report/QA file exists
- **Background tasks:** Use `run_in_background: true` and wait for notification
- **API errors:** The `StopFailure` hook in `.claude/settings.json` will surface these automatically

## Common Mistakes (Learned the Hard Way)

1. **Sleep polling** — Don't loop `sleep && check`. Use background execution with notifications.
2. **Foreground research** — If research is independent of the running agent, run it in background.
3. **Port conflicts** — Always check ports before starting. Other projects may be running.
4. **Dotenv cwd** — In pnpm monorepos, dotenv loads from cwd (the package dir), not project root. Load from root explicitly.
5. **Missing db:push** — Schema exists in code but tables don't exist in DB. Always push after docker up.
6. **Root package.json scripts** — All commands should be runnable from root. Don't make users hunt for scripts in sub-packages.
7. **Compacting mid-run with active background agents** — References disappear. Wait for sub-agents to finish first.
8. **Generator asking clarifying questions** — Post-Constitution-update Claude leans toward asking. The generator prompt now blocks this; if you see it happen, check the prompt wasn't truncated.
9. **Stale standards across sprints** — Re-inject `kiln/standards/` at every sub-agent boundary. The hash log catches drift.
