/**
 * Integration tests for `parseMultipartRelated` AbortSignal propagation
 * (FR-009 / F-S-006).
 *
 * Covers:
 *   - T-012: mid-stream abort → MultipartAbortError, source destroyed
 *   - T-013: already-aborted signal → synchronous reject from first .next()
 *   - T-046: concurrent abort + idle-fire race → first-fire wins, cleanup
 *     idempotent (no double-destroy, listener counts stable)
 *   - F-S-006 reason-verbatim contract: caller-supplied reason flows into
 *     MultipartAbortError.reason without modification or library-derived
 *     synthesis.
 */

import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MultipartAbortError,
  MultipartIdleTimeoutError,
  parseMultipartRelated,
  streamToString,
} from '../../src/index.js';
import {
  captureDicerActivity,
  type DicerActivityTracker,
} from '../fixtures/dicer-activity.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const BOUNDARY = 'ABORT-BOUNDARY';

function buildEnvelope(partCount: number): Buffer {
  return buildMultipartBody({
    boundary: BOUNDARY,
    parts: Array.from({ length: partCount }, (_, i) => ({
      headers: {
        'Content-Type': 'text/plain',
        'Content-ID': `<part-${String(i)}>`,
      },
      body: `body-${String(i)}`,
    })),
  });
}

/** A stalled source — first chunk fires after gapMs, then silence forever. */
function stalledReadable(chunks: readonly Buffer[], gapMs: number): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i >= chunks.length) return; // stall — no end, no further data
      const idx = i++;
      setTimeout(() => {
        this.push(chunks[idx]);
      }, gapMs);
    },
  });
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('parseMultipartRelated — T-013: already-aborted signal (FR-009)', () => {
  it('first .next() rejects synchronously with MultipartAbortError', async () => {
    const ctrl = new AbortController();
    ctrl.abort('preflight');

    const source = Readable.from(buildEnvelope(2));
    const iter = parseMultipartRelated(source, {
      boundary: BOUNDARY,
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 60_000,
      signal: ctrl.signal,
    });

    let captured: unknown;
    try {
      await iter.next();
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(MultipartAbortError);
    expect((captured as MultipartAbortError).reason).toBe('preflight');
  });

  it('cleanup runs even on the early-throw path (source destroyed)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    const source = Readable.from(buildEnvelope(2));
    const iter = parseMultipartRelated(source, {
      boundary: BOUNDARY,
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 60_000,
      signal: ctrl.signal,
    });
    try {
      await iter.next();
    } catch {
      // expected
    }
    // The iterator's finally has run by the time .next() rejected.
    await settle();
    expect(source.destroyed).toBe(true);
  });
});

