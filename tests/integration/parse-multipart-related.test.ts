import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToString } from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const BOUNDARY = 'X-BOUNDARY-7c4a';

const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

/**
 * Helper: build a 3-part envelope as a Web `Response` with a Web
 * `ReadableStream` body. Used by T-001 / T-004 / T-024.
 */
function buildThreePartResponse(): Response {
  const body = buildMultipartBody({
    boundary: BOUNDARY,
    parts: [
      {
        headers: {
          'Content-Type': 'application/json',
          'Content-ID': '<meta>',
        },
        body: '{"hello":"world"}',
      },
      {
        headers: {
          'Content-Type': 'text/plain',
          'Content-ID': '<plain>',
        },
        body: 'second part body',
      },
      {
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        body: 'third part body',
      },
    ],
  });
  return new Response(body, {
    headers: {
      'content-type': `multipart/related; boundary=${BOUNDARY}`,
    },
  });
}

describe('parseMultipartRelated — Response input (T-001 / T-004 / T-024)', () => {
  it('T-001: yields 3 parts in order with lowercased headers and streamed bodies', async () => {
    const res = buildThreePartResponse();
    const collected: Array<{
      index: number;
      contentType: string;
      contentId: string | undefined;
      body: string;
    }> = [];

    for await (const part of parseMultipartRelated(res, TIMEOUTS)) {
      collected.push({
        index: part.index,
        contentType: part.contentType,
        contentId: part.contentId,
        body: await streamToString(part.body),
      });
    }

    expect(collected).toHaveLength(3);
    expect(collected[0]).toMatchObject({
      index: 0,
      contentType: 'application/json',
      contentId: '<meta>',
      body: '{"hello":"world"}',
    });
    expect(collected[1]).toMatchObject({
      index: 1,
      contentType: 'text/plain',
      contentId: '<plain>',
      body: 'second part body',
    });
    expect(collected[2]).toMatchObject({
      index: 2,
      contentType: 'application/octet-stream',
      contentId: undefined,
      body: 'third part body',
    });
  });

  it('T-004 / FR-003: Web ReadableStream body converted via Readable.fromWeb (no `as never` regression)', async () => {
    // The `new Response(buffer)` factory exposes `body` as a Web
    // ReadableStream<Uint8Array>; the parser must convert it via
    // Readable.fromWeb internally. We assert success here; the static
    // grep gate (T-039) covers the `as never` ban.
    const res = buildThreePartResponse();
    expect(res.body).toBeDefined();
    let count = 0;
    for await (const part of parseMultipartRelated(res, TIMEOUTS)) {
      // drain the body so dicer can advance
      await streamToString(part.body);
      count += 1;
    }
    expect(count).toBe(3);
  });

  it('T-024 cross-section: the same envelope content yields the same parts via Response and via Readable + boundary', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        {
          headers: { 'Content-Type': 'text/plain' },
          body: 'one',
        },
        {
          headers: { 'Content-Type': 'text/plain' },
          body: 'two',
        },
      ],
    });

    const responseBodies: string[] = [];
    const responseInput = new Response(buf, {
      headers: {
        'content-type': `multipart/related; boundary=${BOUNDARY}`,
      },
    });
    for await (const part of parseMultipartRelated(responseInput, TIMEOUTS)) {
      responseBodies.push(await streamToString(part.body));
    }

    const readableBodies: string[] = [];
    for await (const part of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      readableBodies.push(await streamToString(part.body));
    }

    expect(responseBodies).toEqual(['one', 'two']);
    expect(readableBodies).toEqual(['one', 'two']);
  });
});

describe('parseMultipartRelated — Readable + boundary input (T-005)', () => {
  it('T-005: parses a Node Readable when caller supplies an explicit boundary', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        {
          headers: { 'Content-Type': 'text/plain' },
          body: 'alpha',
        },
        {
          headers: { 'Content-Type': 'text/plain' },
          body: 'beta',
        },
      ],
    });
    const bodies: string[] = [];
    for await (const part of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      bodies.push(await streamToString(part.body));
    }
    expect(bodies).toEqual(['alpha', 'beta']);
  });

  it('T-025: Readable input WITHOUT boundary throws on first .next()', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [{ headers: { 'Content-Type': 'text/plain' }, body: 'x' }],
    });
    // Cast to satisfy the overload signature — runtime check is what we
    // exercise here, not the type system.
    const opts = TIMEOUTS as unknown as Parameters<typeof parseMultipartRelated>[1];
    const iter = parseMultipartRelated(Readable.from(buf), opts);
    await expect(iter.next()).rejects.toThrow(/boundary option is required/);
  });
});

describe('parseMultipartRelated — synchronous early errors (T-022)', () => {
  it('T-022: a synchronous dicer error surfaces from the first .next() (proves listeners attached pre-pipe)', async () => {
    // Feed dicer an envelope that ends without ever matching the
    // configured boundary. dicer's `_realFinish` path emits an 'error'
    // event on next tick: "Unexpected end of multipart data". The point
    // of T-022 is that this error reaches the QUEUE — i.e. our 'error'
    // listener was attached BEFORE source.pipe(dicer). If the listener
    // had been attached after pipe(), the error would have been an
    // unhandled 'error' event on dicer and would have crashed the
    // process.
    const buf = Buffer.from('garbage with no boundary\r\n');
    const iter = parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    });
    await expect(iter.next()).rejects.toThrow(
      /Unexpected end of multipart data/,
    );
  });
});

