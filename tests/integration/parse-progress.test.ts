import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  parseMultipartRelated,
  type ProgressSnapshot,
  streamToString,
} from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const BOUNDARY = 'X-PROGRESS-BOUNDARY';
const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

describe('parseMultipartRelated — onProgress per yielded part (T-014 partial)', () => {
  it('fires onProgress at least once per yielded part with monotonic non-decreasing bytes', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        { headers: { 'Content-Type': 'text/plain' }, body: 'first' },
        { headers: { 'Content-Type': 'text/plain' }, body: 'second' },
        { headers: { 'Content-Type': 'text/plain' }, body: 'third' },
      ],
    });

    const calls: ProgressSnapshot[] = [];
    const onProgress = vi.fn((snap: ProgressSnapshot) => {
      calls.push(snap);
    });

    for await (const part of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
      onProgress,
    })) {
      await streamToString(part.body);
    }

    // FR-013: at least one call per yielded part. The completion-tick
    // assertion is owned by `fetchAndHandleMultipart`.
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Bytes are monotonic non-decreasing across calls.
    let prev = -1;
    for (const snap of calls) {
      expect(typeof snap.bytes).toBe('number');
      expect(snap.bytes).toBeGreaterThanOrEqual(prev);
      prev = snap.bytes;
    }

    // rateBps is finite (FR-013 / data-model.md §1.6: `0` when elapsed
    // is 0; otherwise a finite positive number).
    for (const snap of calls) {
      expect(Number.isFinite(snap.rateBps)).toBe(true);
      expect(snap.rateBps).toBeGreaterThanOrEqual(0);
    }

    // elapsedMs is non-negative.
    for (const snap of calls) {
      expect(snap.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('onProgress throwing a non-Error value still routes through logger (covers err-not-Error fallback)', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [{ headers: { 'Content-Type': 'text/plain' }, body: 'x' }],
    });
    const loggerCalls: Array<{
      level: 'warn';
      msg: string;
      meta?: unknown;
    }> = [];
    const logger = vi.fn(
      (event: { level: 'warn'; msg: string; meta?: unknown }) => {
        loggerCalls.push(event);
      },
    );
    const onProgress = vi.fn(() => {
      // Throw a string instead of an Error — exercises the
      // `err instanceof Error ? err.name : 'Error'` fallback branch.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'not-an-error';
    });

    for await (const part of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
      onProgress,
      logger,
    })) {
      await streamToString(part.body);
    }

    expect(loggerCalls.length).toBeGreaterThanOrEqual(1);
    const meta = loggerCalls[0]!.meta as {
      errSummary: { name: string; message: string };
    };
    expect(meta.errSummary.name).toBe('Error');
    // Messages are JSON-stringified per NFR-DR-S-006.
    expect(meta.errSummary.message).toBe('"not-an-error"');
  });

  it('onProgress callback throwing does NOT derail parsing (FR-017 — onProgress site)', async () => {
    // The onProgress catch site is owned by Layer A: "onProgress is
    // INFORMATIONAL only — there is intentionally no idle-reset wiring
    // through it." The other two FR-017 sites (onSourceBytes, src.unpipe)
    // live in the cleanup path.
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        { headers: { 'Content-Type': 'text/plain' }, body: 'one' },
        { headers: { 'Content-Type': 'text/plain' }, body: 'two' },
      ],
    });
    const loggerCalls: Array<{
      level: 'warn';
      msg: string;
      meta?: unknown;
    }> = [];
    const logger = vi.fn(
      (event: { level: 'warn'; msg: string; meta?: unknown }) => {
        loggerCalls.push(event);
      },
    );
    const onProgress = vi.fn(() => {
      throw new Error('progress sink died');
    });

    const collected: string[] = [];
    for await (const part of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
      onProgress,
      logger,
    })) {
      collected.push(await streamToString(part.body));
    }

    expect(collected).toEqual(['one', 'two']);
    // Each yielded part triggered an onProgress, each onProgress threw,
    // each throw was caught and logged.
    expect(loggerCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of loggerCalls) {
      expect(call.level).toBe('warn');
      expect(call.msg).toMatch(/onProgress threw/);
    }
  });
});
