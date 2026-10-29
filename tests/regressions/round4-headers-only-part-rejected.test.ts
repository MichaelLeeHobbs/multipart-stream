/**
 * Round 4: RFC 2046 §5.1.1 defines `body-part := MIME-part-headers [CRLF *OCTET]`
 * — the CRLF that introduces a body is optional, so a part may consist of
 * headers only (or of nothing at all), with the next delimiter's CRLF
 * immediately following the header block. MultipartParser throws
 * 'Malformed part header' whenever streamsearch matches the needle while it
 * is still in the 'headers' state, so these valid envelopes are rejected.
 */
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToString } from '../../src/index.js';

async function collect(envelope: string): Promise<{ ct: string; body: string }[]> {
  const out: { ct: string; body: string }[] = [];
  for await (const part of parseMultipartRelated(Readable.from([Buffer.from(envelope)]), {
    boundary: 'b',
    idleTimeoutMs: 1000,
    totalTimeoutMs: 2000,
  })) {
    out.push({ ct: part.contentType, body: await streamToString(part.body) });
  }
  return out;
}

describe('part without a body section', () => {
  it('accepts a headers-only part (no CRLF body introducer)', async () => {
    const env = '--b\r\nContent-Type: text/plain\r\n\r\n--b--\r\n';
    expect(await collect(env)).toEqual([{ ct: 'text/plain', body: '' }]);
  });

  it('accepts an entirely empty part (no headers, no body)', async () => {
    const env = '--b\r\n\r\n--b\r\nContent-Type: a/b\r\n\r\nx\r\n--b--';
    expect(await collect(env)).toEqual([
      { ct: '', body: '' },
      { ct: 'a/b', body: 'x' },
    ]);
  });
});

describe('needle right after a header block that is not a delimiter', () => {
  it('keeps the bytes as body, without the header block blank line', async () => {
    const env = '--b\r\nContent-Type: a/b\r\n\r\n--bjunk\r\n--b--';
    expect(await collect(env)).toEqual([{ ct: 'a/b', body: '--bjunk' }]);
    const empty = '--b\r\n\r\n--b-x\r\n--b--';
    expect(await collect(empty)).toEqual([{ ct: '', body: '--b-x' }]);
  });

  it('gives the same parts for every two-chunk split', async () => {
    const envs = [
      '--b\r\nContent-Type: text/plain\r\n\r\n--b--\r\n',
      '--b\r\n\r\n--b\r\nContent-Type: a/b\r\n\r\nx\r\n--b--',
      '--b\r\nContent-Type: a/b\r\n\r\n--bjunk\r\n--b--',
    ];
    for (const env of envs) {
      const whole = await collect(env);
      for (let i = 1; i < env.length; i++) {
        const out: { ct: string; body: string }[] = [];
        const src = Readable.from([Buffer.from(env.slice(0, i)), Buffer.from(env.slice(i))]);
        for await (const part of parseMultipartRelated(src, {
          boundary: 'b',
          idleTimeoutMs: 1000,
          totalTimeoutMs: 2000,
        })) {
          out.push({ ct: part.contentType, body: await streamToString(part.body) });
        }
        expect(out, `split at ${i}`).toEqual(whole);
      }
    }
  });

  it('rejects a header line cut off by the delimiter', async () => {
    await expect(collect('--b\r\nContent-Type: a/b\r\n--b--')).rejects.toThrow(
      'Malformed part header',
    );
  });

  it('counts the blank line toward maxHeaderBytesPerPart', async () => {
    const env = '--b\r\nX: 1\r\n\r\n--b--';
    const run = async (cap: number): Promise<number> => {
      let n = 0;
      for await (const part of parseMultipartRelated(Readable.from([Buffer.from(env)]), {
        boundary: 'b',
        idleTimeoutMs: 1000,
        totalTimeoutMs: 2000,
        maxHeaderBytesPerPart: cap,
      })) {
        part.body.resume();
        n++;
      }
      return n;
    };
    await expect(run(8)).resolves.toBe(1);
    await expect(run(7)).rejects.toThrow(/header/i);
  });
});