describe('parseMultipartRelated — header normalization (T-056 / T-057)', () => {
  it('T-056: a part with no Content-ID header yields contentId: undefined', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        {
          headers: { 'Content-Type': 'text/plain' },
          body: 'no content-id here',
        },
      ],
    });
    let part: import('../../src/index.js').StreamingMultipartPart | undefined;
    for await (const p of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      part = p;
      await streamToString(p.body);
    }
    expect(part).toBeDefined();
    expect(part!.contentId).toBeUndefined();
    expect(part!.contentType).toBe('text/plain');
  });

  it('T-057: header names with unusual capitalization are lowercased in the yielded part', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        {
          headers: {
            'CONTENT-TYPE': 'application/dicom',
            'Content-Id': '<weird-case>',
            'X-Custom-Header': 'present',
          },
          body: 'capitalization test',
        },
      ],
    });
    let part: import('../../src/index.js').StreamingMultipartPart | undefined;
    for await (const p of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      part = p;
      await streamToString(p.body);
    }
    expect(part).toBeDefined();
    expect(part!.headers['content-type']).toBe('application/dicom');
    expect(part!.headers['content-id']).toBe('<weird-case>');
    expect(part!.headers['x-custom-header']).toBe('present');
    // Pre-extracted convenience getters mirror the lowercased header bag.
    expect(part!.contentType).toBe('application/dicom');
    expect(part!.contentId).toBe('<weird-case>');
  });
});

describe('parseMultipartRelated — missing content-type on a part', () => {
  it('part with no Content-Type header gets contentType: ""', async () => {
    // Part has only a Content-Disposition header — no Content-Type.
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        {
          headers: { 'Content-Disposition': 'inline' },
          body: 'no content-type',
        },
      ],
    });
    let part: import('../../src/index.js').StreamingMultipartPart | undefined;
    for await (const p of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      part = p;
      await streamToString(p.body);
    }
    expect(part?.contentType).toBe('');
    expect(part?.headers['content-disposition']).toBe('inline');
  });
});

describe('parseMultipartRelated — content-length parsing', () => {
  it('parses a numeric Content-Length header into part.contentLength', async () => {
    const body = 'twelvebytes!';
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        {
          headers: {
            'Content-Type': 'text/plain',
            'Content-Length': String(Buffer.byteLength(body)),
          },
          body,
        },
      ],
    });
    let part: import('../../src/index.js').StreamingMultipartPart | undefined;
    for await (const p of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      part = p;
      await streamToString(p.body);
    }
    expect(part?.contentLength).toBe(Buffer.byteLength(body));
  });

  it('non-numeric Content-Length leaves part.contentLength undefined', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        {
          headers: {
            'Content-Type': 'text/plain',
            'Content-Length': 'not-a-number',
          },
          body: 'whatever',
        },
      ],
    });
    let part: import('../../src/index.js').StreamingMultipartPart | undefined;
    for await (const p of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      part = p;
      await streamToString(p.body);
    }
    expect(part?.contentLength).toBeUndefined();
  });
});

describe('parseMultipartRelated — source error path', () => {
  it('rejects when the source Readable emits an error mid-stream', async () => {
    // Build a Readable that pushes one valid prefix chunk, then errors.
    // We track first-call vs subsequent-call state explicitly to avoid the
    // accidentally-infinite-push trap.
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [{ headers: { 'Content-Type': 'text/plain' }, body: 'partial' }],
    });
    let pushed = false;
    const source = new Readable({
      read() {
        if (pushed) return;
        pushed = true;
        // Push a small prefix to the dicer pipeline, then schedule an
        // error on the next tick so the error fires after pipe() has
        // processed the prefix chunk.
        this.push(buf.subarray(0, 20));
        process.nextTick(() => {
          this.destroy(new Error('source exploded'));
        });
      },
    });
    const iter = parseMultipartRelated(source, {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    });
    await expect(
      (async () => {
        // Drain whatever yields before the error.
        for await (const part of iter) {
          for await (const _chunk of part.body) void _chunk;
        }
      })(),
    ).rejects.toThrow(/source exploded/);
  });
});

describe('parseMultipartRelated — missing Content-Type on Response (T-053)', () => {
  it('T-053: Response with no Content-Type rejects on first .next() with the FR-004 error', async () => {
    // The WHATWG fetch impl auto-stamps a Content-Type on bodied responses,
    // so to exercise the genuinely-missing path we construct a Response-shaped
    // duck-type whose `.headers.get('content-type')` returns null. The
    // normalizeInput helper duck-types this shape (per FR-004) as a
    // defensive fallback for non-standard fixtures.
    const fake = {
      headers: {
        get: (name: string): string | null => {
          void name;
          return null;
        },
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x68, 0x69])); // 'hi'
          controller.close();
        },
      }),
    } as unknown as Response;
    const iter = parseMultipartRelated(fake, TIMEOUTS);
    await expect(iter.next()).rejects.toThrow(
      /Content-Type header is required/,
    );
  });
});
