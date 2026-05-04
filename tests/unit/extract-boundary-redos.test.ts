/**
 * Dedicated NFR-DR-S-011 assertion (T-080) — sibling to the perf gate in
 * `tests/unit/extract-boundary.test.ts`.
 *
 * NFR-DR-S-011: `extractBoundary` MUST use a non-backtracking regex or a
 * hand-written tokenizer; a 64 KiB pathological `Content-Type` input MUST
 * complete parsing in `< 50 ms`.
 *
 * Duplicating the assertion in a separate file keeps the contract obvious
 * for future hardening passes.
 */
import { describe, expect, it } from 'vitest';

import { extractBoundary } from '../../src/extract-boundary.js';

describe('extractBoundary — T-080: NFR-DR-S-011 ReDoS-resistance perf gate', () => {
  it('parses a 64 KiB pathological input in well under 50 ms (mean over 10 iterations)', () => {
    // Pathological input per kiln/spec/test-plan.md row T-080:
    //   `multipart/related; boundary="' + '\\\"'.repeat(32_000) + '"`
    // ~64 KiB total: 32k pairs of `\"` inside a quoted string. A naive
    // backtracking regex with alternation between the quoted-string and
    // bare-token forms could explode here with O(2^n) scanning. The
    // hand-written tokenizer in src/extract-boundary.ts is O(n) by
    // construction — every char is consumed exactly once.
    const pathological =
      'multipart/related; boundary="' + '\\"'.repeat(32_000) + '"';
    // Sanity-check the input size matches the planner's intent.
    // Approximate length: 30 (prefix) + 64_000 (escape pairs) + 1 (close
    // quote) ≈ 64 KiB. Off-by-a-few-bytes is fine — the perf gate is what
    // matters, not the exact size.
    expect(pathological.length).toBeGreaterThan(60_000);
    expect(pathological.length).toBeLessThan(70_000);

    const ITERATIONS = 10;
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      try {
        // The result is irrelevant; we measure wall time. With the
        // hand-written tokenizer the call returns a quoted-string value
        // built up via single-pass scan; in a future regression the
        // result would still be correct, but the timing would balloon.
        extractBoundary(pathological);
      } catch {
        // The tokenizer might throw on edge cases as the implementation
        // evolves (e.g. unterminated escape) — we still want the timing.
      }
    }
    const totalMs = performance.now() - start;
    const meanMs = totalMs / ITERATIONS;

    // The 50 ms gate per NFR-DR-S-011. The hand-written tokenizer
    // typically runs sub-millisecond for this input on modern hardware;
    // the >5x slack absorbs CI noise. A failing assertion would mean a
    // backtracking regex regression.
    expect(meanMs).toBeLessThan(50);
  });

  it('handles a separator-heavy 64 KiB input (different attack shape)', () => {
    // Alternative pathological input: a long parameter list with no
    // boundary parameter. Forces the tokenizer to walk every char before
    // throwing the "boundary parameter missing" error. Should still be
    // O(n) — the parameter-walk loop never backtracks.
    const params = ('foo=bar; '.repeat(8000)).slice(0, 64_000);
    const pathological = `multipart/related; ${params}`;

    const ITERATIONS = 10;
    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      try {
        extractBoundary(pathological);
      } catch {
        // Expected — boundary parameter is missing.
      }
    }
    const totalMs = performance.now() - start;
    const meanMs = totalMs / ITERATIONS;

    expect(meanMs).toBeLessThan(50);
  });
});
