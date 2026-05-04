# Domain Review — Security persona (generic OWASP-style)

**Adversarial framing applied:** "An attacker is reading this spec. What do they exploit?"

## Findings

### F-S-001 — No per-part body size cap; single huge part causes OOM via `streamToBuffer`

**Severity:** High
**Type:** Resource-exhaustion
**Location:** `kiln/spec/spec.md` FRs (no FR exists); `kiln/spec/api.md` §4 `streamToBuffer`; `kiln/spec/data-model.md` §1.4 `ParseMultipartOptions`

**Threat:** A malicious server returns a `multipart/related` response containing a single part whose `Content-Type` matches a branch in the caller's `PartParser<T>` that does `await streamToBuffer(part.body)` (the documented happy-path pattern in `api.md` §3 example). The server streams 4 GiB (or more) into that one part. Nothing in the spec caps per-part body size — `streamToBuffer` accumulates the entire payload in process heap and the Node process OOMs. The library boasts "Memory footprint MUST stay constant relative to part-body size, not response size" (NFR-011) — this is precisely the wrong guarantee. The attacker controls part-body size and that is what blows up. NFR-011 should also bound part-body size, or the library should ship a `maxPartBytes` cap option that `streamToBuffer` and the per-part wrapper enforce.

The `Content-Length` header on a part is documented as "informational, not a contract" (`data-model.md` §1.1) — even an honest `Content-Length` cap is not enforced. The attacker can lie about it freely.

The `application/json` example in `api.md` §2 — `JSON.parse(await streamToString(part.body))` — has the same shape: an attacker who can land a part with `Content-Type: application/json` (likely, since the caller branches on it) and then streams 4 GiB of JSON whitespace OOMs the process before the parser even starts.

**Recommendation:** Add `FR-DR-S-001 ParseMultipartOptions and MultipartHandlerOptions MUST accept maxPartBytes?: number; when set, parseMultipartRelated MUST destroy the part body and reject the iterator with a new MultipartPartTooLargeError once a yielded part body exceeds the cap, regardless of caller drain pattern.` Add `FR-DR-S-002 streamToString and streamToBuffer MUST accept an optional maxBytes argument; on overflow they reject with a clear error and destroy the source.` Update NFR-011 to clarify that constant-memory is only guaranteed if the caller does not buffer per-part bodies — and add a documented attacker model in README.

**Action rule:** 2

---

### F-S-002 — `parseMultipartRelated` allows server-side use without timeouts; slow-loris DoS

**Severity:** High
**Type:** DoS
**Location:** `kiln/spec/spec.md` FR-006; `kiln/spec/data-model.md` §1.4 (`idleTimeoutMs?`, `totalTimeoutMs?` both optional with default "disabled")

**Threat:** FR-006 makes timeouts REQUIRED on `fetchAndHandleMultipart` but only OPTIONAL on `parseMultipartRelated`. The latter is the lower-level entry. A perfectly plausible server use is `parseMultipartRelated(req as unknown as Response, ...)` or `parseMultipartRelated(req, { boundary })` where `req` is an inbound HTTP request (a Node `Readable`). An attacker holds the connection open and dribbles one byte every 30 seconds (or never sends the closing boundary). Without an idle/total timeout the generator blocks forever; the connection (and the listener it pinned) leaks. With many such connections, the attacker exhausts the server's FD budget / event-loop attention.

The `data-model.md` defaults table makes the default explicit: "Omit to disable idle-timeout enforcement." This is the wrong default for a library that documents itself as production-grade. Defaults should be safe.

**Recommendation:** Either (a) make `idleTimeoutMs` and `totalTimeoutMs` REQUIRED on `parseMultipartRelated` too (FR-006 amendment), or (b) ship safe defaults (e.g., `idleTimeoutMs: 30_000`, `totalTimeoutMs: 600_000`) when not provided, AND add a prominent `## Security Considerations` section to README and `api.md` warning callers who deliberately disable timeouts. Add `FR-DR-S-003 parseMultipartRelated MUST either require timeouts or default them to safe non-zero values; "disabled" MUST require an explicit opt-in (e.g. {idleTimeoutMs: null}).` Add a server-side use-case threat-model paragraph to `architecture.md` §9.

**Action rule:** 2

---

### F-S-003 — No header-count or header-size cap; attacker bombs dicer with N×K-byte headers

**Severity:** High
**Type:** Resource-exhaustion / DoS
**Location:** `kiln/spec/spec.md` (no FR); `kiln/spec/data-model.md` §1.1, §2.5–2.7 (header flattening); `kiln/spec/architecture.md`

