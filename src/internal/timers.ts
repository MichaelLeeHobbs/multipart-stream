/**
 * `TimerState` — composite abort plumbing for `parseMultipartRelated`'s
 * idle timeout, total timeout, and caller-provided `AbortSignal`. Per
 * `kiln/spec/data-model.md` §2.3 and `kiln/spec/architecture.md` §3 (Layer A owns the
 * timers per FR-DR-A-026), this module is the single source for all four
 * termination-by-time signals: idle, total, caller abort, parser-throw /
 * source-error.
 *
 * Design:
 * - One internal `AbortController`. The `signal` exposed publicly is its
 *   `signal`, which fires on FIRST-fire-wins basis from any of the three
 *   sources (idle / total / caller).
 * - `idleTimer` is reset by the per-chunk `'data'` listener attached to the
 *   source `Readable` inside `parseMultipartRelated` (FR-DR-A-025 — onProgress
 *   is NOT used for this).
 * - `totalTimer` runs once from `setupTimers` entry; never resets.
 * - The caller's `AbortSignal` (when supplied) gets a one-shot `abort` listener
 *   that fires `abortInternally(MultipartAbortError(opts.signal.reason))`. If
 *   the signal is ALREADY aborted at call time, `setupTimers` synchronously
 *   stores the abort error and aborts the controller — `signal.aborted` is
 *   `true` by the time the function returns. Caller (parseMultipartRelated)
 *   checks this BEFORE entering its for-await loop and rejects the iterator
 *   on first `.next()` per the FR-009 already-aborted contract.
 *
 * Idempotency:
 * - `cleanup()` is guarded with a `cleaned` flag — first call cancels both
 *   timers and removes the caller-signal listener; subsequent calls are
 *   no-ops.
 * - `abortInternally(err)` ignores subsequent calls once aborted (the stored
 *   error is the FIRST fire — caller signal racing with idle timer keeps the
 *   first-fire error).
 *
 * @internal
 */

import {
  MultipartAbortError,
  MultipartIdleTimeoutError,
  MultipartTotalTimeoutError,
} from '../errors.js';

/**
 * Options passed to {@link setupTimers}.
 *
 * @internal
 */
export interface TimerStateOptions {
  /** Idle window in ms. Validated upstream; assumed in `[1, 2^31-1]`. */
  readonly idleTimeoutMs: number;
  /** Total wallclock budget in ms. Validated upstream. */
  readonly totalTimeoutMs: number;
  /** Caller's `AbortSignal`, or omitted. Reason is forwarded verbatim. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * State bundle returned by {@link setupTimers}. The signal aggregates idle +
 * total + caller-signal abort. `resetIdle()` is hot-pathed (called per source
 * chunk); `cleanup()` is idempotent (called from the iterator's `finally`).
 *
 * @internal
 */
export interface TimerState {
  /**
   * Combined `AbortSignal` — fires when ANY of: idle timer / total timer /
   * caller signal aborts. After a fire, {@link abortError} returns the
   * specific error class corresponding to the cause.
   */
  readonly signal: AbortSignal;

  /**
   * Reset the idle timer. Called from the per-chunk source `'data'` listener
   * inside `parseMultipartRelated` (FR-DR-A-025). Cheap — clears and re-arms
   * the existing timer.
   *
   * No-op once `cleanup()` has run or the signal has already aborted (the
   * combined signal can't un-abort).
   */
  resetIdle(): void;

  /**
   * Cancel both timers and detach the caller-signal listener. Idempotent.
   * Called from the iterator's `finally` block — paired with the
   * `cleanup()` function via the `cleaned` flag in
   * `parse-multipart-related.ts`.
   */
  cleanup(): void;

