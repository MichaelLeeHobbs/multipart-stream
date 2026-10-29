/**
 * Round 4: parseMultipartRelated keeps every part stream (and its maxPartBytes
 * counter) in `allPartStreams` until the generator closes. Entries are never
 * removed when a part finishes, so a long envelope retains one Readable (plus
 * listeners/closures, ~1.8 KB measured) per part for the whole operation —
 * ~18 MB at the default maxParts of 10 000, unbounded when maxParts is
 * raised. `fail` already skips complete parts, so finished streams serve no
 * purpose there.
 */
import { PassThrough } from 'node:stream';
import v8 from 'node:v8';
import vm from 'node:vm';

import { expect, it } from 'vitest';

import { parseMultipartRelated } from '../../src/index.js';

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;

it('lets fully consumed part bodies be garbage-collected while iteration continues', async () => {
  const N = 2000;
  const src = new PassThrough();
  let env = '';
  for (let i = 0; i < N; i++) env += `--b\r\nX-I: ${String(i)}\r\n\r\nx\r\n`;
  const iter = parseMultipartRelated(src, {
    boundary: 'b',
    idleTimeoutMs: 10_000,
    totalTimeoutMs: 20_000,
  });
  src.write(env); // the source stays open, so the iterator does too
  const refs: WeakRef<object>[] = [];
  try {
    for (let i = 0; i < N - 1; i++) {
      const r = await iter.next();
      if (r.done === true) throw new Error('ended early');
      refs.push(new WeakRef(r.value.body));
      for await (const chunk of r.value.body) void chunk;
    }
    gc();
    await new Promise((r) => setTimeout(r, 10));
    gc();
    const alive = refs.filter((r) => r.deref() !== undefined).length;
    // Only a handful of recent parts may legitimately still be referenced.
    expect(alive).toBeLessThan(refs.length / 2);
  } finally {
    await iter.return();
  }
}, 30_000);
