/**
 * Integration tests for `parseMultipartRelated` timeout machinery
 * (FR-006 / FR-007 / FR-008 / FR-DR-A-025).
 *
 * Covers:
 *   - T-026b: required timeouts on parseMultipartRelated (both overloads)
 *   - T-009: idle timeout fires when no bytes for idleTimeoutMs
 *   - T-010: idle timer resets per-chunk; slow-but-steady success
 *   - T-011: total timeout fires regardless of activity
 *   - T-073: idle reset rides the source 'data' listener, NOT onProgress
 *
 * Fake-timer fixture choice: we use a custom Readable (`slowReadable`) that
 * schedules its `push()` calls via `setTimeout`. This composes cleanly with
 * `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`. The tests
 * then drive time forward via `vi.advanceTimersByTimeAsync`.
 */

import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MultipartIdleTimeoutError,
  MultipartTotalTimeoutError,
  type ParseMultipartOptions,
  parseMultipartRelated,
  streamToString,
} from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const BOUNDARY = 'TIMEOUT-BOUNDARY';

function buildEnvelope(partCount: number): Buffer {
  return buildMultipartBody({
    boundary: BOUNDARY,
    parts: Array.from({ length: partCount }, (_, i) => ({
      headers: {
        'Content-Type': 'text/plain',
        'Content-ID': `<part-${String(i)}>`,
      },
      body: `body-${String(i)}`,
    })),
  });
}

/**
 * Build a Readable that yields each chunk after `gapMs` of silence, driven
 * by the test's fake-timer clock. This is the simplest fixture that
 * composes with vi.useFakeTimers — push-on-setTimeout means the chunks
 * land exactly when `vi.advanceTimersByTimeAsync(gapMs)` fires.
 *
 * @param chunks - Chunks to deliver in order.
 * @param gapMs - Delay between chunks.
 * @param endAfterChunks - When `true` (default), push null after the last
 *   chunk to signal end-of-stream. When `false`, the readable stays silent
 *   forever after the last chunk — used by idle-timeout tests where we
 *   want the source to STALL, not end (a real hung connection does not
 *   push EOF; it just sits there until the idle timer fires).
 */
function slowReadable(
  chunks: readonly Buffer[],
  gapMs: number,
  endAfterChunks = true,
): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i >= chunks.length) {
        if (endAfterChunks) this.push(null);
        // Else: do nothing. The stream is "stalled" — no more chunks,
        // no end signal. The library's idle/total timer must fire.
        return;
      }
      const idx = i++;
      setTimeout(() => {
        this.push(chunks[idx]);
      }, gapMs);
    },
  });
}

describe('parseMultipartRelated — T-026b: required timeouts (FR-006/JC-3)', () => {
  // The static (compile-time) FR-006 contract is enforced by the type system —
  // ParseMultipartOptions.idleTimeoutMs / totalTimeoutMs are NOT optional, so
  // omitting them at the type level is a compile error already caught by
  // tsc. These tests focus on the RUNTIME validation surface: a caller who
  // bypasses the type system (e.g. passes an untyped JSON.parse output)
  // still gets a sync TypeError. We launder through `as ParseMultipartOptions`
  // to suppress the static check exactly for these runtime-validation tests.
  type Bag = ParseMultipartOptions;
  const cast = <T extends object>(obj: T): ParseMultipartOptions =>
    obj as unknown as ParseMultipartOptions;

  it('first .next() rejects when idleTimeoutMs is missing (Response overload)', async () => {
    const res = new Response(buildEnvelope(1), {
      headers: {
        'content-type': `multipart/related; boundary=${BOUNDARY}`,
      },
    });
    const iter = parseMultipartRelated(
      res,
      cast({ totalTimeoutMs: 5_000 }),
    );
    await expect(iter.next()).rejects.toThrow(/idleTimeoutMs/);
    // Second iterator instance to verify the TypeError class (the first
    // call's rejection consumed the generator, so we build a fresh one).
    const iter2 = parseMultipartRelated(
      new Response(buildEnvelope(1), {
        headers: {
          'content-type': `multipart/related; boundary=${BOUNDARY}`,
        },
      }),
      cast({ totalTimeoutMs: 5_000 }),
    );
    await expect(iter2.next()).rejects.toThrow(TypeError);
  });

  it('first .next() rejects when totalTimeoutMs is missing (Response overload)', async () => {
    const iter = parseMultipartRelated(
      new Response(buildEnvelope(1), {
        headers: {
          'content-type': `multipart/related; boundary=${BOUNDARY}`,
        },
      }),
      cast({ idleTimeoutMs: 5_000 }),
    );
    await expect(iter.next()).rejects.toThrow(/totalTimeoutMs/);
  });

  it('first .next() rejects when both timeouts are missing (Readable overload)', async () => {
    const source = Readable.from(buildEnvelope(1));
    const iter = parseMultipartRelated(
      source,
      cast({ boundary: BOUNDARY }) as Bag & { boundary: string },
    );
    await expect(iter.next()).rejects.toThrow(TypeError);
    // The error message must mention setTimeout clamping (NFR-DR-S-009).
    try {
      const iter2 = parseMultipartRelated(
        Readable.from(buildEnvelope(1)),
        cast({ boundary: BOUNDARY }) as Bag & { boundary: string },
      );
      await iter2.next();
    } catch (err) {
      expect((err as Error).message).toMatch(/setTimeout/);
    }
  });

  it('Readable overload: rejects on missing idleTimeoutMs', async () => {
    const source = Readable.from(buildEnvelope(1));
    const iter = parseMultipartRelated(
      source,
      cast({ boundary: BOUNDARY, totalTimeoutMs: 5_000 }) as Bag & {
        boundary: string;
      },
    );
    await expect(iter.next()).rejects.toThrow(/idleTimeoutMs/);
  });

  it('Readable overload: rejects on missing totalTimeoutMs', async () => {
    const source = Readable.from(buildEnvelope(1));
    const iter = parseMultipartRelated(
      source,
      cast({ boundary: BOUNDARY, idleTimeoutMs: 5_000 }) as Bag & {
        boundary: string;
      },
    );
    await expect(iter.next()).rejects.toThrow(/totalTimeoutMs/);
  });

  it('rejects on invalid timeout values (T-060..T-065 surface from generator)', async () => {
    const cases: Array<readonly [unknown, RegExp]> = [
      [0, /idleTimeoutMs/],
      [Number.NaN, /idleTimeoutMs/],
      [Number.POSITIVE_INFINITY, /idleTimeoutMs/],
      [-1, /idleTimeoutMs/],
      [1.5, /idleTimeoutMs/],
    ];
    for (const [bad, pattern] of cases) {
      const source = Readable.from(buildEnvelope(1));
      const iter = parseMultipartRelated(source, {
        boundary: BOUNDARY,
        idleTimeoutMs: bad as number,
        totalTimeoutMs: 5_000,
      });
      await expect(iter.next()).rejects.toThrow(pattern);
    }
  });
});