**Threat:** Dicer 0.3.1 accepts arbitrarily large header blocks per part. An attacker sends a single part with 100,000 headers, or one header whose value is a 100 MB string. The library calls `flattenDicerHeaders` which flattens every value to a UTF-8 string and stores them in the `StreamingMultipartPart.headers` map yielded to the caller — heap usage is now O(attacker-chosen). Dicer's per-part `'header'` event is buffered and emitted as a single object, so this is fully realized in memory before the part body even begins streaming. Even if the caller skips the part by returning `undefined`, the headers have already been allocated.

The spec's `flattenHeaderValue` description in `data-model.md` §2.6 mentions "Returns `''` for nullish input" but says nothing about size limits, count limits, or sanity checks. NFR-011's constant-memory promise is broken on header-bomb input because dicer hands us the whole header map at once.

**Recommendation:** Add `FR-DR-S-004 The library MUST cap per-part header count (default 100) and per-part total header bytes (default 16 KiB), configurable via ParseMultipartOptions.maxHeadersPerPart and maxHeaderBytesPerPart. On overflow, the operation rejects with a new MultipartHeadersTooLargeError and cleanup runs per FR-010.` Note in `architecture.md` that dicer itself does not enforce these limits, so the cap must be enforced in the `'header'` listener inside `parse-multipart-related.ts`.

**Action rule:** 2

---

### F-S-004 — `sanitizeFileName` produces empty string and Windows reserved names; caller writing to disk has unsafe outputs

**Severity:** Medium
**Type:** Validation-gap
**Location:** `kiln/spec/spec.md` FR-023; `kiln/spec/data-model.md` §2.8; spec edge-case row "`sanitizeFileName` receives a path-traversal attempt"

**Threat:** Although `sanitizeFileName` is internal (FR-016), the spec keeps it inside the library and the BRIEF specifically calls it in scope. The current rule (strip path seps, strip control chars, strip leading dots, replace non-`[A-Za-z0-9._-]` with `_`, cap 255) does NOT:

1. Reject empty results. Input `"..."` becomes `""` after leading-dot strip. Caller doing `fs.writeFile(sanitized || 'default', ...)` is fine — caller doing `fs.writeFile(path.join(dir, sanitized), ...)` writes to `dir/` which on POSIX overwrites the directory entry semantics and on Windows fails confusingly. `data-model.md` §2.8 even says "Returns `''` for empty input — caller decides whether to fall back to a default" which makes the empty-string case explicit but still leaves the trap.
2. Reject Windows reserved device names. Input `"CON"`, `"PRN"`, `"AUX"`, `"NUL"`, `"COM1".."COM9"`, `"LPT1".."LPT9"` (and any of those plus an extension, e.g., `"CON.txt"`) all pass `sanitizeFileName` unchanged. On Windows, opening any of these by name returns a handle to the named device — `fs.writeFile('CON', data)` writes to the console driver, `fs.readFile('AUX')` reads from a comm port. An attacker who controls `Content-ID` can pick any of these.
3. Reject `.` and `..` after sanitization. Input `".."` becomes `""` (good — stripped leading dots); but input `"._."` becomes `"._."` which stays `"._."`. Input with leading underscore + dots may produce traversal-resembling results that still confuse callers concatenating.
4. The cap is at 255 chars but doesn't account for the path itself (NTFS MAX_PATH ≈ 260 chars). The library can't know the caller's path prefix, but the spec should at least call out the gotcha.

**Recommendation:** Update FR-023 to also: reject empty result by returning a non-empty fallback (e.g., `'_'`) OR document in `data-model.md` §2.8 that callers MUST treat `''` as "no usable name" and supply their own default; reject Windows reserved device names (case-insensitive, with-or-without extension); reject pure-dot results (`'.'`, `'..'`). Add `FR-DR-S-005 sanitizeFileName MUST return a non-empty string; when input would produce an empty result OR a Windows reserved device name (CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9], case-insensitive, with or without extension) OR a single-/double-dot result, it MUST return the literal string '_' instead.`

**Action rule:** 2

---

### F-S-005 — Error messages embed attacker-controlled `Content-Type` raw bytes; downstream log injection / log-spam

**Severity:** Medium
**Type:** Info-leak / Injection
**Location:** `kiln/spec/spec.md` FR-021; `kiln/spec/api.md` §2 Throws section; `kiln/spec/api.md` §5 `extractBoundary`

