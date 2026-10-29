import { afterEach, describe, expect, it, vi } from 'vitest';

import { MultipartIdleTimeoutError, MultipartTotalTimeoutError } from '../../src/index.js';
import { setupTimers } from '../../src/internal/timers.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('setupTimers', () => {
  it('measures the total budget from startMs, not from setup', () => {
    vi.useFakeTimers();
    const timers = setupTimers({ idleTimeoutMs: 10_000, totalTimeoutMs: 1_000 }, Date.now() - 400);
    vi.advanceTimersByTime(599);
    expect(timers.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(timers.abortError()).toBeInstanceOf(MultipartTotalTimeoutError);
    timers.cleanup();
  });

  it('fires the total timer at once when the budget is already spent', () => {
    vi.useFakeTimers();
    const timers = setupTimers({ idleTimeoutMs: 10_000, totalTimeoutMs: 100 }, Date.now() - 500);
    vi.advanceTimersByTime(0);
    expect(timers.abortError()).toBeInstanceOf(MultipartTotalTimeoutError);
  });

  it('clears the other timer and the caller listener after the first fire', () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const removeSpy = vi.spyOn(caller.signal, 'removeEventListener');
    const timers = setupTimers(
      { idleTimeoutMs: 100, totalTimeoutMs: 1_000, signal: caller.signal },
      Date.now(),
    );
    vi.advanceTimersByTime(100);
    expect(timers.abortError()).toBeInstanceOf(MultipartIdleTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('stopIdle cancels the running idle timer and later resets', () => {
    vi.useFakeTimers();
    const timers = setupTimers({ idleTimeoutMs: 100, totalTimeoutMs: 10_000 }, Date.now());
    vi.advanceTimersByTime(50);
    timers.stopIdle();
    timers.resetIdle();
    vi.advanceTimersByTime(500);
    expect(timers.signal.aborted).toBe(false);
    timers.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});
