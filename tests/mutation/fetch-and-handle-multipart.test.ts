import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAndHandleMultipart,
  MultipartHeadersTooLargeError,
  MultipartTotalTimeoutError,
} from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const timeouts = { idleTimeoutMs: 5_000, totalTimeoutMs: 10_000 } as const;
const drain = async (): Promise<undefined> => undefined;

function multipartResponse(parts: { headers: Record<string, string>; body: string }[]): Response {
  return new Response(buildMultipartBody({ boundary: 'B', parts }), {
    headers: { 'content-type': 'multipart/related; boundary=B' },
  });
}

/** A fetch that only settles by rejecting when its signal aborts. */
function hangingFetch(): (url: string, init: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('fetch aborted')), {
        once: true,
      });
    });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAndHandleMultipart: option validation', () => {
  it.each(['maxPartBytes', 'maxParts', 'maxHeadersPerPart', 'maxHeaderBytesPerPart'])(
    'rejects an invalid %s by name before calling fetch',
    async (name) => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      await expect(
        fetchAndHandleMultipart('http://x.test/', { ...timeouts, parser: drain, [name]: 0 }),
      ).rejects.toThrow(new RegExp(`^multipart: ${name} must be a positive safe integer`));
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe('fetchAndHandleMultipart: cap forwarding', () => {
  const twoHeaders = [{ headers: { 'X-A': 'aaaa', 'X-B': 'bbbb' }, body: 'x' }];

  it('forwards maxHeadersPerPart to the parser', async () => {
    vi.stubGlobal('fetch', async () => multipartResponse(twoHeaders));
    const run = fetchAndHandleMultipart('http://x.test/', {
      ...timeouts,
      parser: drain,
      maxHeadersPerPart: 1,
    });
    await expect(run).rejects.toBeInstanceOf(MultipartHeadersTooLargeError);
    await expect(run).rejects.toMatchObject({ limit: 'count', cap: 1 });
  });

  it('forwards maxHeaderBytesPerPart to the parser', async () => {
    vi.stubGlobal('fetch', async () => multipartResponse(twoHeaders));
    const run = fetchAndHandleMultipart('http://x.test/', {
      ...timeouts,
      parser: drain,
      maxHeaderBytesPerPart: 8,
    });
    await expect(run).rejects.toBeInstanceOf(MultipartHeadersTooLargeError);
    await expect(run).rejects.toMatchObject({ limit: 'bytes', cap: 8 });
  });
});

describe('fetchAndHandleMultipart: fetch phase', () => {
  it('aborts a slow fetch on the total budget when a caller signal is also set', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const run = fetchAndHandleMultipart('http://x.test/', {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 30,
      parser: drain,
      signal: new AbortController().signal,
    });
    await expect(run).rejects.toBeInstanceOf(MultipartTotalTimeoutError);
    await expect(run).rejects.toMatchObject({ cause: new Error('fetch aborted') });
  });

  it('passes a non-abort fetch failure through unchanged', async () => {
    const failure = new TypeError('network down');
    vi.stubGlobal('fetch', async () => {
      throw failure;
    });
    await expect(
      fetchAndHandleMultipart('http://x.test/', { ...timeouts, parser: drain }),
    ).rejects.toBe(failure);
  });

  it('stops the total budget timer once response headers arrive', async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      fetchSignal = init.signal ?? undefined;
      return multipartResponse([{ headers: {}, body: 'x' }]);
    });
    await fetchAndHandleMultipart('http://x.test/', {
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 40,
      parser: drain,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetchSignal?.aborted).toBe(false);
  });
});

describe('fetchAndHandleMultipart: response handling', () => {
  it('reports an absent Content-Type as an empty value', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }));
    await expect(
      fetchAndHandleMultipart('http://x.test/', { ...timeouts, parser: drain }),
    ).rejects.toThrow('multipart: response Content-Type is not multipart/related; got ""');
  });

  it('logs a failed body cancel on a non-multipart response', async () => {
    const logger = vi.fn();
    vi.stubGlobal('fetch', async () => ({
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: { cancel: () => Promise.reject(new Error('nope')) },
    }));
    await expect(
      fetchAndHandleMultipart('http://x.test/', { ...timeouts, parser: drain, logger }),
    ).rejects.toThrow(/not multipart\/related/);
    await vi.waitFor(() => {
      expect(logger).toHaveBeenCalledWith({
        level: 'warn',
        msg: 'multipart: cancelling the response body failed',
        meta: { errSummary: { name: 'Error', message: '"nope"' } },
      });
    });
  });

  it('continues past a part body the parser destroyed', async () => {
    vi.stubGlobal('fetch', async () =>
      multipartResponse([
        { headers: {}, body: 'one' },
        { headers: {}, body: 'two' },
      ]),
    );
    const result = await fetchAndHandleMultipart('http://x.test/', {
      ...timeouts,
      parser: async (part) => {
        part.body.destroy();
        return part.index;
      },
    });
    expect(result.parts).toEqual([0, 1]);
  });

  it('reports elapsedMs measured from the call', async () => {
    vi.stubGlobal('fetch', async () => multipartResponse([{ headers: {}, body: 'x' }]));
    const before = Date.now();
    const result = await fetchAndHandleMultipart('http://x.test/', { ...timeouts, parser: drain });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeLessThanOrEqual(Date.now() - before);
  });
});
