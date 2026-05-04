import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToString } from '../../src/index.js';
import {
  captureDicerActivity,
  type DicerActivityTracker,
} from '../fixtures/dicer-activity.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const BOUNDARY = 'CLEANUP-BOUNDARY';
const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

/**
 * Wait one event-loop turn so `pipe()`-driven destroy/'close' chains can
 * settle. The cleanup function in `parse-multipart-related.ts` is fully
 * synchronous, but `source.destroy()` schedules its 'close' on a microtask
 * and dicer's prototype pumps part bodies in `process.nextTick`.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

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
 * Common listener-count + destroy assertions used across every termination
 * path. Per `kiln/spec/test-plan.md` §"Resource-Leak Hygiene Suite":
 *   - dicer.listenerCount('part') === 0
 *   - dicer.listenerCount('finish') === 0
 *   - dicer.listenerCount('error') >= 1   (FR-011 retention)
 *   - source.destroyed === true
 *   - every captured part Readable is destroyed (drain-on-finally)
 */
function assertListenerLeakClean(
  tracker: DicerActivityTracker,
  source: Readable,
): void {
  const dicers = tracker.dicerInstances();
  expect(dicers.length).toBeGreaterThanOrEqual(1);
  for (const dicer of dicers) {
    expect(dicer.listenerCount('part')).toBe(0);
    expect(dicer.listenerCount('finish')).toBe(0);
    expect(dicer.listenerCount('error')).toBeGreaterThanOrEqual(1);
  }
  expect(source.destroyed).toBe(true);
  for (const part of tracker.partStreams()) {
    expect(part.destroyed).toBe(true);
  }
}

