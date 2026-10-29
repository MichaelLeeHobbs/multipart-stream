import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { MultipartTruncatedError, parseMultipartRelated } from '../../src/index.js';

// normalizeInput deliberately duck-types the Readable (re-bundled stream
// modules). Stream implementations without the Node 18+ `errored` property
// (e.g. readable-stream@3, still a common transitive dependency) report
// `errored === undefined`, not `null`, for a stream destroyed without an
// error. The pre-destroyed check treats anything but `null` as an error and
// calls fail(undefined), so the iterator rejects with `undefined`.
describe('round3: pre-destroyed source without an `errored` property', () => {
  it('rejects with an Error, not undefined', async () => {
    const src = new Readable({ read: () => undefined });
    Object.defineProperty(src, 'errored', { get: () => undefined });
    src.destroy();
    const iter = parseMultipartRelated(src, {
      boundary: 'b',
      idleTimeoutMs: 1000,
      totalTimeoutMs: 2000,
    });
    let caught: unknown = 'not-rejected';
    try {
      await iter.next();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MultipartTruncatedError);
  });
});