describe('parseMultipartRelated — T-009: idle timeout (FR-007)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with MultipartIdleTimeoutError when source stalls past idleTimeoutMs', async () => {
    // Source emits one chunk then never sends more (NO end signal — a
    // hung connection). Idle window is 5s; we advance 6s and assert idle
    // wins.
    const buf = buildEnvelope(2);
    const head = buf.subarray(0, 30);
    const source = slowReadable([head], 100, /* endAfterChunks */ false);

    const iter = parseMultipartRelated(source, {
      boundary: BOUNDARY,
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 60_000,
    });

    // Drive time forward — the head chunk lands at 100ms, then silence
    // until 5_100ms when idle should fire. Advance 6_000ms total.
    const consumePromise = (async () => {
      try {
        for await (const part of iter) {
          await streamToString(part.body).catch(() => undefined);
        }
      } catch (err) {
        return err;
      }
      return undefined;
    })();

    await vi.advanceTimersByTimeAsync(6_000);
    const captured = await consumePromise;

    expect(captured).toBeInstanceOf(MultipartIdleTimeoutError);
    expect((captured as MultipartIdleTimeoutError).idleTimeoutMs).toBe(5_000);
    expect(source.destroyed).toBe(true);
  });
});

describe('parseMultipartRelated — T-010: per-chunk idle reset (FR-DR-A-025)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('slow-but-steady chunks (every 4s) succeed under idleTimeoutMs:5000', async () => {
    // Build a 1-part envelope and split it into ~10 chunks. Each chunk
    // arrives 4s after the previous; idle window is 5s. The per-chunk
    // reset means we never trip the idle timer. Total elapsed is ~40s,
    // well under totalTimeoutMs:60_000.
    const buf = buildEnvelope(1);
    const chunkSize = Math.max(1, Math.ceil(buf.length / 10));
    const chunks: Buffer[] = [];
    for (let off = 0; off < buf.length; off += chunkSize) {
      chunks.push(buf.subarray(off, Math.min(off + chunkSize, buf.length)));
    }
    const source = slowReadable(chunks, 4_000);

    const collected: string[] = [];
    const consumePromise = (async () => {
      for await (const part of parseMultipartRelated(source, {
        boundary: BOUNDARY,
        idleTimeoutMs: 5_000,
        totalTimeoutMs: 60_000,
      })) {
        collected.push(await streamToString(part.body));
      }
    })();

    // Advance time chunk-by-chunk. Each advanceTimersByTimeAsync call
    // releases the next setTimeout (the slowReadable's gap), which lets
    // the source `read()` push the chunk; the parseMultipartRelated's
    // 'data' listener resets the idle timer.
    await vi.advanceTimersByTimeAsync(50_000);
    await consumePromise;

    expect(collected).toEqual(['body-0']);
  });
});

