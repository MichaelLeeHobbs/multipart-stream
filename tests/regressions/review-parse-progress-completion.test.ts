import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, type ProgressSnapshot, streamToString } from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

describe('review: ParseMultipartOptions.onProgress completion tick', () => {
  it('fires once per part AND once at completion, as the JSDoc promises', async () => {
    const envelope = buildMultipartBody({
      boundary: 'B',
      parts: [{ headers: {}, body: 'x' }],
    });
    const snaps: ProgressSnapshot[] = [];
    for await (const part of parseMultipartRelated(Readable.from([envelope]), {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
      boundary: 'B',
      onProgress: (s) => snaps.push(s),
    })) {
      await streamToString(part.body);
    }
    expect(snaps.length).toBeGreaterThanOrEqual(2);
    expect(snaps.at(-1)?.bytes).toBe(envelope.length);
  });
});
