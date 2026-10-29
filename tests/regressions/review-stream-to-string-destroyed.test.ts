import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { streamToBuffer, streamToString } from '../../src/index.js';

const HANG = Symbol('hang');
const deadline = (p: Promise<unknown>): Promise<unknown> =>
  Promise.race([
    p.then(
      (v) => v,
      (e: unknown) => e,
    ),
    new Promise((r) => setTimeout(() => r(HANG), 300)),
  ]);

describe('review: stream helpers settle when the stream is destroyed without an error', () => {
  it('streamToString settles if the readable is destroyed mid-read', async () => {
    const s = new PassThrough();
    s.write('abc');
    const p = streamToString(s);
    setTimeout(() => s.destroy(), 10);
    expect(await deadline(p)).not.toBe(HANG);
  });

  it('streamToBuffer settles if the readable is destroyed mid-read', async () => {
    const s = new PassThrough();
    s.write('abc');
    const p = streamToBuffer(s);
    setTimeout(() => s.destroy(), 10);
    expect(await deadline(p)).not.toBe(HANG);
  });
});