**Threat:** FR-021 mandates the error message `'multipart: response Content-Type is not multipart/related; got <actual>'` where `<actual>` is the raw `Content-Type` header value the server returned. An attacker who controls the upstream response (e.g., compromised microservice, MITM on a non-TLS hop, or the attacker simply IS the server) sets `Content-Type` to a payload like `application/json\r\n\r\n<huge attacker text with newlines and ANSI escapes>`. When the caller logs this error message via `console.error(err)` or a structured logger that doesn't sanitize, the attacker has injected lines into the caller's log stream. With ANSI escape sequences, the attacker can rewrite terminal scrollback, hide log lines, or spoof prompts. `extractBoundary`'s error messages (`api.md` §5 Throws) similarly embed the entire `<header>` value.

A second concern: an extremely long attacker-supplied `Content-Type` makes the error `.message` arbitrarily long (multi-MB). Some logging frameworks have per-line size limits; some truncate; some don't and degrade. The library should not enable this attack vector.

**Recommendation:** Add `FR-DR-S-006 Error messages that embed attacker-controlled response header values MUST: (a) truncate the embedded value to <= 120 chars, (b) replace control characters (0x00-0x1F, 0x7F) and ANSI escape sequences with the literal string [redacted-control], and (c) JSON.stringify the value so embedded quotes are visible.` Update FR-021's prescribed error message accordingly. Apply the same rule to `extractBoundary` Throws.

**Action rule:** 2

---

### F-S-006 — `MultipartAbortError.reason` plumbs untrusted server-derived signals to caller as `unknown`

**Severity:** Low
**Type:** Info-leak
**Location:** `kiln/spec/data-model.md` §1.8 `MultipartAbortError`; `kiln/spec/api.md` §8

**Threat:** `MultipartAbortError.reason` carries the abort signal's `reason` through to the caller. This is fine for caller-controlled signals (the caller's user-cancel reason). However, when the library composes its caller-signal with internal idle/total timer signals into a single combined signal (per `architecture.md` §3 Layer B), the combined signal's `reason` could be the timer's reason, the caller's reason, or — depending on implementation — a chained reason that includes the server's URL or internal state. The spec is silent on what `reason` should hold when an internal timer wins the race. If the library accidentally surfaces an `Error` whose `.message` was constructed from response data, it leaks.

Additionally, if a future change ever introduces a `cause` chain that includes the response URL, `Authorization` header, etc., it would slip through silently because `reason: unknown` has no contract.

**Recommendation:** Add `FR-DR-S-007 MultipartAbortError.reason MUST be the caller-supplied signal's reason verbatim, OR undefined when an internal timer is the first-fire winner; the library MUST NOT synthesize a reason that embeds the request URL, response headers, or any server-derived bytes.` Add a unit test asserting that for an idle-timeout-wins-race, `MultipartAbortError` is NOT what surfaces — the dedicated `MultipartIdleTimeoutError` does (this is already implied by the architecture but not codified as a security invariant).

**Action rule:** 2

---

### F-S-007 — `logger.warn(..., { err })` may pass attacker-controlled stream chunks / dicer state to the caller's logger

**Severity:** Medium
**Type:** Info-leak
**Location:** `kiln/spec/architecture.md` §7 (silent-catch replacements); `kiln/spec/spec.md` FR-017, US-007 ("late parser error after generator close"); `kiln/spec/api.md` cleanup §1.7

**Threat:** Several spec sites pass `{ err }` to `logger.warn`:
- US-007: `logger.warn('multipart: late parser error after generator close', { err })`
- `architecture.md` §7: `logger.warn('multipart: onSourceBytes threw', { err })`, `'multipart: unpipe failed'`, `'multipart: onProgress threw'`

The `err` here can be an `Error` whose `.message` was constructed by dicer from a malformed chunk the attacker sent. Dicer's error messages historically include the offending byte sequence (e.g., parts of the boundary line, header values). When the caller's structured logger ships this to a centralized log pipeline (Datadog, Splunk, Loki), attacker bytes land in the log indexer — same log-injection class as F-S-005 but harder to spot because the sanitization burden is on `err.message`, which the library does not control.

Additionally, `err.stack` may include internal source paths (e.g., `…/dist/index.js` line numbers) which is benign, but on bundled builds with sourcemaps loaded, original source paths leak. Lower severity but worth a note.

**Recommendation:** Add `FR-DR-S-008 The library MUST NOT pass raw chunk data to logger.warn meta. When logging an Error whose source is dicer or the source stream, the library SHOULD log only err.name and a truncated err.message (<= 120 chars, control-char-stripped) under a key like errSummary; the full err object MAY be logged under err only when the caller's logger is known to handle untrusted data safely (i.e., never by default).` Document this in `kiln/standards/error-handling.md` cross-link or in a new `## Security Considerations` section in spec.md. Add a unit test that asserts the meta object passed to `logger.warn` does not contain raw chunk bytes from a malformed input.

