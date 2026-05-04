/**
 * Integration tests for `fetchAndHandleMultipart` AbortSignal propagation
 * (FR-009 / FR-DR-A-026).
 *
 * Covers:
 *   - T-013: already-aborted signal at call time → sync MultipartAbortError;
 *     `fetch` was NEVER called (spy on global fetch); reason verbatim.
 *   - Mid-fetch abort: abort fires while `fetch` is in-flight → reject
 *     with MultipartAbortError, reason verbatim.
 *   - Mid-iteration abort: abort fires while iterating parts → reject
 *     with MultipartAbortError; the abort propagates from Layer A's
 *     timer plumbing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAndHandleMultipart,
  MultipartAbortError,
  streamToString,
} from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';
import { startMultipartServer } from '../fixtures/start-multipart-server.js';

const BOUNDARY = 'ABORT-FETCH-BOUNDARY';
const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

describe('fetchAndHandleMultipart — T-013: already-aborted signal at call time', () => {
  it('rejects synchronously with MultipartAbortError; fetch is NEVER called; reason verbatim', async () => {
    // Spy on globalThis.fetch — the test contract is that the FR-009
    // already-aborted check short-circuits BEFORE fetch is invoked.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const ctrl = new AbortController();
      ctrl.abort('user');

      const op = fetchAndHandleMultipart('http://127.0.0.1:1/', {
        ...TIMEOUTS,
        signal: ctrl.signal,
        parser: async () => undefined,
      });

      await expect(op).rejects.toBeInstanceOf(MultipartAbortError);
      // Re-trigger the call to capture the error for the reason check.
      let captured: unknown;
      try {
        const ctrl2 = new AbortController();
        ctrl2.abort('user');
        await fetchAndHandleMultipart('http://127.0.0.1:1/', {
          ...TIMEOUTS,
          signal: ctrl2.signal,
          parser: async () => undefined,
        });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(MultipartAbortError);
      expect((captured as MultipartAbortError).reason).toBe('user');

      // The spy MUST not have been called by either invocation.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('Error reason is forwarded by reference (F-S-006 contract)', async () => {
    const ctrl = new AbortController();
    const reasonErr = new Error('cancel cause');
    ctrl.abort(reasonErr);
    let captured: unknown;
    try {
      await fetchAndHandleMultipart('http://127.0.0.1:1/', {
        ...TIMEOUTS,
        signal: ctrl.signal,
        parser: async () => undefined,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(MultipartAbortError);
    expect((captured as MultipartAbortError).reason).toBe(reasonErr);
  });
});

describe('fetchAndHandleMultipart — mid-fetch abort', () => {
  it('aborts during the fetch call → MultipartAbortError, reason verbatim', async () => {
    // Server stalls 500ms before responding so we can fire the abort
    // while `fetch` is in-flight.
    const server = await startMultipartServer({
      stallMs: 500,
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body: buildMultipartBody({
        boundary: BOUNDARY,
        parts: [{ headers: { 'Content-Type': 'text/plain' }, body: 'x' }],
      }),
    });
    try {
      const ctrl = new AbortController();
      // Trigger abort 50ms in (well before the server's 500ms stall ends).
      setTimeout(() => ctrl.abort('mid-fetch'), 50);

      let captured: unknown;
      try {
        await fetchAndHandleMultipart(server.url, {
          ...TIMEOUTS,
          signal: ctrl.signal,
          parser: async () => undefined,
        });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(MultipartAbortError);
      expect((captured as MultipartAbortError).reason).toBe('mid-fetch');
    } finally {
      await server.close();
    }
  });
});

describe('fetchAndHandleMultipart — mid-iteration abort', () => {
  it('aborts during for-await loop → MultipartAbortError surfaces from Layer A', async () => {
    // Build a multi-part envelope; abort after the first part has been
    // parsed. Layer A's timer + signal plumbing will surface a
    // MultipartAbortError on the next iteration.
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        { headers: { 'Content-Type': 'text/plain' }, body: 'one' },
        { headers: { 'Content-Type': 'text/plain' }, body: 'two' },
        { headers: { 'Content-Type': 'text/plain' }, body: 'three' },
      ],
    });
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const ctrl = new AbortController();
      let captured: unknown;
      try {
        await fetchAndHandleMultipart<string>(server.url, {
          ...TIMEOUTS,
          signal: ctrl.signal,
          parser: async (part) => {
            const text = await streamToString(part.body);
            // After the first part's body is drained, fire abort.
            if (text === 'one') {
              ctrl.abort('mid-iteration');
            }
            return text;
          },
        });
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(MultipartAbortError);
      // Layer A surfaces the abort error with the verbatim caller reason.
      expect((captured as MultipartAbortError).reason).toBe('mid-iteration');
    } finally {
      await server.close();
    }
  });
});

describe('fetchAndHandleMultipart — pre-aborted DOMException-style reason', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('undefined-arg abort() forwards engine-produced DOMException as reason', async () => {
    const ctrl = new AbortController();
    ctrl.abort(); // no arg → engine sets ctrl.signal.reason to a DOMException
    const expectedReason: unknown = ctrl.signal.reason;

    let captured: unknown;
    try {
      await fetchAndHandleMultipart('http://127.0.0.1:1/', {
        ...TIMEOUTS,
        signal: ctrl.signal,
        parser: async () => undefined,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(MultipartAbortError);
    expect((captured as MultipartAbortError).reason).toBe(expectedReason);
  });
});
