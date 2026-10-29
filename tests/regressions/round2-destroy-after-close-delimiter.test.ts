/**
 * Round 2: FR-022 / api.md define MultipartTruncatedError as "the source
 * ended WITHOUT the parser observing the closing boundary". When the close
 * delimiter has already been parsed and every part delivered, a source
 * that is then destroyed without an error (e.g. the transport is torn down
 * during the epilogue) still rejects with MultipartTruncatedError
 * ("stream ended before closing boundary"), because `onSourceClose`
 * checks only `sourceEnded`, not whether the parser reached its done state.
 */
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToBuffer } from '../../src/index.js';

describe('round2: source destroyed after the close delimiter', () => {
  it('completes successfully: the closing boundary was observed', async () => {
    const source = new Readable({
      read() {
        /* pushed by the test */
      },
    });
    source.push(Buffer.from('--b\r\n\r\nhi\r\n--b--\r\n'));
    const bodies: string[] = [];
    const run = (async () => {
      for await (const part of parseMultipartRelated(source, {
        idleTimeoutMs: 1_000,
        totalTimeoutMs: 3_000,
        boundary: 'b',
      })) {
        bodies.push(await streamToBuffer(part.body).then(String));
        setImmediate(() => source.destroy());
      }
    })();
    await expect(run).resolves.toBeUndefined();
    expect(bodies).toEqual(['hi']);
  });
});
