/**
 * Queue+notifier bridge between dicer's event-emitter shape and the async
 * generator returned by `parseMultipartRelated`.
 *
 * Per `kiln/spec/architecture.md` §3 and `kiln/spec/data-model.md` §2.1/§2.2: a
 * single-producer / single-consumer bounded async queue. Dicer's `'part'` /
 * `'finish'` / `'error'` event handlers `push` items synchronously; the
 * generator's main loop awaits `next()` until an item is enqueued.
 *
 * The simplest correct shape: an unbounded array + a single resolver pair.
 * Backpressure is not required (dicer is a `Writable` and handles its own
 * backpressure via the `pipe()` from the source `Readable`).
 *
 * Items are tagged with a discriminated union so callers can distinguish
 * part-events from end-of-stream and error sentinels without ambiguity.
 *
 * @internal
 */

import type { StreamingMultipartPart } from '../types.js';

/** Discriminated union of items the queue carries. */
export type QueueItem =
  | { readonly type: 'part'; readonly part: StreamingMultipartPart }
  | { readonly type: 'end' }
  | { readonly type: 'error'; readonly err: Error };

/**
 * Internal queue+notifier shape. See `src/internal/queue-notifier.ts` for
 * the public surface — note this interface is NOT re-exported.
 *
 * @internal
 */
export interface QueueNotifier {
  /**
   * Synchronously enqueue an item. If a consumer is waiting on `next()`, the
   * waiter is resolved on the same tick. If the queue has already been ended
   * or errored, the push is ignored (idempotency guard for the cleanup
   * path).
   */
  push(item: QueueItem): void;

  /**
   * Convenience: push an `end` sentinel exactly once. Subsequent calls are
   * ignored.
   */
  signalEnd(): void;

  /**
   * Convenience: push an `error` sentinel. The queue accepts multiple error
   * pushes (e.g. dicer + source both fail) — the consumer drains the first
   * one and the rest stay buffered for the cleanup path.
   */
  signalError(err: Error): void;

  /**
   * Pull the next item, or wait until one is available. Resolves with the
   * `end` sentinel when `signalEnd` has been called and the buffered items
   * are drained.
   */
  next(): Promise<QueueItem>;

  /**
   * Read-only snapshot of pending items (used at cleanup time for
   * draining).
   */
  readonly pending: readonly QueueItem[];

  /**
   * Cleanup-path helper: extract every still-pending `'part'` item, remove
   * them from the buffer, and return them so the iterator's finally can
   * destroy each `.body`. Non-part items (`'end'`, `'error'`) are left in
   * place so the consumer's next `.next()` call still sees them.
   *
   * Idempotent: calling twice returns an empty array on the second call.
   *
   * Used by the cleanup path in `parseMultipartRelated` (FR-010).
   */
  drainPendingParts(): readonly StreamingMultipartPart[];
}

/**
 * Construct a fresh `QueueNotifier`.
 *
 * @internal
 */
export function createQueueNotifier(): QueueNotifier {
  const items: QueueItem[] = [];
  let waiter: ((item: QueueItem) => void) | null = null;
  let ended = false;

  const push = (item: QueueItem): void => {
    if (ended && item.type !== 'end' && item.type !== 'error') {
      // After an `end` has been delivered, only further error pushes are
      // permitted (cleanup may surface late errors). Drop part pushes
      // silently — the dicer state machine has already declared the
      // stream finished.
      return;
    }
    if (item.type === 'end') {
      if (ended) return;
      ended = true;
    }
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(item);
      return;
    }
    items.push(item);
  };

  const signalEnd = (): void => {
    push({ type: 'end' });
  };

  const signalError = (err: Error): void => {
    push({ type: 'error', err });
  };

  const next = (): Promise<QueueItem> => {
    const buffered = items.shift();
    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }
    return new Promise<QueueItem>((resolve) => {
      waiter = resolve;
    });
  };

  const drainPendingParts = (): readonly StreamingMultipartPart[] => {
    const parts: StreamingMultipartPart[] = [];
    const remaining: QueueItem[] = [];
    for (const item of items) {
      if (item.type === 'part') {
        parts.push(item.part);
      } else {
        remaining.push(item);
      }
    }
    items.length = 0;
    items.push(...remaining);
    return parts;
  };

  return {
    push,
    signalEnd,
    signalError,
    next,
    get pending(): readonly QueueItem[] {
      return items;
    },
    drainPendingParts,
  };
}
