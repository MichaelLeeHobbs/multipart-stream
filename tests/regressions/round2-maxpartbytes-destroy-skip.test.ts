/**
 * Round 2: skipping a part by destroying its body (the documented
 * "drain or destroy each part.body" pattern) fails the WHOLE operation with
 * a raw ERR_STREAM_PREMATURE_CLOSE when `maxPartBytes` is set and the
 * part's delimiter has not arrived yet. `pipeline(partStream, counter)`
 * destroys the parser part stream with the premature-close error, and the
 * per-part 'error' bridge forwards it to `fail` unfiltered.
 */
import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { fetchAndHandleMultipart, parseMultipartRelated, streamToBuffer } from '../../src/index.js';

const T = { idleTimeoutMs: 1_000, totalTimeoutMs: 3_000 };
const HEAD = '--b\r\n\r\nfirst-part-start';
const REST = '-end\r\n--b\r\n\r\nsecond\r\n--b--\r\n';

describe('round2: destroying a body with maxPartBytes set', () => {
  it('parseMultipartRelated continues to the next part', async () => {
    const source = new Readable({
      read() {
        /* pushed by the test */
      },
    });
    source.push(Buffer.from(HEAD));
    const bodies: string[] = [];
    const run = (async () => {
      for await (const part of parseMultipartRelated(source, {
        ...T,
        boundary: 'b',
        maxPartBytes: 1_000,
      })) {
        if (part.index === 0) {
          part.body.destroy();
          setImmediate(() => {
            source.push(Buffer.from(REST));
            source.push(null);
          });
        } else {
          bodies.push(await streamToBuffer(part.body).then(String));
        }
      }
    })();
    await expect(run).resolves.toBeUndefined();
    expect(bodies).toEqual(['second']);
  });

  it('fetchAndHandleMultipart: a parser that destroys the body to skip it', async () => {
    let step = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        if (step === 0) ctl.enqueue(new Uint8Array(Buffer.from(HEAD)));
        else if (step === 1) {
          await new Promise((r) => setTimeout(r, 10));
          ctl.enqueue(new Uint8Array(Buffer.from(REST)));
        } else ctl.close();
        step++;
      },
    });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(stream, { headers: { 'content-type': 'multipart/related; boundary=b' } }),
    );
    try {
      const result = await fetchAndHandleMultipart('http://x.invalid/', {
        ...T,
        maxPartBytes: 1_000,
        parser: async (part) => {
          if (part.index === 0) {
            part.body.destroy();
            return undefined;
          }
          return streamToBuffer(part.body).then(String);
        },
      });
      expect(result.parts).toEqual(['second']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
