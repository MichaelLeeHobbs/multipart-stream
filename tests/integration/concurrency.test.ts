/**
 * Concurrency contract test (T-083, F-A-005).
 *
 * Per the documented assumption ("library MAY but is not required to
 * detect concurrent iter.next() calls"), the contract on the public
 * `parseMultipartRelated` async-generator is:
 *   - The library does NOT promise serialization of concurrent .next() calls.
 *   - The library MUST NOT crash the process via uncaughtException when
 *     callers fire concurrent .next() calls. First-fire-wins on whichever
 *     promise resolves first; the other resolves with whatever the queue
 *     state allows (success, EOF, or rejection — all acceptable).
 *
 * This test pins that contract by firing two concurrent .next() calls on a
 * single iterator and asserting the process did not raise an uncaught
 * exception. We don't assert which one wins.
 */

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated } from '../../src/index.js';

describe('concurrency contract — concurrent iter.next() (T-083, F-A-005)', () => {
  it('does not crash the process on concurrent iter.next()', async () => {
    const CRLF = '\r\n';
    const body = Buffer.from(
      `--B${CRLF}` +
        `Content-Type: text/plain${CRLF}` +
        `${CRLF}` +
        `hello${CRLF}` +
        `--B${CRLF}` +
        `Content-Type: text/plain${CRLF}` +
        `${CRLF}` +
        `world${CRLF}` +
        `--B--${CRLF}`,
      'utf8',
    );
    const res = new Response(body, {
      headers: { 'content-type': 'multipart/related; boundary=B' },
    });

    // Capture any process-level uncaught exception. If the library crashes
    // the process we want a clear test failure rather than a hung suite.
    const uncaughtErrors: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaughtErrors.push(err);
    };
    process.on('uncaughtException', onUncaught);
    // Also capture unhandled-rejection — the documented contract is "no
    // process crash", and an unhandled rejection on a concurrent .next()
    // race would qualify under Node's --unhandled-rejections=throw default.
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const iter = parseMultipartRelated(res, {
        idleTimeoutMs: 5000,
        totalTimeoutMs: 10_000,
      });
      // Fire two concurrent .next() calls — the documented race per F-A-005.
      const settled = await Promise.allSettled([iter.next(), iter.next()]);
      // We don't assert which one wins or even on what each returns. The
      // contract is that the process did not crash (no uncaughtException
      // and no unhandledRejection).
      for (const r of settled) {
        expect(['fulfilled', 'rejected']).toContain(r.status);
      }
      // Tear down the iterator deterministically. .return() releases the
      // generator without crashing; any subsequent settle is swallowed.
      try {
        await iter.return();
      } catch {
        // Per F-A-005: a return-time rejection is acceptable — what we
        // forbid is a process-wide uncaughtException / unhandledRejection.
        // Re-checking the captured arrays below covers that contract.
      }
      // Yield once so any setImmediate-delayed cleanup (e.g. the truncation
      // push at parse-multipart-related.ts:~626) has a chance to fire and
      // either be observed via our handlers or be swallowed cleanly.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });
    } finally {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    }

    expect(uncaughtErrors).toEqual([]);
    expect(unhandledRejections).toEqual([]);
  });
});