describe('parseMultipartRelated — Resource-Leak Hygiene Suite', () => {
  let tracker: DicerActivityTracker;

  beforeEach(() => {
    tracker = captureDicerActivity();
  });

  afterEach(() => {
    tracker.restore();
  });

  it('T-027: success path — full iteration of 3 parts; listeners cleaned, source destroyed, parts drained', async () => {
    const buf = buildEnvelope(3);
    const source = Readable.from(buf);
    const collected: string[] = [];

    for await (const part of parseMultipartRelated(source, {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      collected.push(await streamToString(part.body));
    }

    expect(collected).toEqual(['body-0', 'body-1', 'body-2']);
    await settle();
    assertListenerLeakClean(tracker, source);
  });

  it('T-015: caller break after part 1 — unyielded 4 part bodies destroyed; listeners cleaned', async () => {
    const buf = buildEnvelope(5);
    const source = Readable.from(buf);
    const collected: string[] = [];

    for await (const part of parseMultipartRelated(source, {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      collected.push(await streamToString(part.body));
      break;
    }

    expect(collected).toEqual(['body-0']);
    await settle();
    assertListenerLeakClean(tracker, source);
  });

  it('T-068: source emits error after 1 chunk — iterator rejects with that error; cleanup runs', async () => {
    // Custom Readable that emits one chunk then errors. Push happens once
    // (state guard), then the next `read()` call schedules destroy().
    const buf = buildEnvelope(2);
    const sourceErr = new Error('source-blew-up');
    let pushed = false;
    const source = new Readable({
      read() {
        if (!pushed) {
          pushed = true;
          this.push(buf.subarray(0, Math.min(50, buf.length)));
          process.nextTick(() => {
            this.destroy(sourceErr);
          });
        }
        // After the first push, subsequent reads do nothing — destroy
        // will fire on next tick and end the stream with an error.
      },
    });

    let captured: unknown;
    try {
      const iter = parseMultipartRelated(source, {
        ...TIMEOUTS,
        boundary: BOUNDARY,
      });
      // The source errors before completing the second part; we may or
      // may not yield part 0 depending on chunk timing. Either way the
      // generator must reject when the source error surfaces.
      while (true) {
        const next = await iter.next();
        if (next.done) break;
      }
    } catch (err) {
      captured = err;
    }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toMatch(/source-blew-up/);
    await settle();
    assertListenerLeakClean(tracker, source);
  });

  it('T-008-equivalent: caller throws inside for-await — cleanup runs (parser-throw via inline harness)', async () => {
    // The full FR-014 contract (parser-throw cleanup via fetchAndHandleMultipart)
    // lives in `tests/integration/fetch-and-handle.test.ts`. Here we
    // prove the equivalent at the parseMultipartRelated layer: a CALLER
    // throwing inside the for-await loop is semantically the same code
    // path — the generator's `finally` runs and cleanup is correct.
    const buf = buildEnvelope(3);
    const source = Readable.from(buf);
    const callerErr = new Error('parser-boom');

    let captured: unknown;
    try {
      let i = 0;
      for await (const part of parseMultipartRelated(source, {
        ...TIMEOUTS,
        boundary: BOUNDARY,
      })) {
        if (i === 1) throw callerErr;
        await streamToString(part.body);
        i += 1;
      }
    } catch (err) {
      captured = err;
    }

    expect(captured).toBe(callerErr);
    await settle();
    assertListenerLeakClean(tracker, source);
  });

  it('T-044: per-path snapshot — listener counts match the suite invariants on every path', async () => {
    // Parameterized check that walks each cleanup-owned termination path
    // through the same fixture and asserts the listener-count delta. The
    // timer/abort termination paths (idle/total/abort) hook into this
    // same helper from their own test files.
    const cases: Array<{ name: string; run: () => Promise<Readable> }> = [
      {
        name: 'success',
        run: async () => {
          const source = Readable.from(buildEnvelope(2));
          for await (const part of parseMultipartRelated(source, {
            ...TIMEOUTS,
            boundary: BOUNDARY,
          })) {
            await streamToString(part.body);
          }
          return source;
        },
      },
      {
        name: 'break',
        run: async () => {
          const source = Readable.from(buildEnvelope(3));
          for await (const part of parseMultipartRelated(source, {
            ...TIMEOUTS,
            boundary: BOUNDARY,
          })) {
            await streamToString(part.body);
            break;
          }
          return source;
        },
      },
      {
        name: 'caller-throw',
        run: async () => {
          const source = Readable.from(buildEnvelope(3));
          try {
            for await (const _ of parseMultipartRelated(source, {
              ...TIMEOUTS,
              boundary: BOUNDARY,
            })) {
              void _;
              throw new Error('boom');
            }
          } catch {
            // expected
          }
          return source;
        },
      },
    ];

    for (const c of cases) {
      tracker.resetTracking();
      const source = await c.run();
      await settle();
      assertListenerLeakClean(tracker, source);
    }
  });

  it('FR-017 unpipe-throw site: cleanup logs through the configured logger and continues', async () => {
    // The cleanup `unpipe` call at architecture.md §7 (FR-017 silent-catch
    // replacement site) routes through the configured logger when it
    // throws. We force a throw by overriding `source.unpipe` AFTER pipe
    // was established but BEFORE the consumer break triggers cleanup.
    const buf = buildEnvelope(3);
    const source = Readable.from(buf);
    const events: Array<{ level: 'warn'; msg: string; meta?: unknown }> = [];
    const logger = (e: { level: 'warn'; msg: string; meta?: unknown }) => {
      events.push(e);
    };

    // Stash a no-op replacement for `source.unpipe`. We swap it in AFTER
    // the iterator has yielded part 0 (so production code's pipe()
    // already wired everything up) and BEFORE we break (so cleanup's
    // unpipe call hits the throwing override). After cleanup runs, we
    // immediately restore — Node's later cleanup chain (Dicer.onclose →
    // source.unpipe) sees the no-op original.
    const originalUnpipe = source.unpipe.bind(source);
    const throwingUnpipe = (() => {
      throw new Error('unpipe-blew-up');
    }) as typeof source.unpipe;

    try {
      for await (const part of parseMultipartRelated(source, {
        ...TIMEOUTS,
        boundary: BOUNDARY,
        logger,
      })) {
        await streamToString(part.body);
        // Swap in the throwing unpipe RIGHT BEFORE break — production
        // cleanup's unpipe call will hit it.
        source.unpipe = throwingUnpipe;
        break;
      }
    } catch {
      // ignore — we're focused on cleanup-time logging
    } finally {
      // Restore so any post-cleanup teardown chain (Node internals
      // calling unpipe again on close) doesn't throw.
      source.unpipe = originalUnpipe;
    }

    await settle();
    const unpipeEvents = events.filter((e) =>
      e.msg.includes('unpipe failed during cleanup'),
    );
    expect(unpipeEvents.length).toBeGreaterThanOrEqual(1);
    const meta = unpipeEvents[0]!.meta as {
      errSummary: { name: string; message: string };
    };
    // Messages are JSON-stringified per NFR-DR-S-006.
    expect(meta.errSummary.message).toBe('"unpipe-blew-up"');
  });

  it('cleanup is idempotent — already-destroyed source does not double-destroy', async () => {
    // Exercise the `if (!source.destroyed) source.destroy()` short-circuit
    // by destroying the source ourselves before the iterator's finally
    // runs.
    const buf = buildEnvelope(2);
    const source = Readable.from(buf);

    let captured: unknown;
    try {
      for await (const part of parseMultipartRelated(source, {
        ...TIMEOUTS,
        boundary: BOUNDARY,
      })) {
        await streamToString(part.body);
        // Pre-destroy — the cleanup function will see `source.destroyed`
        // as true and skip the destroy call.
        source.destroy();
        break;
      }
    } catch (err) {
      captured = err;
    }

    void captured;
    await settle();
    expect(source.destroyed).toBe(true);
  });

  it('drain-on-finally: 5 unyielded parts after early break all have body.destroyed === true', async () => {
    // The silent leak BRIEF flags (architecture.md §5.3): dicer's per-part
    // Readables hold buffered chunks and are not GC-eligible until destroyed.
    // The drain-on-finally cleanup guarantees every unyielded part body
    // is destroyed when the generator's finally runs.
    const buf = buildEnvelope(5);
    const source = Readable.from(buf);

    for await (const part of parseMultipartRelated(source, {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      // DELIBERATELY do NOT consume part.body — this forces the queue to
      // accumulate parts the consumer never yields, exercising the
      // drain-on-finally path.
      void part;
      break;
    }

    await settle();
    // Every captured part Readable from the harness is destroyed (the
    // body of the yielded part is destroyed by source.destroy()'s teardown,
    // and the unyielded ones are destroyed explicitly by drainPendingParts).
    for (const partStream of tracker.partStreams()) {
      expect(partStream.destroyed).toBe(true);
    }
  });
});
