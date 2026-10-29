import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToString } from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const boundary = 'B';

describe('review: slow consumer of the last part', () => {
  it('does not report truncation when the consumer reads the last body after a short delay', async () => {
    const envelope = buildMultipartBody({
      boundary,
      parts: [{ headers: { 'Content-Type': 'text/plain' }, body: 'hello' }],
    });
    const bodies: string[] = [];
    for await (const part of parseMultipartRelated(Readable.from([envelope]), {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
      boundary,
    })) {
      // Any async work before reading the body (a DB lookup, etc.).
      await new Promise((r) => setTimeout(r, 20));
      bodies.push(await streamToString(part.body));
    }
    expect(bodies).toEqual(['hello']);
  });
});
