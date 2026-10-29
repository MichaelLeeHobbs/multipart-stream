/**
 * Round 2: when the over-cap part is the last one and its bytes all arrive
 * in the final chunk, the parser part stream is fully consumed by the
 * counting Transform, so the parser 'finish'es (queue 'end') BEFORE the
 * pipeline callback reports MultipartPartTooLargeError. The body rejects
 * with the cap error but the iterator completes successfully — the two
 * output paths disagree (docs: "the iterator surfaces the same instance").
 */
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  MultipartPartTooLargeError,
  parseMultipartRelated,
  streamToBuffer,
} from '../../src/index.js';

describe('round2: maxPartBytes overflow on the last part', () => {
  it('rejects the iterator with the same error instance as the body', async () => {
    const source = Readable.from([Buffer.from('--b\r\n\r\nhello\r\n--b--')]);
    let bodyErr: unknown;
    let iterErr: unknown;
    try {
      for await (const part of parseMultipartRelated(source, {
        idleTimeoutMs: 1_000,
        totalTimeoutMs: 3_000,
        boundary: 'b',
        maxPartBytes: 2,
      })) {
        await streamToBuffer(part.body).catch((err: unknown) => {
          bodyErr = err;
        });
      }
    } catch (err) {
      iterErr = err;
    }
    expect(bodyErr).toBeInstanceOf(MultipartPartTooLargeError);
    expect(iterErr).toBe(bodyErr);
  });
});