describe('parseMultipartRelated — T-012: mid-stream abort', () => {
  it('rejects with MultipartAbortError; source destroyed', async () => {
    const ctrl = new AbortController();
    const buf = buildEnvelope(5);
    const source = Readable.from(buf);

    let captured: unknown;
    try {
      let i = 0;
      for await (const part of parseMultipartRelated(source, {
        boundary: BOUNDARY,
        idleTimeoutMs: 60_000,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      })) {
        await streamToString(part.body);
        // Abort after the first part is consumed.
        if (i === 0) ctrl.abort('mid-stream-cancel');
        i += 1;
      }
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(MultipartAbortError);
    expect((captured as MultipartAbortError).reason).toBe('mid-stream-cancel');
    await settle();
    expect(source.destroyed).toBe(true);
  });

  it('after abort fires, the in-flight body is destroyed (no further data flow)', async () => {
    // The library's FR-010 cleanup destroys the in-flight part body when
    // the abort lands. We capture the body Readable and assert it ends up
    // destroyed after the iterator's finally runs.
    const ctrl = new AbortController();
    const buf = buildEnvelope(3);
    const source = Readable.from(buf);
    let capturedBody: Readable | undefined;

    try {
      for await (const part of parseMultipartRelated(source, {
        boundary: BOUNDARY,
        idleTimeoutMs: 60_000,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      })) {
        capturedBody = part.body;
        ctrl.abort();
      }
    } catch {
      // expected
    }
    await settle();
    // The body Readable was destroyed by the cleanup function — no further
    // data can flow. (drain-on-finally / part-stream cleanup contract)
    expect(capturedBody).toBeDefined();
    expect(capturedBody?.destroyed).toBe(true);
    expect(source.destroyed).toBe(true);
  });
});

describe('parseMultipartRelated — F-S-006 reason contract', () => {
  it('forwards a string reason verbatim', async () => {
    const ctrl = new AbortController();
    ctrl.abort('plain-string-reason');
    const iter = parseMultipartRelated(
      Readable.from(buildEnvelope(1)),
      {
        boundary: BOUNDARY,
        idleTimeoutMs: 5_000,
        totalTimeoutMs: 5_000,
        signal: ctrl.signal,
      },
    );
    let captured: unknown;
    try {
      await iter.next();
    } catch (err) {
      captured = err;
    }
    const err = captured as MultipartAbortError;
    expect(err.reason).toBe('plain-string-reason');
    // Library MUST NOT embed the reason string into the message
    // (NFR-DR-S-006 — attacker bytes don't flow into log lines via this path).
    expect(err.message).not.toContain('plain-string-reason');
  });

  it('forwards an Error reason verbatim (preserves identity)', async () => {
    const ctrl = new AbortController();
    const reason = new Error('caller-domain-error');
    ctrl.abort(reason);
    const iter = parseMultipartRelated(
      Readable.from(buildEnvelope(1)),
      {
        boundary: BOUNDARY,
        idleTimeoutMs: 5_000,
        totalTimeoutMs: 5_000,
        signal: ctrl.signal,
      },
    );
    let captured: unknown;
    try {
      await iter.next();
    } catch (err) {
      captured = err;
    }
    const err = captured as MultipartAbortError;
    expect(err.reason).toBe(reason); // same object reference
  });

  it('omitting reason yields .reason === signal.reason (engine-default DOMException)', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const iter = parseMultipartRelated(
      Readable.from(buildEnvelope(1)),
      {
        boundary: BOUNDARY,
        idleTimeoutMs: 5_000,
        totalTimeoutMs: 5_000,
        signal: ctrl.signal,
      },
    );
    let captured: unknown;
    try {
      await iter.next();
    } catch (err) {
      captured = err;
    }
    const err = captured as MultipartAbortError;
    // The library NEVER synthesizes a reason — it forwards whatever the
    // signal's `.reason` is. With no explicit arg, that's a DOMException
    // ("This operation was aborted") in modern Node. We assert that
    // .reason is exactly === ctrl.signal.reason (no library-side wrapping).
    expect(err.reason).toBe(ctrl.signal.reason);
  });

  it('library does NOT embed source bytes / URL / headers into reason', async () => {
    // Drive a real envelope; abort with a "neutral" caller reason; verify
    // the resulting MultipartAbortError.reason carries the caller value
    // verbatim and contains zero parts of the multipart body.
    const ctrl = new AbortController();
    const buf = buildEnvelope(3);
    const source = Readable.from(buf);
    const callerReason = { code: 'CALLER_OWN', tag: 'no-server-bytes' };

    let captured: unknown;
    try {
      for await (const part of parseMultipartRelated(source, {
        boundary: BOUNDARY,
        idleTimeoutMs: 60_000,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      })) {
        await streamToString(part.body);
        ctrl.abort(callerReason);
      }
    } catch (err) {
      captured = err;
    }
    const err = captured as MultipartAbortError;
    expect(err).toBeInstanceOf(MultipartAbortError);
    // Identity-equal: not wrapped, not JSON-stringified, not cloned.
    expect(err.reason).toBe(callerReason);
    // No leakage of envelope bytes into reason or message.
    const stringified = JSON.stringify(err.reason);
    expect(stringified).not.toContain('body-0');
    expect(stringified).not.toContain(BOUNDARY);
    expect(err.message).not.toContain('body-0');
    expect(err.message).not.toContain(BOUNDARY);
  });
});

