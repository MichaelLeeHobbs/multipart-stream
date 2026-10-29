import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  MultipartAbortError,
  MultipartIdleTimeoutError,
  parseMultipartRelated,
  streamToBuffer,
} from '../../src/index.js';

const boundary = 'B';

function stalledSource(): PassThrough {
  const src = new PassThrough();
  // Headers + partial body, then the server stalls forever.
  src.write(`--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\npartial-body`);
  return src;
}

async function consume(src: PassThrough, opts: { signal?: AbortSignal }): Promise<unknown> {
  try {
    for await (const part of parseMultipartRelated(src, {
      idleTimeoutMs: 50,
      totalTimeoutMs: 10_000,
      boundary,
      ...opts,
    })) {
      await streamToBuffer(part.body);
    }
    return 'completed';
  } catch (err) {
    return err;
  }
}

const HANG = Symbol('hang');
const withDeadline = (p: Promise<unknown>, ms: number): Promise<unknown> =>
  Promise.race([p, new Promise((r) => setTimeout(() => r(HANG), ms))]);

describe('review: timeout/abort while the consumer is reading a part body', () => {
  it('idle timeout unblocks a consumer awaiting part.body', async () => {
    const src = stalledSource();
    const result = await withDeadline(consume(src, {}), 1_000);
    src.destroy();
    expect(result).toBeInstanceOf(MultipartIdleTimeoutError);
  });

  it('caller abort unblocks a consumer awaiting part.body', async () => {
    const src = stalledSource();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new Error('user cancel')), 20);
    const p = (async () => {
      try {
        for await (const part of parseMultipartRelated(src, {
          idleTimeoutMs: 60_000,
          totalTimeoutMs: 60_000,
          boundary,
          signal: ctrl.signal,
        })) {
          await streamToBuffer(part.body);
        }
        return 'completed';
      } catch (err) {
        return err;
      }
    })();
    const result = await withDeadline(p, 1_000);
    src.destroy();
    expect(result).toBeInstanceOf(MultipartAbortError);
  });
});