**Action rule:** 2

---

### F-S-008 — Dicer 0.3.1 unmaintained; spec has no CVE-monitoring or replacement plan

**Severity:** Medium
**Type:** Dependency-risk
**Location:** `kiln/spec/spec.md` NFR-004; `kiln/spec/architecture.md` §5.1; `BRIEF.md`

**Threat:** Dicer's last npm publish was 2021-12. The package is the library's sole runtime dep, and the library's security posture is fully inherited from dicer. Two concrete risks:

1. **Known-CVE risk.** If a CVE is filed against `dicer` tomorrow (e.g., a regex DoS in header parsing, a buffer mismanagement in boundary lookahead), `npm audit` flags every consumer of `@ubercode/multipart-stream`. The exact-pin `"0.3.1"` (NFR-004) means consumers cannot get a patched version without a `@ubercode/multipart-stream` release. The spec acknowledges this in §5.1's "fork-and-absorb plan" but does not commit to a SLA, a CVE monitor, or even a `npm audit` gate in CI.

2. **Algorithmic-complexity attacks in dicer's parser.** Dicer's boundary search and header parsing are old-school streaming state machines. Without specific test coverage (the spec has T-045 fuzz with 10 random boundaries — a token gesture), an attacker may find an input that drives dicer into pathological CPU usage. The library tests do not include an algorithmic-complexity benchmark.

3. **Process exit on internal `'error'`.** If dicer ever throws synchronously (not emits — throws) on an attacker input, the library's pre-pipe listener wiring (FR-012) catches the emit but a synchronous throw inside dicer's chunk handler propagates up the stack of the source's `'data'` callback and terminates the process. The spec assumes dicer is well-behaved; an unmaintained dep is a poor place for that assumption.

**Recommendation:** Add `FR-DR-S-009 The library's CI pipeline MUST run npm audit (or pnpm audit) and fail on high+ severity findings against the dicer dependency. The maintainer team commits to a 7-day SLA for patching disclosed dicer CVEs by either (a) bumping dicer's pin if a fix is published, or (b) executing the §5.1 fork-and-absorb plan (vendor dicer source under src/internal/dicer/).` Add `FR-DR-S-010 Test plan MUST include an algorithmic-complexity test (T-NEW): feed an envelope with adversarial boundaries (e.g., 10K nested near-matches) and assert parsing completes in < 5 seconds for a 1 MB envelope.` Update NFR-004 to reference the SLA.

**Action rule:** 2

---

### F-S-009 — No upper bound on `idleTimeoutMs` / `totalTimeoutMs`; integer overflow / `setTimeout` quirks

**Severity:** Low
**Type:** Validation-gap
**Location:** `kiln/spec/data-model.md` §2.11 `validatePositiveTimeout`; `kiln/spec/spec.md` Edge Cases (idleTimeoutMs: 0/NaN)

**Threat:** `validatePositiveTimeout` rejects 0, NaN, Infinity, negatives, non-integers — but accepts arbitrarily large positive integers. Node's `setTimeout` clamps any value > `2^31 - 1` (≈24.8 days) to `1`, immediately firing the timer. An attacker who controls a configuration source (env var, config file injection) sets `totalTimeoutMs: 99999999999` expecting "effectively forever" — instead the timer fires immediately and every operation rejects with `MultipartTotalTimeoutError`. Self-DoS via misconfiguration is not a remote attack but is a footgun the spec can close.

**Recommendation:** Add `FR-DR-S-011 validatePositiveTimeout MUST reject values > 2^31 - 1 with a clear error message that explains Node's setTimeout clamping behavior. The valid range is [1, 2147483647].`

**Action rule:** 2

---

### F-S-010 — `fetchInit.headers` pass-through enables credential leakage to redirected hosts

**Severity:** Low
**Type:** Info-leak
**Location:** `kiln/spec/data-model.md` §1.5 `fetchInit?: Omit<RequestInit, 'signal'>`; `kiln/spec/api.md` §2

**Threat:** The library forwards `fetchInit.headers` (including `Authorization`, `Cookie`, etc.) to `fetch` unchanged. By default, Node's `fetch` follows redirects and preserves `Authorization` across cross-origin redirects only if `redirect: 'follow'` and the underlying undici implementation (Node 20+) is the only one in play. An attacker controlling the upstream returns a 302 to `evil.example.com` and harvests the caller's `Authorization` header. This is partly outside the library's scope (it's `fetch` semantics), but the spec promotes `fetchAndHandleMultipart` as an end-to-end wrapper that includes content-type validation — suggesting it's the safe choice — without warning callers about the redirect-Authorization gotcha.

