/**
 * Unit tests for `setupTimers` / TimerState (FR-007/FR-008/FR-009/
 * FR-DR-A-025/FR-DR-A-026).
 *
 * Covers:
 *   - resetIdle() resets the idle timer per call
 *   - cleanup() is idempotent
 *   - The composite signal fires for idle / total / caller-abort
 *   - abortError() discriminates the cause
 *   - already-aborted caller signal yields immediate aborted state
 *   - F-S-006: caller signal reason is forwarded verbatim
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MultipartAbortError,
  MultipartIdleTimeoutError,
  MultipartTotalTimeoutError,
} from '../../src/errors.js';
import { setupTimers } from '../../src/internal/timers.js';

describe('setupTimers — idle timer (FR-007 / FR-DR-A-025)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires MultipartIdleTimeoutError when idle window elapses with no resets', () => {
    const t = setupTimers(
      { idleTimeoutMs: 1_000, totalTimeoutMs: 60_000 },
      Date.now(),
    );
    expect(t.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(t.signal.aborted).toBe(true);
    expect(t.abortError()).toBeInstanceOf(MultipartIdleTimeoutError);
    expect((t.abortError() as MultipartIdleTimeoutError).idleTimeoutMs).toBe(
      1_000,
    );
    t.cleanup();
  });

  it('resetIdle() defers the idle fire — slow chunks do NOT timeout', () => {
    const t = setupTimers(
      { idleTimeoutMs: 1_000, totalTimeoutMs: 60_000 },
      Date.now(),
    );
    // Tick close to (but not past) the idle window, reset, repeat 5×.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(900);
      t.resetIdle();
    }
    // Total elapsed: 4500ms; if resetIdle did nothing we'd have aborted at
    // 1000ms. Verify still alive.
    expect(t.signal.aborted).toBe(false);
    // Now stop resetting and confirm the next idle window fires.
    vi.advanceTimersByTime(1_001);
    expect(t.signal.aborted).toBe(true);
    expect(t.abortError()).toBeInstanceOf(MultipartIdleTimeoutError);
    t.cleanup();
  });

  it('resetIdle() is a no-op after cleanup() — does not re-arm the timer', () => {
    const t = setupTimers(
      { idleTimeoutMs: 1_000, totalTimeoutMs: 60_000 },
      Date.now(),
    );
    t.cleanup();
    t.resetIdle();
    vi.advanceTimersByTime(10_000);
    expect(t.signal.aborted).toBe(false);
    expect(t.abortError()).toBeUndefined();
  });
});

describe('setupTimers — total timer (FR-008)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires MultipartTotalTimeoutError when total window elapses regardless of activity', () => {
    const t = setupTimers(
      { idleTimeoutMs: 60_000, totalTimeoutMs: 1_000 },
      Date.now(),
    );
    // Reset idle frequently so it never fires; total still wins.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(150);
      t.resetIdle();
    }
    vi.advanceTimersByTime(500);
    expect(t.signal.aborted).toBe(true);
    expect(t.abortError()).toBeInstanceOf(MultipartTotalTimeoutError);
    expect(
      (t.abortError() as MultipartTotalTimeoutError).totalTimeoutMs,
    ).toBe(1_000);
    t.cleanup();
  });
});

describe('setupTimers — caller AbortSignal (FR-009 / F-S-006)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires MultipartAbortError when caller controller aborts mid-operation', () => {
    const ctrl = new AbortController();
    const t = setupTimers(
      {
        idleTimeoutMs: 60_000,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      },
      Date.now(),
    );
    expect(t.signal.aborted).toBe(false);
    ctrl.abort('user-cancel');
    expect(t.signal.aborted).toBe(true);
    const err = t.abortError();
    expect(err).toBeInstanceOf(MultipartAbortError);
    expect((err as MultipartAbortError).reason).toBe('user-cancel');
    t.cleanup();
  });

  it('F-S-006: forwards Error reason verbatim', () => {
    const ctrl = new AbortController();
    const reasonErr = new Error('domain-specific-cancel');
    const t = setupTimers(
      {
        idleTimeoutMs: 60_000,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      },
      Date.now(),
    );
    ctrl.abort(reasonErr);
    const err = t.abortError() as MultipartAbortError;
    expect(err).toBeInstanceOf(MultipartAbortError);
    expect(err.reason).toBe(reasonErr);
    t.cleanup();
  });

  it('F-S-006: forwards undefined reason as undefined (no synthesis)', () => {
    const ctrl = new AbortController();
    const t = setupTimers(
      {
        idleTimeoutMs: 60_000,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      },
      Date.now(),
    );
    // Calling abort() without an arg leaves reason as the engine default
    // (DOMException "AbortError" in modern Node / DOMException-like). The
    // library forwards whatever the signal exposes as `.reason` verbatim.
    ctrl.abort();
    const err = t.abortError() as MultipartAbortError;
    expect(err).toBeInstanceOf(MultipartAbortError);
    // Reason is whatever ctrl.signal.reason is — the library does NOT
    // override or synthesize. It MUST NOT be a server-derived value.
    expect(err.reason).toBe(ctrl.signal.reason);
    t.cleanup();
  });

  it('F-S-006: caller-supplied reason is NEVER mixed with library-internal data', () => {
    const ctrl = new AbortController();
    const reason = 'external-token-12345';
    const t = setupTimers(
      {
        idleTimeoutMs: 60_000,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      },
      Date.now(),
    );
    ctrl.abort(reason);
    const err = t.abortError() as MultipartAbortError;
    // Verify the message does NOT carry the reason (reason embedding is
    // forbidden by NFR-DR-S-006 — the library never re-emits caller-supplied
    // bytes into the error message).
    expect(err.message).not.toContain(reason);
    expect(err.reason).toBe(reason);
    t.cleanup();
  });

  it('FR-009 already-aborted: setupTimers returns aborted state synchronously', () => {
    const ctrl = new AbortController();
    ctrl.abort('preflight-cancel');
    const t = setupTimers(
      {
        idleTimeoutMs: 60_000,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      },
      Date.now(),
    );
    expect(t.signal.aborted).toBe(true);
    const err = t.abortError() as MultipartAbortError;
    expect(err).toBeInstanceOf(MultipartAbortError);
    expect(err.reason).toBe('preflight-cancel');
    // Idle/total timers should NOT be running at this point — calling
    // cleanup is still safe and idempotent.
    t.cleanup();
    expect(() => t.cleanup()).not.toThrow();
  });
});

describe('setupTimers — cleanup() idempotency', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cleanup() is idempotent — calling twice does not throw', () => {
    const t = setupTimers(
      { idleTimeoutMs: 1_000, totalTimeoutMs: 60_000 },
      Date.now(),
    );
    expect(() => t.cleanup()).not.toThrow();
    expect(() => t.cleanup()).not.toThrow();
  });

  it('cleanup() prevents subsequent timer fires', () => {
    const t = setupTimers(
      { idleTimeoutMs: 100, totalTimeoutMs: 100 },
      Date.now(),
    );
    t.cleanup();
    vi.advanceTimersByTime(1_000);
    expect(t.signal.aborted).toBe(false);
    expect(t.abortError()).toBeUndefined();
  });

  it('cleanup() detaches the caller-signal listener — post-cleanup aborts do not fire', () => {
    const ctrl = new AbortController();
    const t = setupTimers(
      {
        idleTimeoutMs: 60_000,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      },
      Date.now(),
    );
    t.cleanup();
    // The caller signal aborts AFTER cleanup — the combined signal must
    // NOT flip aborted (the listener was removed).
    ctrl.abort('after-cleanup');
    expect(t.signal.aborted).toBe(false);
    expect(t.abortError()).toBeUndefined();
  });
});

describe('setupTimers — race semantics (T-046 foundation)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('first-fire-wins: idle fires first, subsequent abort is ignored', () => {
    const ctrl = new AbortController();
    const t = setupTimers(
      {
        idleTimeoutMs: 100,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      },
      Date.now(),
    );
    // Idle fires first.
    vi.advanceTimersByTime(101);
    expect(t.signal.aborted).toBe(true);
    const firstErr = t.abortError();
    expect(firstErr).toBeInstanceOf(MultipartIdleTimeoutError);

    // Now caller aborts — abortError() must STILL return the idle error.
    ctrl.abort('late-cancel');
    expect(t.abortError()).toBe(firstErr);
    t.cleanup();
  });

  it('first-fire-wins: caller abort first, subsequent idle is ignored', () => {
    const ctrl = new AbortController();
    const t = setupTimers(
      {
        idleTimeoutMs: 100,
        totalTimeoutMs: 60_000,
        signal: ctrl.signal,
      },
      Date.now(),
    );
    ctrl.abort('preempt');
    expect(t.signal.aborted).toBe(true);
    const firstErr = t.abortError();
    expect(firstErr).toBeInstanceOf(MultipartAbortError);

    // The idle timer should have been cleared by abortInternally's cleanup
    // — advancing past the window does not flip the error.
    vi.advanceTimersByTime(10_000);
    expect(t.abortError()).toBe(firstErr);
    t.cleanup();
  });
});

describe('setupTimers — no-op without signal', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('omitting signal works (caller-abort path simply not wired)', () => {
    const t = setupTimers(
      { idleTimeoutMs: 1_000, totalTimeoutMs: 60_000 },
      Date.now(),
    );
    expect(t.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_001);
    expect(t.signal.aborted).toBe(true);
    expect(t.abortError()).toBeInstanceOf(MultipartIdleTimeoutError);
    t.cleanup();
  });

  it('successful-completion path: cleanup before any timer fires', () => {
    const t = setupTimers(
      { idleTimeoutMs: 60_000, totalTimeoutMs: 60_000 },
      Date.now(),
    );
    // Operation completes; cleanup runs.
    t.cleanup();
    expect(t.signal.aborted).toBe(false);
    expect(t.abortError()).toBeUndefined();
  });
});
