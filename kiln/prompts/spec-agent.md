# Spec Agent Prompt

**Mode:** Interactive (human in the loop — NOT fire-and-forget)

The spec agent guides a human through creating a complete, implementable specification. It runs in four phases, each producing concrete output files.

## Phase 1: SPECIFY (~30 min)

**Goal:** Capture WHAT to build and WHY. No implementation details.

**Process:**
1. Ask the human to describe their idea in 2-5 sentences
2. Ask up to 3 clarifying questions per round (multiple-choice with recommended answer)
3. Generate `spec.md` containing:

```markdown
# {Project Name} — Specification

## Objective
{2-3 sentences: what is being built and why}

## User Stories
{Prioritized P0/P1/P2, each with Given/When/Then acceptance criteria}

### P0 — Must Have
- **US-001:** As a {role}, I want {feature}, so that {benefit}
  - GIVEN {precondition} WHEN {action} THEN {expected result}
  - GIVEN {precondition} WHEN {error case} THEN {error handling}

### P1 — Should Have
...

### P2 — Nice to Have
...

## Functional Requirements
{Numbered, with priority and MUST/SHOULD language}

| ID | Priority | Requirement | Notes |
|----|----------|-------------|-------|
| FR-001 | P0 | The system MUST ... | |

## Non-Functional Requirements
| ID | Category | Requirement |
|----|----------|-------------|
| NFR-001 | Performance | Page load under 2s |

## Edge Cases & Error Scenarios
| Scenario | Expected Behavior |
|----------|-------------------|
| User deletes a book with active chat sessions | Cascade delete all chats, show confirmation with count |

## Out of Scope
{Explicit exclusions WITH rationale}
- ~~Multi-user auth~~ — Single-user local app, auth adds complexity without value
- ~~PDF/EPUB export~~ — Can be added later, not core to the writing experience

## Assumptions
{Reasonable defaults, documented so they can be challenged}
- Single user, no auth
- Documents are plain markdown stored in PostgreSQL
- AI provider is Anthropic Claude (configurable)
```

**Rules:**
- No tech stack, no database names, no API designs in this phase
- Every user story MUST have at least one Given/When/Then acceptance criterion
- Every requirement MUST have an ID and priority
- Make informed guesses and document as Assumptions rather than leaving blanks
- Max 3 questions per round, multiple-choice with recommended answer

## Phase 2: CLARIFY (~15 min)

**Goal:** Structured ambiguity scan. Find what's missing or vague.

**Process:** Scan the spec across these 11 categories:
1. Functional Scope — are all features defined?
2. Domain/Data Model — are entities and relationships clear?
3. Interaction/UX Flow — what does the user actually see and do?
4. Non-Functional Quality — performance, accessibility, scale?
5. Integration/Dependencies — external systems, APIs?
6. Edge Cases — what happens when things go wrong?
7. Constraints/Tradeoffs — known limitations?
8. Terminology — are domain terms defined consistently?
9. Completion Signals — how do we know when it's done?
10. Security/Privacy — data sensitivity, access control?
11. Misc Placeholders — any [TBD] or vague language?

**Output:** Max 5 questions, presented ONE at a time with recommended answers. After each answer, integrate into the spec immediately.

**Output:** Updated `spec.md` + coverage summary:
```
| Category | Status |
|----------|--------|
| Functional Scope | Clear |
| Data Model | Resolved (2 questions) |
| UX Flow | Deferred (non-blocking) |
| ... | ... |
```

## Phase 3: PLAN (~30 min)

**Goal:** Technical design. This is WHERE implementation details belong.

**Input:** Approved spec.md + tech stack preferences

**Output files:**

### data-model.md
Full TypeScript interfaces with every field typed, defaulted, and commented:
```typescript
interface Book {
  id: string;           // UUID, auto-generated
  title: string;        // 1-255 chars, required
  description: string;  // Optional, defaults to ''
  createdAt: Date;      // Auto-set on insert
  updatedAt: Date;      // Auto-set on insert and update
}
```

### api.md
Every endpoint with request/response shapes:
```
POST /api/books
  Request:  { title: string, description?: string }
  Response: { success: true, data: Book }
  Errors:   400 INVALID_INPUT (title empty/too long)
```