**Recommendation:** Add to `api.md` §2 Behavioral notes: "If `fetchInit.headers` includes credentials (`Authorization`, `Cookie`), callers SHOULD set `fetchInit.redirect: 'manual'` or validate the final URL post-fetch via `result.response.url`, because `fetch` will preserve credentials across some cross-origin redirects depending on host policy." Optionally add `FR-DR-S-012 fetchAndHandleMultipart SHOULD warn (logger.warn) when fetchInit.headers contains an Authorization or Cookie header AND fetchInit.redirect is unset or set to 'follow'.` (Action rule 4 — defer; this is a polish/hardening note.)

**Action rule:** 4

---

### F-S-011 — `extractBoundary` regex unspecified; potential ReDoS on adversarial Content-Type

**Severity:** Medium
**Type:** DoS
**Location:** `kiln/spec/api.md` §5; `kiln/spec/data-model.md` §2.10

**Threat:** `extractBoundary` is a public utility (FR-016) that "Implements RFC 2046 quoted-string + bare-token forms." The spec describes the function but does NOT pin the regex it uses. RFC 2046 boundary parsing with quoted-string handling is a classic ReDoS hazard if the regex uses backtracking quantifiers (e.g., `boundary=("(?:[^"\\]|\\.)*"|[^;]+)` with overlapping alternation). An attacker who lands a 64 KB `Content-Type` value with crafted `\\` sequences can exhaust CPU. `extractBoundary` runs synchronously on the main event loop before any timer is armed (it's called during validation in FR-021's path), so the attacker can stall the event loop arbitrarily long.

The spec has T-029 (extractBoundary unit) and T-054 (quoted-string boundary), but no ReDoS test.

**Recommendation:** Add `FR-DR-S-013 extractBoundary MUST use a non-backtracking regex or a hand-written tokenizer. The implementation MUST handle a 64 KB pathological Content-Type input in < 10 ms.` Add `T-NEW extractBoundary ReDoS test: pass a 64 KB Content-Type with adversarial backslash and quote sequences; assert completion in < 50 ms.`

**Action rule:** 2

---

### F-S-012 — No bound on number of parts; many-tiny-parts DoS

**Severity:** Medium
**Type:** Resource-exhaustion / DoS
**Location:** `kiln/spec/spec.md` (no FR); `kiln/spec/data-model.md` §1.3 `MultipartFetchResult.parts`

**Threat:** Complementary to F-S-001 (one giant part). Here the attacker streams 1,000,000 tiny parts (each with valid headers + 1-byte body). For each, the library:
- allocates a `StreamingMultipartPart` object,
- runs `flattenDicerHeaders` (object allocation),
- queues into the `QueueNotifier`,
- the parser callback runs, possibly accumulating into `MultipartFetchResult.parts`.

Total allocation grows O(N) where N is attacker-controlled. With 1M parts at ~1 KB overhead each, that's 1 GB of heap. Even if the parser returns `undefined` for all, the per-part allocation in flight (queued before parser runs) and the part-stream-destroy bookkeeping is non-trivial. There is no `maxPartsPerEnvelope` cap.

**Recommendation:** Add `FR-DR-S-014 ParseMultipartOptions and MultipartHandlerOptions MUST accept maxParts?: number; default 10_000. When the count is exceeded, the operation rejects with a new MultipartTooManyPartsError and cleanup runs per FR-010.`

**Action rule:** 2

---

## Summary

12 findings. Severity breakdown:

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 6 |
| Low | 3 |

The threat surface is dominated by **resource-exhaustion** (F-S-001, F-S-002, F-S-003, F-S-012) — the spec's "battle-tested" framing focuses on cleanup and timeouts but omits the "attacker controls input volume" axis entirely. Three of the High findings (F-S-001 part-size, F-S-002 timeouts-optional on the lower entry, F-S-003 header-bomb) should block release.

A second cluster is **information leakage via error messages and logger meta** (F-S-005, F-S-006, F-S-007) — the library currently embeds attacker-controlled bytes in error messages and passes raw `Error` objects to caller loggers without sanitization.

The dicer dependency (F-S-008) is an architectural risk the spec acknowledges without committing to a remediation SLA; tightening NFR-004 to include CVE monitoring would close that.

The remaining findings are validation-gap polish (F-S-004 sanitizeFileName, F-S-009 timeout overflow, F-S-011 ReDoS, F-S-010 redirect credentials).
