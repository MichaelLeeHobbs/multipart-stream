import { describe, expect, it } from 'vitest';

import { parseMultipartRelated } from '../../src/index.js';

const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

describe('parseMultipartRelated — synchronous validation (T-002 / T-003)', () => {
  it('T-002: null body rejects on first .next() with the FR-004 error', async () => {
    // Construct a Response-shaped object whose .body is null. The simplest
    // way to get null .body is `new Response(null)`. The headers carry a
    // valid multipart/related; boundary value so we exercise the body-null
    // check (and not the missing-Content-Type check).
    const res = new Response(null, {
      headers: { 'content-type': 'multipart/related; boundary=X' },
    });
    const iter = parseMultipartRelated(res, TIMEOUTS);
    await expect(iter.next()).rejects.toThrow(/response body is null/);
  });

  it('T-003: Content-Type without boundary parameter rejects on first .next()', async () => {
    const res = new Response('', {
      headers: { 'content-type': 'multipart/related' },
    });
    const iter = parseMultipartRelated(res, TIMEOUTS);
    await expect(iter.next()).rejects.toThrow(
      /boundary parameter missing from Content-Type/,
    );
  });

  it('FR-004 cross: empty boundary parameter ("boundary=") rejects', async () => {
    const res = new Response('', {
      headers: { 'content-type': 'multipart/related; boundary=' },
    });
    const iter = parseMultipartRelated(res, TIMEOUTS);
    await expect(iter.next()).rejects.toThrow(
      /boundary parameter is empty in Content-Type/,
    );
  });
});
