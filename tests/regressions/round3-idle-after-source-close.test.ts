import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToString } from '../../src/index.js';

// The idle timer stops when the source emits 'end' (no more bytes can come,
// so a slow reader is not a stalled source). A source torn down with
// destroy() after the closing delimiter arrived is the supported
// "epilogue lost" path (onSourceClose ends the parser), but it never stops
// the idle timer: a consumer that takes longer than idleTimeoutMs to read
// the already-complete last part gets MultipartIdleTimeoutError.
describe('round3: idle timer after a source closes without end', () => {
  it('completes when the last part is read slowly after the source was destroyed', async () => {
    const src = new PassThrough();
    const iter = parseMultipartRelated(src, {
      boundary: 'b',
      idleTimeoutMs: 60,
      totalTimeoutMs: 5000,
    });
    src.write('--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b--\r\n');
    const bodies: string[] = [];
    for await (const part of iter) {
      // Every byte, closing delimiter included, has been parsed; the
      // connection is then torn down (epilogue lost).
      src.destroy();
      await delay(150);
      bodies.push(await streamToString(part.body));
    }
    expect(bodies).toEqual(['hello']);
  });

  it('control: the same slow read after a normal end completes', async () => {
    const src = new PassThrough();
    const iter = parseMultipartRelated(src, {
      boundary: 'b',
      idleTimeoutMs: 60,
      totalTimeoutMs: 5000,
    });
    src.end('--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b--\r\n');
    const bodies: string[] = [];
    for await (const part of iter) {
      await delay(150);
      bodies.push(await streamToString(part.body));
    }
    expect(bodies).toEqual(['hello']);
  });
});
