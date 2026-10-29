import { getDefaultHighWaterMark, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated } from '../../src/index.js';

// Part 0's body fills its stream's buffer (over the default
// highWaterMark, so backpressure holds the parser's second write), and that
// chunk also starts part 1's header block. The rest of
// part 1's header block is buffered in the parser. Breaking out at part 0
// destroys it, which releases the held write AFTER cleanup: the parser then
// completes part 1's headers and the 'header' listener runs on a closed
// generator.
describe('round3: no part activity after the generator closes', () => {
  it('does not call onProgress after an early break', async () => {
    // Each write stays under the parser's writable highWaterMark; together
    // they overfill part 0's readable buffer.
    const hwm = getDefaultHighWaterMark(false);
    const src = new PassThrough();
    const ticks: number[] = [];
    const iter = parseMultipartRelated(src, {
      boundary: 'b',
      idleTimeoutMs: 2000,
      totalTimeoutMs: 5000,
      onProgress: (s) => ticks.push(s.bytes),
    });
    src.write(
      Buffer.concat([
        Buffer.from('--b\r\nContent-Type: a\r\n\r\n'),
        Buffer.alloc(Math.floor(hwm * 0.6), 0x61),
      ]),
    );
    src.write(
      Buffer.concat([
        Buffer.alloc(Math.floor(hwm * 0.5), 0x61),
        Buffer.from('\r\n--b\r\nContent-Type: te'),
      ]),
    );
    src.write(Buffer.from('xt/plain\r\n\r\nhello\r\n--b--\r\n'));
    let seen = 0;
    for await (const part of iter) {
      seen++;
      void part;
      // Let the second chunk reach the parser's write buffer.
      await delay(20);
      break;
    }
    expect(seen).toBe(1);
    const atClose = ticks.length;
    await delay(50);
    expect(ticks.length).toBe(atClose);
  });
});
