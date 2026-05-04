import { describe, expect, it } from 'vitest';

import { createQueueNotifier } from '../../src/internal/queue-notifier.js';
import type { StreamingMultipartPart } from '../../src/types.js';

/**
 * Stub helpers for tests — we only need a `StreamingMultipartPart`-shaped
 * object for queue-shape assertions; the body Readable is never read here.
 */
function makePart(index: number): StreamingMultipartPart {
  return {
    index,
    boundary: 'TEST',
    headers: {},
    rawHeaders: Buffer.alloc(0),
    contentType: '',
    body: undefined as unknown as StreamingMultipartPart['body'],
  };
}

describe('createQueueNotifier — push/next ordering', () => {
  it('returns buffered items in FIFO order', async () => {
    const q = createQueueNotifier();
    q.push({ type: 'part', part: makePart(0) });
    q.push({ type: 'part', part: makePart(1) });
    q.push({ type: 'part', part: makePart(2) });
    q.signalEnd();

    const a = await q.next();
    const b = await q.next();
    const c = await q.next();
    const d = await q.next();

    expect(a.type === 'part' && a.part.index === 0).toBe(true);
    expect(b.type === 'part' && b.part.index === 1).toBe(true);
    expect(c.type === 'part' && c.part.index === 2).toBe(true);
    expect(d.type).toBe('end');
  });

  it('next() awaits a future push and resolves on the same tick the push fires', async () => {
    const q = createQueueNotifier();
    const promise = q.next();
    q.push({ type: 'part', part: makePart(42) });
    const got = await promise;
    expect(got.type === 'part' && got.part.index === 42).toBe(true);
  });

  it('signalEnd is idempotent — second call is a no-op', async () => {
    const q = createQueueNotifier();
    q.signalEnd();
    q.signalEnd();
    const got = await q.next();
    expect(got.type).toBe('end');
  });

  it('error pushes are surfaced from next() in order', async () => {
    const q = createQueueNotifier();
    q.push({ type: 'part', part: makePart(0) });
    q.signalError(new Error('boom'));
    q.signalEnd();

    const a = await q.next();
    const b = await q.next();
    const c = await q.next();

    expect(a.type === 'part').toBe(true);
    expect(b.type === 'error' && b.err.message === 'boom').toBe(true);
    expect(c.type).toBe('end');
  });

  it('part pushes after signalEnd are ignored (idempotency guard)', async () => {
    const q = createQueueNotifier();
    q.signalEnd();
    q.push({ type: 'part', part: makePart(99) });

    const got = await q.next();
    expect(got.type).toBe('end');
    // queue.pending should not contain the dropped part
    expect(q.pending.length).toBe(0);
  });

  it('error pushes after signalEnd ARE permitted (late-emit path)', async () => {
    const q = createQueueNotifier();
    q.signalEnd();
    const got = await q.next();
    expect(got.type).toBe('end');
    // After end has been delivered, an error push is buffered.
    q.signalError(new Error('late'));
    const errItem = await q.next();
    expect(errItem.type === 'error' && errItem.err.message === 'late').toBe(
      true,
    );
  });

  it('pending exposes the buffered items as a readonly snapshot', () => {
    const q = createQueueNotifier();
    q.push({ type: 'part', part: makePart(1) });
    q.push({ type: 'part', part: makePart(2) });
    expect(q.pending).toHaveLength(2);
  });
});

describe('createQueueNotifier — drainPendingParts (cleanup hook)', () => {
  it('returns and clears every pending part item', () => {
    const q = createQueueNotifier();
    q.push({ type: 'part', part: makePart(0) });
    q.push({ type: 'part', part: makePart(1) });
    q.push({ type: 'part', part: makePart(2) });

    const drained = q.drainPendingParts();
    expect(drained).toHaveLength(3);
    expect(drained[0]!.index).toBe(0);
    expect(drained[1]!.index).toBe(1);
    expect(drained[2]!.index).toBe(2);

    // Buffer is now empty of part items.
    expect(q.pending).toHaveLength(0);
  });

  it('preserves non-part items (end / error) in place', () => {
    const q = createQueueNotifier();
    q.push({ type: 'part', part: makePart(0) });
    q.push({ type: 'error', err: new Error('boom') });
    q.push({ type: 'part', part: makePart(1) });

    const drained = q.drainPendingParts();
    expect(drained).toHaveLength(2);
    expect(drained[0]!.index).toBe(0);
    expect(drained[1]!.index).toBe(1);

    // The error item remains in `pending` so the consumer's next .next()
    // call still sees it.
    expect(q.pending).toHaveLength(1);
    const remaining = q.pending[0]!;
    expect(remaining.type).toBe('error');
  });

  it('is idempotent — second call returns empty and leaves remaining items alone', () => {
    const q = createQueueNotifier();
    q.push({ type: 'part', part: makePart(0) });
    q.push({ type: 'error', err: new Error('boom') });

    const first = q.drainPendingParts();
    expect(first).toHaveLength(1);

    const second = q.drainPendingParts();
    expect(second).toHaveLength(0);
    expect(q.pending).toHaveLength(1);
  });

  it('returns empty when no parts are pending', () => {
    const q = createQueueNotifier();
    expect(q.drainPendingParts()).toHaveLength(0);
  });
});
