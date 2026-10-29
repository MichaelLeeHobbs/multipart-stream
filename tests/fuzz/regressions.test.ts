/**
 * Minimal, shrunk regressions for genuine failures found by the property
 * suite in `tests/fuzz/*.fuzz.test.ts`. Every test here failed on 1.1.2 and
 * documents the contract it holds the library to; the bracketed id in each
 * title names the bug class.
 */

import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAndHandleMultipart,
  MultipartAbortError,
  MultipartIdleTimeoutError,
  MultipartTruncatedError,
  parseMultipartRelated,
  streamToBuffer,
  streamToString,
} from '../../src/index.js';

const T = { idleTimeoutMs: 50, totalTimeoutMs: 5_000 } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Race a promise against a deadline; resolves 'HANG' if it doesn't settle. */
async function settleWithin<V>(p: Promise<V>, ms: number): Promise<V | 'HANG'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<'HANG'>((r) => (timer = setTimeout(() => r('HANG'), ms))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Iterate, draining every body (the documented usage), returning the error. */
async function drainAll(
  input: Readable | Response,
  opts: Parameters<typeof parseMultipartRelated>[1],
): Promise<unknown> {
  try {
    for await (const part of parseMultipartRelated(input as Readable, opts)) {
      await streamToBuffer(part.body);
    }
    return undefined;
  } catch (err) {
    return err;
  }
}

/** A source that delivers `head` and then never sends more bytes or EOF. */
function stalled(head: string): Readable {
  const r = new Readable({
    read() {
      /* stalled: never pushes more */
    },
  });
  r.push(Buffer.from(head));
  return r;
}

async function captureUncaught<V>(
  fn: () => Promise<V>,
): Promise<{ value: V; uncaught: unknown[] }> {
  const uncaught: unknown[] = [];
  const on = (e: unknown): void => {
    uncaught.push(e);
  };
  process.on('uncaughtException', on);
  try {
    const value = await fn();
    await new Promise((r) => setTimeout(r, 10));
    return { value, uncaught };
  } finally {
    process.off('uncaughtException', on);
  }
}

describe('fuzz regressions', () => {
  // FR-022 / api.md §9: "Thrown when the source stream ends without ...
  // observing the closing multipart boundary". Every cut point yields a
  // plain Error('Unexpected end of multipart data') instead.
  it('[truncation-plain-error] a body cut mid-part rejects with MultipartTruncatedError', async () => {
    const bytes = '--b\r\n\r\nhi';
    const err = await drainAll(Readable.from([Buffer.from(bytes)]), { ...T, boundary: 'b' });
    expect(err).toBeInstanceOf(MultipartTruncatedError);
    expect((err as MultipartTruncatedError).bytesReceived).toBe(bytes.length);
  });

  it('[truncation-plain-error] an empty body rejects with MultipartTruncatedError', async () => {
    const err = await drainAll(Readable.from([Buffer.alloc(0)]), { ...T, boundary: 'b' });
    expect(err).toBeInstanceOf(MultipartTruncatedError);
  });

  // FR-007 / US-003: the idle timeout is the slow-loris defense. When the
  // source stalls while a part body is open, the timer fires but the error
  // only goes into the queue; the open body is never ended/errored, so a
  // consumer draining it (the documented usage) waits forever.
  it('[open-body-hang] idle timeout fires while the consumer is draining an open part body', async () => {
    const src = stalled('--b\r\n\r\nhel');
    const err = await settleWithin(drainAll(src, { ...T, boundary: 'b' }), 1_000);
    src.destroy();
    expect(err).toBeInstanceOf(MultipartIdleTimeoutError);
  });

  it('[open-body-hang] caller abort while the consumer is draining an open part body', async () => {
    const src = stalled('--b\r\n\r\nhel');
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort('stop'), 20);
    const err = await settleWithin(
      drainAll(src, { ...T, idleTimeoutMs: 60_000, boundary: 'b', signal: ctrl.signal }),
      1_000,
    );
    src.destroy();
    expect(err).toBeInstanceOf(MultipartAbortError);
  });

  it('[open-body-hang] source error (e.g. ECONNRESET) while the consumer is draining an open part body', async () => {
    const src = stalled('--b\r\n\r\nhel');
    const boom = new Error('ECONNRESET');
    setTimeout(() => src.destroy(boom), 20);
    const err = await settleWithin(
      drainAll(src, { ...T, idleTimeoutMs: 60_000, boundary: 'b' }),
      1_000,
    );
    expect(err).toBe(boom);
  });

  it('[open-body-hang] fetchAndHandleMultipart: idle timeout fires while the parser drains a stalled part', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('--b\r\n\r\nhel'));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(body, { headers: { 'content-type': 'multipart/related; boundary=b' } }),
    );
    const r = await settleWithin(
      fetchAndHandleMultipart('http://x.invalid/', {
        ...T,
        parser: async (p) => streamToString(p.body),
      }).catch((e: unknown) => e),
      1_000,
    );
    // The library releases the stalled body rather than leaving it open.
    expect(cancelled).toBe(true);
    expect(r).toBeInstanceOf(MultipartIdleTimeoutError);
  });

  // types.ts MultipartFetchResult.bytes: "Total bytes pulled from the source
  // stream (raw multipart envelope size)". It reports the byte count at the
  // last part's header event instead (0 for an empty envelope).
  it('[fetch-bytes] MultipartFetchResult.bytes equals the envelope size', async () => {
    const chunks = ['--b\r\nX: 1\r\n\r\nhe', 'llo\r\n--b--\r\n'];
    const env = chunks.join('');
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        const next = chunks.shift();
        if (next === undefined) c.close();
        else c.enqueue(new TextEncoder().encode(next));
      },
    });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(body, { headers: { 'content-type': 'multipart/related; boundary=b' } }),
    );
    const r = await fetchAndHandleMultipart('http://x.invalid/', {
      ...T,
      parser: async (p) => streamToString(p.body),
    });
    expect(r.parts).toEqual(['hello']);
    expect(r.bytes).toBe(env.length);
  });

  // types.ts StreamingMultipartPart.headers: "Lowercased part headers ...
  // repeated values are joined with `, `." A `__proto__` header is silently
  // dropped because the bag is a plain object.
  it('[proto-header] a `__proto__` part header is preserved', async () => {
    const env = '--b\r\n__proto__: x\r\n\r\nhi\r\n--b--\r\n';
    let own: PropertyDescriptor | undefined;
    for await (const part of parseMultipartRelated(Readable.from([Buffer.from(env)]), {
      ...T,
      boundary: 'b',
    })) {
      own = Object.getOwnPropertyDescriptor(part.headers, '__proto__');
      part.body.destroy();
    }
    expect(own?.value).toBe('x');
  });

  // Same contract: repeated values are joined with ", " — empty values are dropped instead.
  it('[empty-repeat-header] repeated headers with an empty value are joined with ", "', async () => {
    const env = '--b\r\nX: a\r\nX:\r\n\r\nhi\r\n--b--\r\n';
    let x: string | undefined;
    for await (const part of parseMultipartRelated(Readable.from([Buffer.from(env)]), {
      ...T,
      boundary: 'b',
    })) {
      x = part.headers.x;
      part.body.destroy();
    }
    expect(x).toBe('a, ');
  });

  // US-007 ("no leaked sockets"): fetchAndHandleMultipart owns the Response
  // and rejects without cancelling its body on the FR-021 path and on the
  // missing-boundary path.
  it.each([
    ['non-multipart Content-Type', 'text/plain'],
    ['missing boundary', 'multipart/related'],
  ])(
    '[fetch-body-not-cancelled] %s: the response body is cancelled on rejection',
    async (_label, ct) => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull() {
          /* never delivers bytes */
        },
        cancel() {
          cancelled = true;
        },
      });
      vi.stubGlobal('fetch', async () => new Response(body, { headers: { 'content-type': ct } }));
      await expect(
        fetchAndHandleMultipart('http://x.invalid/', { ...T, parser: async () => 1 }),
      ).rejects.toThrow(/^multipart: /);
      expect(cancelled).toBe(true);
    },
  );

  // api.md §1/§2: missing/invalid options yield a documented
  // `TypeError('multipart: …')`; a nullish bag leaks a raw property-access TypeError.
  it('[nullish-opts-raw-typeerror] parseMultipartRelated(src, undefined) rejects with the documented multipart TypeError', async () => {
    const err = await drainAll(Readable.from([Buffer.alloc(0)]), undefined as never);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toMatch(/^multipart: idleTimeoutMs/);
  });

  it('[nullish-opts-raw-typeerror] fetchAndHandleMultipart(url, undefined) rejects with the documented multipart TypeError', async () => {
    await expect(fetchAndHandleMultipart('http://x.invalid/', undefined as never)).rejects.toThrow(
      /^multipart: options\.parser is required$/,
    );
  });

  // api.md §3/§4: the helpers reject on failure; an exception thrown from
  // inside their 'end'/'data' listeners escapes as uncaughtException and the
  // promise never settles.
  it('[stream-helper-uncaught] streamToBuffer on an object-mode stream rejects instead of crashing', async () => {
    const { value, uncaught } = await captureUncaught(() =>
      settleWithin(
        streamToBuffer(Readable.from([{}])).then(
          () => 'resolved',
          () => 'rejected',
        ),
        500,
      ),
    );
    expect(uncaught).toEqual([]);
    expect(value).not.toBe('HANG');
  });

  it('[stream-helper-uncaught] streamToString with an unknown encoding rejects instead of crashing', async () => {
    const { value, uncaught } = await captureUncaught(() =>
      settleWithin(
        streamToString(Readable.from([Buffer.from('a')]), 'bogus' as BufferEncoding).then(
          () => 'resolved',
          () => 'rejected',
        ),
        500,
      ),
    );
    expect(uncaught).toEqual([]);
    expect(value).not.toBe('HANG');
  });

  // types.ts: maxPartBytes "Must be a positive finite integer when set" —
  // it is never validated; a non-number cap throws inside a part-stream
  // 'data' listener (uncaught), and NaN silently disables the cap.
  it('[unvalidated-caps] a non-numeric maxPartBytes is rejected, not thrown from a stream listener', async () => {
    const env = '--b\r\n\r\nhi\r\n--b--\r\n';
    const { value, uncaught } = await captureUncaught(() =>
      settleWithin(
        drainAll(Readable.from([Buffer.from(env)]), {
          ...T,
          boundary: 'b',
          maxPartBytes: Symbol('cap') as unknown as number,
        }),
        500,
      ),
    );
    expect(uncaught).toEqual([]);
    expect(value).toBeInstanceOf(TypeError);
  });

  // NFR-DR-S-004: the caller-configured header caps are the limit. An
  // undocumented internal 80 KiB / 2000-header ceiling overrides a raised cap
  // with a plain Error.
  it('[internal-header-ceiling] a 90 KB header block parses under maxHeaderBytesPerPart: 200_000', async () => {
    const env = `--b\r\nX-Big: ${'v'.repeat(90_000)}\r\n\r\nhi\r\n--b--\r\n`;
    const err = await drainAll(Readable.from([Buffer.from(env)]), {
      ...T,
      boundary: 'b',
      maxHeaderBytesPerPart: 200_000,
    });
    expect(err).toBeUndefined();
  });

  it('[internal-header-ceiling] 2001 headers parse under maxHeadersPerPart: 5000', async () => {
    const hs = Array.from({ length: 2_001 }, (_, i) => `H${String(i)}: v\r\n`).join('');
    const env = `--b\r\n${hs}\r\nhi\r\n--b--\r\n`;
    const err = await drainAll(Readable.from([Buffer.from(env)]), {
      ...T,
      boundary: 'b',
      maxHeadersPerPart: 5_000,
      maxHeaderBytesPerPart: 100_000,
    });
    expect(err).toBeUndefined();
  });

  // RFC 2046 §5.1.1: `dash-boundary transport-padding CRLF` — linear
  // whitespace after a delimiter is legal; the parser loses the part.
  it('[transport-padding] whitespace after a delimiter line is accepted', async () => {
    const env = '--b \r\n\r\nhi\r\n--b--\r\n';
    const bodies: string[] = [];
    const err = await (async () => {
      try {
        for await (const part of parseMultipartRelated(Readable.from([Buffer.from(env)]), {
          ...T,
          boundary: 'b',
        })) {
          bodies.push(await streamToString(part.body));
        }
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeUndefined();
    expect(bodies).toEqual(['hi']);
  });
});