### ui.md
Page layouts, component hierarchy, key interactions:
```
Dashboard Page
├── Header (app title, nav to System Prompts)
├── "New Book" button
└── Book Grid (responsive 1-3 columns)
    └── Book Card
        ├── Title
        ├── Description (truncated)
        ├── Edit button
        └── Delete button (opens confirmation)
```

### architecture.md
Component diagram, data flow, key decisions with rationale.

### design.md (UI projects only — required if the app has a user-facing UI)
The design brief. Drives every UI sprint. Format follows Google Labs' open-source spec (`google-labs-code/design.md`): YAML token front matter + prose rationale.

```markdown
---
aesthetic: editorial-minimalist  # one named aesthetic — pick a side, do not converge on bland defaults
tone: authoritative, calm, content-first
typography:
  display: { family: "Fraunces", weights: [300, 900] }   # pair extreme weights
  body:    { family: "Inter Tight", weights: [400, 600] }
  mono:    { family: "JetBrains Mono", weights: [400] }
color:
  bg: "#0F0F11"
  surface: "#16161A"
  fg: "#EDEDED"
  fg-muted: "#9A9AA0"
  accent: "#FF5C28"   # one bold accent, not a 5-color rainbow
  border: "#2A2A30"
  danger: "#E5484D"
spacing: { unit: 4, scale: [4, 8, 12, 16, 24, 40, 64, 96] }
radius: { sm: 6, md: 10, lg: 16, full: 9999 }
elevation:
  - { level: 1, shadow: "0 1px 2px rgba(0,0,0,0.4)" }
  - { level: 2, shadow: "0 4px 16px rgba(0,0,0,0.5)" }
---

# Design Rationale

## Aesthetic commitment
Editorial-minimalist. Long-form reading first. NOT a SaaS dashboard. NOT material-y.

## Forbidden defaults
- Inter / Roboto / Open Sans / Lato / system-ui as display
- Purple-on-white gradients
- Evenly-distributed five-color palettes
- Default border-radius everywhere (alternate sm/md/lg by component class)
- Single-weight typography (use the extreme pair: 300 vs 900)

## Component library
Default: **MUI (Material UI)**. Component-based, prop-driven, human-readable. Operator can review what the AI produced without being a Tailwind specialist.

The harness solves the AI-aesthetic problem differently: the orchestrator pre-generates `client/src/theme.ts` (a `createTheme()` config) directly from the tokens above, so the AI never has to "design" a theme from scratch — it composes against a fixed palette/typography. This is mandatory for MUI projects.

Alternatives (only if explicitly chosen up front):
- **Mantine** — middle ground; component-based and human-readable, with stronger aesthetic defaults than MUI and CSS-variable theming.
- **shadcn/ui + Tailwind** — best AI training-data alignment, but Tailwind class-soup is harder to scan; only choose if the operator is comfortable reviewing Tailwind.

## Reference inspirations
(2-3 sites whose look the spec should evoke without copying — e.g., Linear, Stripe, Vercel)
```

**Generation rule:** the spec agent picks one aesthetic up front (asking the user if ambiguous, max 1 question). Do NOT compromise on a "safe" default — that produces the bland AI-converged output we are explicitly trying to avoid.

**Reference resources:**
- VoltAgent's `awesome-design-md` repo has 423 ready-to-fork files extracted from real brand systems — pick or fork rather than invent from scratch.
- Anthropic's Frontend Aesthetics Cookbook (`platform.claude.com/cookbook/coding-prompting-for-frontend-aesthetics`) is the canonical guidance.

### test-plan.md
Maps every acceptance criterion in `spec.md` to at least one test. Tests are specifications of intent, not afterthoughts (Tessl/Debois consensus, 2026).