describe('parseMultipartRelated — T-046: race semantics (abort + idle on same tick)', () => {
  let tracker: DicerActivityTracker;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    tracker = captureDicerActivity();
  });
  afterEach(() => {
    tracker.restore();
    vi.useRealTimers();
  });

  it('concurrent abort + idle-fire same tick: ONE error surfaces; cleanup is idempotent', async () => {
    // Build a stalled source that pushes one chunk at t=100ms, then sits
    // silent. Idle window is 1_000ms (so idle fires at t=1_100ms). We
    // schedule a caller abort at t=1_100ms via setTimeout — both fire in
    // the same fake-timer macrotask.
    const buf = buildEnvelope(2);
    const head = buf.subarray(0, 30);
    const source = stalledReadable([head], 100);
    const ctrl = new AbortController();

    const iter = parseMultipartRelated(source, {
      boundary: BOUNDARY,
      idleTimeoutMs: 1_000,
      totalTimeoutMs: 60_000,
      signal: ctrl.signal,
    });

    setTimeout(() => ctrl.abort('race'), 1_100);

    const consumePromise = (async () => {
      try {
        for await (const part of iter) {
          await streamToString(part.body).catch(() => undefined);
        }
      } catch (err) {
        return err;
      }
      return undefined;
    })();

    await vi.advanceTimersByTimeAsync(2_000);
    const captured = await consumePromise;

    // Either MultipartIdleTimeoutError or MultipartAbortError can win.
    // First-fire-wins is the contract; the test asserts:
    //   (a) exactly one specific error class surfaces
    //   (b) cleanup ran (source destroyed, listeners cleaned)
    expect(
      captured instanceof MultipartIdleTimeoutError ||
        captured instanceof MultipartAbortError,
    ).toBe(true);

    await settle();
    // Listener-leak harness assertions — same shape as parse-cleanup's suite.
    expect(source.destroyed).toBe(true);
    for (const dicer of tracker.dicerInstances()) {
      expect(dicer.listenerCount('part')).toBe(0);
      expect(dicer.listenerCount('finish')).toBe(0);
      // FR-011 retention: the 'error' listener is intentionally kept.
      expect(dicer.listenerCount('error')).toBeGreaterThanOrEqual(1);
    }
    for (const part of tracker.partStreams()) {
      expect(part.destroyed).toBe(true);
    }
  });
});

describe('parseMultipartRelated — abort cleanup symmetry', () => {
  let tracker: DicerActivityTracker;
  beforeEach(() => {
    tracker = captureDicerActivity();
  });
  afterEach(() => {
    tracker.restore();
  });

  it('abort path goes through the same cleanup as the other termination paths', async () => {
    const ctrl = new AbortController();
    const buf = buildEnvelope(3);
    const source = Readable.from(buf);

    try {
      let i = 0;
      for await (const part of parseMultipartRelated(source, {
        boundary: BOUNDARY,
        idleTimeoutMs: 60_000,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      })) {
        await streamToString(part.body);
        if (i === 0) ctrl.abort();
        i += 1;
      }
    } catch {
      // expected
    }

    await settle();
    expect(source.destroyed).toBe(true);
    for (const dicer of tracker.dicerInstances()) {
      expect(dicer.listenerCount('part')).toBe(0);
      expect(dicer.listenerCount('finish')).toBe(0);
      expect(dicer.listenerCount('error')).toBeGreaterThanOrEqual(1);
    }
    for (const part of tracker.partStreams()) {
      expect(part.destroyed).toBe(true);
    }
  });
});
