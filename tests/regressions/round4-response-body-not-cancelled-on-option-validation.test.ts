/**
 * Round 4: parseMultipartRelated cancels a Response body when the input is
 * unusable (normalizeInput failure, "US-007" comment in
 * parse-multipart-related.ts), but option validation (timeouts, caps) runs
 * BEFORE that try/catch, so an invalid option rejects the first `.next()`
 * while the Response body stays un-cancelled: the HTTP connection is held
 * open until the server or GC tears it down.
 */
import { expect, it } from 'vitest';

import { parseMultipartRelated } from '../../src/index.js';

function makeResponse(onCancel: () => void): Response {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      // never produces: like a live socket waiting for more bytes
    },
    cancel() {
      onCancel();
    },
  });
  return new Response(body, { headers: { 'content-type': 'multipart/related; boundary=b' } });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

it('control: an unusable Content-Type cancels the body', async () => {
  let cancelled = false;
  const res = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        // never produces
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'multipart/related' } },
  );
  await expect(
    parseMultipartRelated(res, { idleTimeoutMs: 100, totalTimeoutMs: 100 }).next(),
  ).rejects.toThrow(/boundary/);
  await tick();
  expect(cancelled).toBe(true);
});

it('cancels the body when an option fails validation', async () => {
  let cancelled = false;
  const res = makeResponse(() => {
    cancelled = true;
  });
  await expect(
    parseMultipartRelated(res, { idleTimeoutMs: 0, totalTimeoutMs: 1000 }).next(),
  ).rejects.toThrow(TypeError);
  await tick();
  expect(cancelled).toBe(true);
});

it('cancels the body when a cap fails validation', async () => {
  let cancelled = false;
  const res = makeResponse(() => {
    cancelled = true;
  });
  await expect(
    parseMultipartRelated(res, { idleTimeoutMs: 100, totalTimeoutMs: 1000, maxParts: 0 }).next(),
  ).rejects.toThrow(TypeError);
  await tick();
  expect(cancelled).toBe(true);
});
