import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToBuffer } from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const boundary = 'B-TEST';
const timeouts = { idleTimeoutMs: 5_000, totalTimeoutMs: 30_000 } as const;

describe('internal multipart framing', () => {
  it.each([1, 2, 3, 7, 31])(
    'preserves binary data and false boundaries with %i-byte source chunks',
    async (size) => {
      const first = Buffer.concat([
        Buffer.from('before\r\n--B-TESTXmiddle\r\n--B-TEST-after\r\n--B-TEST--junk'),
        Buffer.from([0, 255, 13, 10]),
      ]);
      const envelope = buildMultipartBody({
        boundary,
        parts: [
          { headers: { 'Content-Type': 'application/dicom' }, body: first },
          { headers: {}, body: Buffer.alloc(0) },
        ],
        preamble: 'ignored preamble',
        epilogue: 'ignored epilogue',
      });
      const chunks: Buffer[] = [];
      for (let i = 0; i < envelope.length; i += size) {
        chunks.push(envelope.subarray(i, i + size));
      }

      const bodies: Buffer[] = [];
      const rawHeaders: Buffer[] = [];
      for await (const part of parseMultipartRelated(Readable.from(chunks), {
        ...timeouts,
        boundary,
      })) {
        rawHeaders.push(part.rawHeaders);
        bodies.push(await streamToBuffer(part.body));
      }

      expect(bodies).toEqual([first, Buffer.alloc(0)]);
      expect(rawHeaders).toEqual([
        Buffer.from('Content-Type: application/dicom\r\n\r\n'),
        Buffer.from('\r\n'),
      ]);
    },
  );

  it('rejects a leading folded header through the iterator', async () => {
    const envelope = Buffer.from(
      `--${boundary}\r\n Content-Type: application/dicom\r\n\r\nbody\r\n--${boundary}--\r\n`,
    );
    const consume = async (): Promise<void> => {
      for await (const part of parseMultipartRelated(Readable.from([envelope]), {
        ...timeouts,
        boundary,
      })) {
        await streamToBuffer(part.body);
      }
    };

    await expect(consume()).rejects.toThrow('Unexpected folded header value');
  });

  it('continues after a caller destroys a part body under backpressure', async () => {
    const envelope = buildMultipartBody({
      boundary,
      parts: [
        { headers: {}, body: Buffer.alloc(64 * 1024, 42) },
        { headers: {}, body: Buffer.from('second') },
      ],
    });
    const chunks: Buffer[] = [];
    for (let i = 0; i < envelope.length; i += 1024) {
      chunks.push(envelope.subarray(i, i + 1024));
    }
    const iterator = parseMultipartRelated(Readable.from(chunks), {
      ...timeouts,
      boundary,
    });

    const first = await iterator.next();
    expect(first.done).toBe(false);
    if (first.done) throw new Error('Missing first part');
    first.value.body.destroy();

    const second = await iterator.next();
    expect(second.done).toBe(false);
    if (second.done) throw new Error('Missing second part');
    expect(await streamToBuffer(second.value.body)).toEqual(Buffer.from('second'));
    expect((await iterator.next()).done).toBe(true);
  });

  it('accepts a closing delimiter at end of input without a final CRLF', async () => {
    const envelope = Buffer.from(`--${boundary}\r\n\r\nbody\r\n--${boundary}--`);
    const bodies: Buffer[] = [];
    for await (const part of parseMultipartRelated(Readable.from([envelope]), {
      ...timeouts,
      boundary,
    })) {
      bodies.push(await streamToBuffer(part.body));
    }
    expect(bodies).toEqual([Buffer.from('body')]);
  });

  // A confirmed delimiter must end the current part immediately, even when the
  // source then stalls. streamsearch holds back trailing bytes that could
  // start another needle, and the delimiter's own CRLF is such a prefix, so the
  // part used to stay open until unrelated later bytes (or EOF) arrived.
  describe.each([
    ['next-part delimiter', `\r\n--${boundary}\r\n`],
    ['closing delimiter', `\r\n--${boundary}--\r\n`],
  ])('ends the part on a %s while the source stalls', (_name, tail) => {
    it.each([1, 2, 3, tail.length])('with %i-byte tail chunks', async (size) => {
      const source = new PassThrough();
      source.write(Buffer.from(`--${boundary}\r\nContent-Type: text/plain\r\n\r\nbody`));
      for (let i = 0; i < tail.length; i += size) {
        source.write(Buffer.from(tail.slice(i, i + size)));
      }
      // Deliberately never end the source.

      const iterator = parseMultipartRelated(source, { ...timeouts, boundary })[
        Symbol.asyncIterator
      ]();
      try {
        const first = await iterator.next();
        if (first.done) throw new Error('Missing first part');
        const outcome = await Promise.race([
          streamToBuffer(first.value.body),
          new Promise<'stalled'>((resolve) => {
            setTimeout(() => {
              resolve('stalled');
            }, 300);
          }),
        ]);
        expect(outcome).toEqual(Buffer.from('body'));
      } finally {
        await iterator.return(undefined);
      }
    });
  });

  it('keeps a near-miss closing marker in the body while it is still ambiguous', async () => {
    // `--` after the needle is only a close once CRLF or EOF follows; until
    // then it may be `--junk` body data, so the part must stay open.
    const source = new PassThrough();
    source.write(Buffer.from(`--${boundary}\r\n\r\nbody\r\n--${boundary}--`));
    const iterator = parseMultipartRelated(source, { ...timeouts, boundary })[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();
    if (first.done) throw new Error('Missing first part');
    const body = streamToBuffer(first.value.body);
    source.end(Buffer.from(`junk\r\n--${boundary}--\r\n`));
    expect(await body).toEqual(Buffer.from(`body\r\n--${boundary}--junk`));
    expect((await iterator.next()).done).toBe(true);
  });
});