  /**
   * The error that caused the abort, when available. Resolved AFTER the
   * combined `signal` fires — discriminates idle / total / caller-abort via
   * the returned class type. Returns `undefined` if the signal has not yet
   * fired (e.g. successful operation, cleanup before any timer expired).
   */
  readonly abortError: () => Error | undefined;
}

/**
 * Construct a fresh {@link TimerState} for one operation.
 *
 * Side-effects fired immediately on entry:
 *  1. Two `setTimeout` calls (idle + total) — both armed before the function
 *     returns so they cover the entire operation lifetime per FR-012's
 *     "before pipe()" invariant.
 *  2. If `opts.signal` is already aborted, the controller is aborted
 *     synchronously and a {@link MultipartAbortError} is stored as the abort
 *     reason. `state.signal.aborted` will be `true` on return.
 *  3. If `opts.signal` is provided and not yet aborted, an `'abort'` listener
 *     is attached to it. The listener forwards `signal.reason` verbatim into
 *     a new `MultipartAbortError` — F-S-006 contract.
 *
 * @param opts - Idle/total timeouts (already validated by caller) and
 *   optional caller `AbortSignal`.
 * @param startMs - The wallclock start time of the operation. Reserved for
 *   computing `elapsedMs` in future error variants; the current error
 *   classes take only the configured cap, so this parameter is currently
 *   unused.
 *
 * @internal
 */
export function setupTimers(
  opts: TimerStateOptions,
  startMs: number,
): TimerState {
  const controller = new AbortController();
  const callerSignal = opts.signal;

  let storedError: Error | undefined;
  let cleaned = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  // Single-shot abort: stores the error, aborts the controller, then runs
  // cleanup so timers don't continue ticking after the first fire. Subsequent
  // calls are no-ops because `controller.signal.aborted` is already true and
  // the stored error stays at its first-fire value.
  const abortInternally = (err: Error): void => {
    if (controller.signal.aborted) return;
    storedError = err;
    controller.abort(err);
    runCleanup();
  };

  const onCallerAbort = (): void => {
    // The caller signal owns its own `reason` (could be undefined, a string,
    // or an Error). F-S-006: the library MUST NOT synthesize a reason that
    // embeds server-derived bytes — we forward `callerSignal.reason` verbatim.
    abortInternally(new MultipartAbortError(callerSignal?.reason));
  };

  const onIdle = (): void => {
    abortInternally(new MultipartIdleTimeoutError(opts.idleTimeoutMs));
  };

  const onTotal = (): void => {
    abortInternally(new MultipartTotalTimeoutError(opts.totalTimeoutMs));
  };

  function runCleanup(): void {
    if (cleaned) return;
    cleaned = true;
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (totalTimer !== undefined) {
      clearTimeout(totalTimer);
      totalTimer = undefined;
    }
    if (callerSignal !== undefined) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  const resetIdle = (): void => {
    if (cleaned || controller.signal.aborted) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(onIdle, opts.idleTimeoutMs);
  };

  // FR-009 already-aborted check: if the caller signal is aborted at call
  // time we must short-circuit synchronously. We forward signal.reason
  // verbatim into the MultipartAbortError. The `cleaned` short-circuit in
  // resetIdle/abortInternally guarantees no follow-on timer can race against
  // this.
  if (callerSignal?.aborted) {
    storedError = new MultipartAbortError(callerSignal.reason);
    controller.abort(storedError);
    // Do NOT install the abort listener on an already-aborted signal — Node
    // would deliver the event immediately, but abortInternally would no-op
    // since controller.signal.aborted is already true. Skipping the
    // attach is symmetric with cleanup's removeEventListener.
  } else {
    if (callerSignal !== undefined) {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    idleTimer = setTimeout(onIdle, opts.idleTimeoutMs);
    totalTimer = setTimeout(onTotal, opts.totalTimeoutMs);
  }

  // The `startMs` parameter is currently unused by the error classes
  // (the error fields don't embed `elapsedMs`) but threaded through for
  // forward-compat with NFR-DR-S-006's potential expansion.
  void startMs;

  return {
    signal: controller.signal,
    resetIdle,
    cleanup: runCleanup,
    abortError: () => storedError,
  };
}