describe('parseMultipartRelated — T-011: total timeout (FR-008)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with MultipartTotalTimeoutError when total wallclock exceeds totalTimeoutMs', async () => {
    // Bytes arrive every 1s indefinitely; totalTimeoutMs:5000 wins.
    // We keep the source open (endAfterChunks=false) in case our chunks
    // are exhausted before the total timer fires — we want the timer to
    // fire on its own schedule, not because the source naturally ended.
    const buf = buildEnvelope(10);
    const chunkSize = 1; // 1 byte per chunk — bytes always arrive
    const chunks: Buffer[] = [];
    for (let off = 0; off < buf.length; off += chunkSize) {
      chunks.push(buf.subarray(off, off + chunkSize));
    }
    const source = slowReadable(chunks, 1_000, /* endAfterChunks */ false);

    const iter = parseMultipartRelated(source, {
      boundary: BOUNDARY,
      idleTimeoutMs: 60_000, // idle never fires
      totalTimeoutMs: 5_000,
    });

    const consumePromise = (async () => {
      try {
        for await (const part of iter) {
          await streamToString(part.body).catch(() => undefined);
        }
      } catch (err) {
        return err;
      }
      return undefined;
    })();

    await vi.advanceTimersByTimeAsync(6_000);
    const captured = await consumePromise;

    expect(captured).toBeInstanceOf(MultipartTotalTimeoutError);
    expect((captured as MultipartTotalTimeoutError).totalTimeoutMs).toBe(
      5_000,
    );
    expect(source.destroyed).toBe(true);
  });
});

describe('parseMultipartRelated — T-073: idle reset rides source-data, NOT onProgress', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('NO onProgress supplied — slow chunks succeed (proves idle reset is independent of onProgress)', async () => {
    // Same shape as T-010 but explicitly with NO onProgress. If the
    // implementation accidentally tied idle reset to onProgress (the
    // pre-FR-DR-A-025 behavior), this test would fail with idle-timeout.
    const buf = buildEnvelope(1);
    const chunkSize = Math.max(1, Math.ceil(buf.length / 10));
    const chunks: Buffer[] = [];
    for (let off = 0; off < buf.length; off += chunkSize) {
      chunks.push(buf.subarray(off, Math.min(off + chunkSize, buf.length)));
    }
    const source = slowReadable(chunks, 4_000);

    const collected: string[] = [];
    const consumePromise = (async () => {
      for await (const part of parseMultipartRelated(source, {
        boundary: BOUNDARY,
        idleTimeoutMs: 5_000,
        totalTimeoutMs: 60_000,
        // NO onProgress — per FR-DR-A-025, idle still resets via the
        // per-chunk source 'data' listener.
      })) {
        collected.push(await streamToString(part.body));
      }
    })();

    await vi.advanceTimersByTimeAsync(50_000);
    await consumePromise;

    expect(collected).toEqual(['body-0']);
  });

  it('onProgress fires per-part — NOT per source chunk (FR-013 vs FR-DR-A-025 separation)', async () => {
    // Build a 3-part envelope, drive it through a fast source. Spy on
    // onProgress and assert it fires AT LEAST once per yielded part —
    // typically equal to part count (`fetchAndHandleMultipart` adds the
    // completion tick on top). The chunk count from a Readable.from(buf)
    // iteration is implementation-defined; per FR-013 onProgress is
    // per-part, so we assert <= part count + 1 (allowing the eventual
    // completion tick).
    const buf = buildEnvelope(3);
    const source = Readable.from(buf);
    const progressCalls: Array<{
      bytes: number;
      elapsedMs: number;
      rateBps: number;
    }> = [];

    for await (const part of parseMultipartRelated(source, {
      boundary: BOUNDARY,
      idleTimeoutMs: 60_000,
      totalTimeoutMs: 60_000,
      onProgress: (snap) => progressCalls.push({ ...snap }),
    })) {
      await streamToString(part.body);
    }

    // FR-013: at least once per yielded part.
    expect(progressCalls.length).toBeGreaterThanOrEqual(3);
    // FR-013: NOT per source chunk (which would be far more for a small
    // envelope split into many tiny chunks). Concretely: progressCalls
    // should not exceed 4 (3 parts + future completion tick).
    expect(progressCalls.length).toBeLessThanOrEqual(4);
  });
});

describe('parseMultipartRelated — happy path is unaffected by timer wiring', () => {
  it('successful 3-part iteration with finite timeouts works (no timer fires)', async () => {
    const buf = buildEnvelope(3);
    const source = Readable.from(buf);
    const collected: string[] = [];
    for await (const part of parseMultipartRelated(source, {
      boundary: BOUNDARY,
      idleTimeoutMs: 60_000,
      totalTimeoutMs: 60_000,
    })) {
      collected.push(await streamToString(part.body));
    }
    expect(collected).toEqual(['body-0', 'body-1', 'body-2']);
  });
});
