import { PassThrough, Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { streamToBuffer, streamToString } from '../../src/index.js';

describe('streamToString / streamToBuffer', () => {
  it('rejects an unknown encoding', async () => {
    await expect(streamToString(Readable.from([]), 'bogus' as BufferEncoding)).rejects.toThrow(
      new TypeError('streamToString: unknown encoding "bogus"'),
    );
  });

  it.each([0, -1, 1.5, Number.NaN, '4'])('rejects maxBytes %j', async (maxBytes) => {
    await expect(
      streamToBuffer(Readable.from([]), { maxBytes: maxBytes as number }),
    ).rejects.toThrow(
      new TypeError('streamToBuffer: maxBytes must be a positive safe integer when set'),
    );
  });

  it('accepts maxBytes of 1 for a one-byte stream', async () => {
    await expect(
      streamToBuffer(Readable.from([Buffer.from('a')]), { maxBytes: 1 }),
    ).resolves.toEqual(Buffer.from('a'));
  });

  it('destroys the source when maxBytes is exceeded', async () => {
    const source = new PassThrough();
    const result = streamToBuffer(source, { maxBytes: 2 });
    source.write('abc');
    await expect(result).rejects.toThrow('streamToBuffer: input exceeded maxBytes (2)');
    expect(source.destroyed).toBe(true);
  });

  it('rejects a chunk that cannot be converted to bytes', async () => {
    const source = new Readable({ objectMode: true, read: () => undefined });
    const result = streamToBuffer(source);
    source.push(Symbol('not bytes'));
    await expect(result).rejects.toThrow(
      new TypeError('streamToBuffer: stream emitted a non-byte chunk'),
    );
    expect(source.destroyed).toBe(true);
  });

  it('removes its listeners from the source once settled', async () => {
    const source = new PassThrough();
    const before = ['data', 'end', 'error', 'close'].map((e) => source.listenerCount(e));
    const result = streamToBuffer(source);
    source.end('abc');
    await expect(result).resolves.toEqual(Buffer.from('abc'));
    expect(['data', 'end', 'error', 'close'].map((e) => source.listenerCount(e))).toEqual(before);
  });

  it('resolves an empty stream to an empty buffer', async () => {
    await expect(streamToBuffer(Readable.from([]))).resolves.toEqual(Buffer.alloc(0));
  });
});
