import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  streamToBuffer,
  streamToString,
} from '../../src/stream-helpers.js';

describe('streamToString (FR-015, T-017)', () => {
  it('drains a Readable to a single string with default utf8 encoding', async () => {
    const readable = Readable.from([
      Buffer.from('hello'),
      Buffer.from(' world'),
    ]);
    const text = await streamToString(readable);
    expect(text).toBe('hello world');
    expect(readable.readableEnded).toBe(true);
  });

  it('honors an explicit utf-8 encoding (matches default)', async () => {
    const readable = Readable.from([Buffer.from('hello', 'utf8')]);
    const text = await streamToString(readable, 'utf8');
    expect(text).toBe('hello');
  });

  it('returns empty string for a zero-byte source', async () => {
    const readable = Readable.from([]);
    const text = await streamToString(readable);
    expect(text).toBe('');
  });

  it('rejects when the source emits an error', async () => {
    const readable = new Readable({
      read(): void {
        process.nextTick(() => this.destroy(new Error('boom')));
      },
    });
    await expect(streamToString(readable)).rejects.toThrow('boom');
  });

  it('handles a stream that emits string chunks (object-mode-ish)', async () => {
    // Some streams emit strings rather than Buffers; the helper should
    // tolerate both.
    const readable = Readable.from(['hello', ' world']);
    const text = await streamToString(readable);
    expect(text).toBe('hello world');
  });

  it('T-017b: rejects when input exceeds maxBytes (NFR-DR-S-002); destroys source', async () => {
    // 100-byte source; cap at 5; expect reject + destroyed.
    const payload = 'x'.repeat(100);
    const readable = Readable.from([Buffer.from(payload, 'utf8')]);
    await expect(
      streamToString(readable, 'utf8', { maxBytes: 5 }),
    ).rejects.toThrow(/exceeded maxBytes \(5\)/);
    expect(readable.destroyed).toBe(true);
  });

  it('T-017b: tight-fit allows total === maxBytes', async () => {
    const payload = 'hello'; // 5 bytes
    const readable = Readable.from([Buffer.from(payload, 'utf8')]);
    const out = await streamToString(readable, 'utf8', { maxBytes: 5 });
    expect(out).toBe('hello');
  });
});

describe('streamToBuffer (FR-015, T-018)', () => {
  it('drains a Readable to a single Buffer with binary content', async () => {
    const readable = Readable.from([
      Buffer.from([0, 1, 2]),
      Buffer.from([3, 4, 5]),
    ]);
    const buf = await streamToBuffer(readable);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(6);
    expect(Array.from(buf)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('roundtrips arbitrary binary bytes (T-018)', async () => {
    const original = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    const readable = Readable.from([original]);
    const buf = await streamToBuffer(readable);
    expect(buf.equals(original)).toBe(true);
  });

  it('returns Buffer.alloc(0) for a zero-byte source (T-028 partial)', async () => {
    const readable = Readable.from([]);
    const buf = await streamToBuffer(readable);
    expect(buf.length).toBe(0);
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it('rejects when the source emits an error', async () => {
    const readable = new Readable({
      read(): void {
        process.nextTick(() => this.destroy(new Error('socket hangup')));
      },
    });
    await expect(streamToBuffer(readable)).rejects.toThrow('socket hangup');
  });

  it('T-018b: rejects when input exceeds maxBytes (NFR-DR-S-002); destroys source', async () => {
    // 6-byte source; cap at 3; expect reject + destroyed.
    const readable = Readable.from([Buffer.from([1, 2, 3, 4, 5, 6])]);
    await expect(streamToBuffer(readable, { maxBytes: 3 })).rejects.toThrow(
      /exceeded maxBytes \(3\)/,
    );
    expect(readable.destroyed).toBe(true);
  });

  it('T-018b: tight-fit allows total === maxBytes', async () => {
    const readable = Readable.from([Buffer.from([1, 2, 3])]);
    const buf = await streamToBuffer(readable, { maxBytes: 3 });
    expect(buf.length).toBe(3);
    expect(Array.from(buf)).toEqual([1, 2, 3]);
  });

  it('handles a stream that emits string chunks (object-mode-ish)', async () => {
    // Coverage for the string-chunk branch in streamToBuffer's onData.
    const readable = Readable.from(['ab', 'cd']);
    const buf = await streamToBuffer(readable);
    expect(buf.toString('utf8')).toBe('abcd');
  });
});
