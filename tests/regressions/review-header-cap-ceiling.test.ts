import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToString } from '../../src/index.js';

describe('review: caller-raised header caps are honored', () => {
  it('accepts a 100 KiB header block when maxHeaderBytesPerPart allows 1 MiB', async () => {
    const big = 'a'.repeat(100 * 1024);
    const envelope = Buffer.from(`--B\r\nX-Big: ${big}\r\n\r\nbody\r\n--B--\r\n`);
    const out: string[] = [];
    for await (const part of parseMultipartRelated(Readable.from([envelope]), {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
      boundary: 'B',
      maxHeaderBytesPerPart: 1024 * 1024,
    })) {
      out.push(await streamToString(part.body));
    }
    expect(out).toEqual(['body']);
  });

  it('accepts 3000 header lines when maxHeadersPerPart allows 5000', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `X-${i}: v`).join('\r\n');
    const envelope = Buffer.from(`--B\r\n${lines}\r\n\r\nbody\r\n--B--\r\n`);
    const out: string[] = [];
    for await (const part of parseMultipartRelated(Readable.from([envelope]), {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
      boundary: 'B',
      maxHeadersPerPart: 5000,
      maxHeaderBytesPerPart: 1024 * 1024,
    })) {
      out.push(await streamToString(part.body));
    }
    expect(out).toEqual(['body']);
  });
});