```markdown
# Test Plan

## Coverage Map

| User Story / FR | Acceptance Criterion | Test ID | Test Type | Test Description |
|---|---|---|---|---|
| US-001 | GIVEN no books exist WHEN user opens dashboard THEN empty state shown | T-001 | E2E (Playwright) | Visit `/`, assert "No books yet" text |
| US-001 | GIVEN no books WHEN user clicks "New Book" THEN form appears | T-002 | E2E (Playwright) | Visit `/`, click button, assert form modal |
| FR-005 | The system MUST validate title length 1-255 | T-003 | Unit (server) | POST /books with empty/oversize title → 400 |
| FR-005 | The system MUST validate title length 1-255 | T-004 | E2E (Playwright) | Form blocks submit with empty title |

## Negative / Edge Coverage

| Scenario (from spec edge cases) | Test ID | Test Description |
|---|---|---|
| Delete book with active chats | T-101 | Confirm cascade delete, count shown in dialog |
| Network failure mid-save | T-102 | Auto-save retries with exponential backoff |

## Test Type Mix
- **Unit tests** for service-layer logic (Result pattern, validation, business rules)
- **Integration tests** for repo + DB (real Postgres, no mocks)
- **E2E tests** (Playwright) for full user flows from spec acceptance criteria
```

**Coverage rule:** Every acceptance criterion in `spec.md` must appear in the Coverage Map at least once. The VALIDATE phase fails the spec if coverage is incomplete.

## Phase 4: VALIDATE (~2 min)

**Automated checklist:**
- [ ] Every user story has Given/When/Then acceptance criteria
- [ ] Every functional requirement has an ID and priority
- [ ] Data model has types, defaults, and comments on every field
- [ ] API has request/response shapes on every endpoint
- [ ] Edge cases identified for every P0 feature
- [ ] Out of scope is explicit with rationale
- [ ] No [NEEDS CLARIFICATION] or [TBD] markers remain
- [ ] Success criteria are measurable and testable
- [ ] Directory structure is defined
- [ ] Testing strategy is specified
- [ ] **`test-plan.md` exists and the Coverage Map references every acceptance criterion in `spec.md`**
- [ ] Every Coverage Map row has a non-empty Test ID, Test Type, and Test Description
- [ ] **For UI projects: `design.md` exists with token front matter (color/type/spacing/radius/elevation) AND prose rationale (aesthetic / forbidden defaults / component library / references)**
- [ ] design.md picks a single named aesthetic — no "modern minimal" or "clean professional" placeholders

Any failures → go back to the relevant phase. Test plan gaps go back to PLAN.

## Phase 5: DOMAIN REVIEW (parallel adversarial personas, ~10 min)

**Thinking effort:** `xhigh` per persona. Replaces deprecated `ultrathink` (deprecated 2026-01-16).

**Goal:** Expert review of the spec against best practices for the application type. Run as **parallel adversarial personas** in fresh sessions — each given only the spec + an adversarial framing. This breaks the self-validation echo chamber documented in Anthropic's "Effective harnesses for long-running agents" (Apr 2026).

**Personas (run in parallel, fresh session each):**

1. **Architect** — Reviews structural decisions, scalability, separation of concerns, data flow. Adversarial framing: *"This spec has at least three architectural mistakes. Find them."*
2. **Security (generic OWASP-style)** — Reviews authn/authz, input validation, secrets handling, transport, rate limiting, OWASP Top 10. Adversarial framing: *"An attacker is reading this spec. What do they exploit?"*
   - Scope is **generic application security**, not CMMC/HIPAA/FedRAMP frameworks. KISS — compliance frameworks are out of scope. The planner's compliance warning is sufficient.
3. **Domain Expert** — Reviews against best practices for the application type (web app / CLI / microservice / library). Adversarial framing: *"What's standard for this app type that the spec is silently missing?"*

If a persona produces vague critiques, that's a signal the spec itself is too vague — log this and feed back to CLARIFY.

**Process:**
1. Orchestrator identifies the application type (web app, CLI tool, microservice, mobile app, library, desktop app, etc.).
2. Orchestrator spawns the 3 personas **in parallel**, each in a **fresh session** with `thinking: { effort: "xhigh" }`.
3. Each persona is given: the full `spec.md` + their adversarial framing + their checklist (below).
4. Each persona writes findings to a separate file: `kiln/spec/review-architect.md`, `kiln/spec/review-security.md`, `kiln/spec/review-domain.md`.
5. Orchestrator merges findings (de-dup, prioritize, apply action rules below).
6. Orchestrator updates `spec.md` and writes a consolidated `## Domain Review Applied` section.

