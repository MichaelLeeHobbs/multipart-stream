/**
 * Round 2: a Node Readable that is already destroyed (or already errored)
 * when handed to parseMultipartRelated never emits 'close' / 'error' again,
 * so `onSourceClose` / `onSourceError` never run. The iterator sits until
 * the idle timer fires and then reports MultipartIdleTimeoutError — the
 * source's own error is lost and the caller waits a full idleTimeoutMs.
 */
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { MultipartTruncatedError, parseMultipartRelated } from '../../src/index.js';

const drain = async (source: Readable): Promise<void> => {
  for await (const part of parseMultipartRelated(source, {
    idleTimeoutMs: 200,
    totalTimeoutMs: 5_000,
    boundary: 'b',
  })) {
    part.body.destroy();
  }
};

describe('round2: source already destroyed at call time', () => {
  it('a destroyed source rejects as truncated, not as an idle timeout', async () => {
    const source = new Readable({
      read() {
        /* pushed by the test */
      },
    });
    source.destroy();
    await new Promise((r) => setImmediate(r));
    await expect(drain(source)).rejects.toBeInstanceOf(MultipartTruncatedError);
  });

  it("an errored source rejects with the source's own error", async () => {
    const boom = new Error('connection reset');
    const source = new Readable({
      read() {
        /* pushed by the test */
      },
    });
    source.on('error', () => undefined);
    source.destroy(boom);
    await new Promise((r) => setImmediate(r));
    await expect(drain(source)).rejects.toBe(boom);
  });
});
