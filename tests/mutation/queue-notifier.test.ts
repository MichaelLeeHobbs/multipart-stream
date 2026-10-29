import { describe, expect, it } from 'vitest';

import { createQueueNotifier } from '../../src/internal/queue-notifier.js';

describe('createQueueNotifier', () => {
  it('queues a single end however often it is signalled', () => {
    const queue = createQueueNotifier();
    queue.signalEnd();
    queue.signalEnd();
    expect(queue.pending).toEqual([{ type: 'end' }]);
  });
});