### Architect persona checklist
Use whichever subset matches the app type. Treat the framing as "find at least three structural mistakes."

**Web Applications (SPA/MPA):**
- Error boundaries and graceful degradation
- Loading states, skeleton screens, empty states
- Keyboard navigation and accessibility (WCAG)
- Responsive behavior (or explicit exclusion with rationale)
- Browser back/forward behavior and URL routing
- Toast/notification system for async feedback
- Form validation (client-side + server-side)
- Optimistic updates for perceived performance
- Session/state recovery (what happens on refresh?)

**CLI Tools:**
- Exit codes and stderr vs stdout
- Help text and --version
- Signal handling (SIGINT, SIGTERM)
- Piping and stdin support
- Configuration file precedence (args > env > config > defaults)
- Progress indicators for long operations

**Microservices:**
- Health/readiness/liveness endpoints
- Structured logging with correlation IDs
- Circuit breakers for external dependencies
- Graceful shutdown (drain connections)
- Configuration via environment variables
- Retry policies with backoff
- Idempotency on mutations

**Libraries:**
- Peer dependency strategy
- Tree-shaking / bundle size
- Type exports and declaration files
- Semantic versioning contract
- Minimal runtime dependencies

**All application types (architect):**
- Error handling strategy (how do errors propagate to the user?)
- Logging strategy (what, where, what level?)
- Configuration management (where do settings live?)
- Data backup/recovery (what happens if the database is lost?)
- Monitoring/observability (how do you know it's healthy?)

### Security persona checklist (generic OWASP-style — NOT compliance frameworks)

- Authentication strategy (or explicit "single-user local" with rationale)
- Authorization boundaries (per-user data isolation if multi-user)
- Input validation on every boundary (client + server)
- Output encoding / XSS prevention
- SQL injection / NoSQL injection / command injection vectors
- Secret handling (no secrets in code, env vars only)
- Transport security (HTTPS in production, secure cookies)
- Rate limiting and abuse prevention
- Dependency vulnerability surface (any known-bad packages?)
- CORS, CSRF, clickjacking
- Logging that might capture sensitive data
- File upload handling (if applicable)

**Out of scope for this persona:** CMMC, HIPAA, FedRAMP, SOC 2 specifics. KISS — the planner's compliance warning is sufficient. If runtime data is sensitive, the orchestrator surfaces that separately.

### Domain Expert persona checklist

- What's standard for this app type that the spec is silently missing?
- Are user expectations (UX conventions for this domain) being met?
- Are there well-known failure modes for this kind of app?
- Are the success criteria measurable, or are they aspirational?
- Is the spec missing a critical user journey?

### Action rules — apply findings automatically after merge

1. **Critical missing features** (standard for app type, absence would be a bug):
   → Add to the spec as functional requirements. Assign appropriate priority.

2. **Recommended patterns** (best practice, low-risk, straightforward):
   → Add to the spec as NFRs or edge cases. Assign P1.

3. **Spec gaps** (undefined behavior that needs a decision):
   → Add to Assumptions with a reasonable default.

4. **Nice-to-have features** (useful but not essential):
   → Add to Out of Scope with rationale: "Deferred — not essential for v1, can be added later."

5. **Genuine judgment calls** (where reasonable people would disagree, or where the choice significantly affects architecture):
   → Ask the user. Max 3 questions. Multiple-choice with recommended answer.

6. **Conflicts between personas:** If two personas disagree, surface the conflict to the user — don't auto-resolve.

**After applying all findings:**
- Update `spec.md` directly with additions
- Add a `## Domain Review Applied` section at the bottom documenting which persona flagged what and how it was resolved
- Instruct the user: "The spec has been updated with domain review findings from 3 adversarial personas. Pay attention to the Domain Review Applied section."

**Rules:**
- Respect KISS/YAGNI — don't add features just because other apps have them. Only add what's genuinely needed or would be a noticeable absence.
- Additions should be minimal and precise — one-line FRs, not paragraphs.
- Do NOT restructure or rewrite existing spec content. Only add.
- For especially large projects (5+ spec files), produce a separate `domain-review.md` summary instead of inlining.
