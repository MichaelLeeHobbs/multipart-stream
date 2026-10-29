import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated } from '../../src/index.js';

describe('review: maxPartBytes keeps body backpressure', () => {
  it('does not buffer the whole part into the counter when the consumer is not reading', async () => {
    const src = new PassThrough();
    src.write('--B\r\nContent-Type: application/octet-stream\r\n\r\n');
    const chunk = Buffer.alloc(64 * 1024, 1);
    let written = 0;
    const pump = setInterval(() => {
      if (written < 4 * 1024 * 1024) {
        src.write(chunk);
        written += chunk.length;
      }
    }, 1);
    const iter = parseMultipartRelated(src, {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
      boundary: 'B',
      maxPartBytes: 100 * 1024 * 1024,
    });
    try {
      const first = await iter.next();
      expect(first.done).toBe(false);
      await new Promise((r) => setTimeout(r, 300));
      const body = first.value!.body;
      // Without a cap the parser stops at ~highWaterMark; with a cap it should too.
      const buffered =
        body.readableLength +
        ((body as unknown as { writableLength?: number }).writableLength ?? 0);
      expect(buffered).toBeLessThan(1024 * 1024);
    } finally {
      clearInterval(pump);
      await iter.return();
      src.destroy();
    }
  });
});
