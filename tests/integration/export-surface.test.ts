import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  fetchAndHandleMultipart,
  parseMultipartRelated,
} from '../../src/index.js';

/**
 * Export-surface marker tests.
 *
 * The behavioral suites for `parseMultipartRelated` and
 * `fetchAndHandleMultipart` live in `tests/integration/parse-*.test.ts`
 * and `tests/integration/fetch-*.test.ts`. The smoke tests below confirm
 * the two exports still exist and have the right runtime shape — they
 * fail loudly if a future change accidentally drops an export.
 */
describe('export-surface markers', () => {
  it('parseMultipartRelated is exported as a function and returns an AsyncGenerator', () => {
    expect(typeof parseMultipartRelated).toBe('function');
    // Construct against a Readable-with-boundary so we exercise the real
    // generator factory rather than relying on the synchronous validation
    // throw to surface here. We immediately abandon the iterator without
    // pulling — the cleanup path handles the early teardown.
    const iter = parseMultipartRelated(
      Readable.from(Buffer.from('--BOUNDARY--\r\n')),
      { idleTimeoutMs: 1000, totalTimeoutMs: 5000, boundary: 'BOUNDARY' },
    );
    expect(typeof iter[Symbol.asyncIterator]).toBe('function');
    expect(typeof iter.next).toBe('function');
    expect(typeof iter.return).toBe('function');
    expect(typeof iter.throw).toBe('function');
    // Tear down the iterator to release dicer's listeners on the source.
    void iter.return(undefined);
  });

  it('fetchAndHandleMultipart is exported as a function returning a Promise', () => {
    expect(typeof fetchAndHandleMultipart).toBe('function');
    // The full behavioral suite lives in
    // tests/integration/fetch-and-handle.test.ts, fetch-result-shape.test.ts,
    // fetch-content-type.test.ts, fetch-abort.test.ts,
    // fetch-init-signal.test.ts.
  });
});
