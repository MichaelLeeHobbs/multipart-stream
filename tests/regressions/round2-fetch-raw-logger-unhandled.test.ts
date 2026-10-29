/**
 * Round 2: parseMultipartRelated wraps the caller's logger so a throwing
 * logger never escapes a stream/promise callback (FR-018 / JC-2), but
 * fetchAndHandleMultipart calls the RAW `options.logger` inside the
 * `res.body.cancel().catch(...)` handler on the non-multipart Content-Type
 * path. If cancel() rejects and the logger throws, the rejection escapes as
 * an unhandled rejection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchAndHandleMultipart } from '../../src/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('round2: fetchAndHandleMultipart logger hygiene', () => {
  it('a throwing logger on the body-cancel path does not cause an unhandled rejection', async () => {
    const escaped: unknown[] = [];
    const onErr = (e: unknown): void => {
      escaped.push(e);
    };
    process.on('unhandledRejection', onErr);
    try {
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          throw new Error('cancel failed');
        },
      });
      vi.stubGlobal(
        'fetch',
        async () => new Response(body, { headers: { 'content-type': 'text/plain' } }),
      );
      await expect(
        fetchAndHandleMultipart('http://x.invalid/', {
          idleTimeoutMs: 1_000,
          totalTimeoutMs: 1_000,
          parser: async () => undefined,
          logger: () => {
            throw new Error('logger threw');
          },
        }),
      ).rejects.toThrow(/not multipart\/related/);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onErr);
    }
    expect(escaped).toEqual([]);
  });
});
