import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToString } from '../../src/index.js';

describe('review: RFC 2046 transport-padding after a boundary delimiter', () => {
  it('accepts linear whitespace between the boundary and its CRLF', async () => {
    const envelope = Buffer.from(
      '--B  \r\nContent-Type: text/plain\r\n\r\none\r\n--B\t\r\n\r\ntwo\r\n--B--  \r\n',
    );
    const out: string[] = [];
    for await (const part of parseMultipartRelated(Readable.from([envelope]), {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
      boundary: 'B',
    })) {
      out.push(await streamToString(part.body));
    }
    expect(out).toEqual(['one', 'two']);
  });
});
