/**
 * Integration tests for `fetchAndHandleMultipart` (Layer B orchestration).
 *
 * Covers:
 *   - T-006: 3-part envelope; parser keeps only Content-ID:<meta> →
 *     parts.length === 1; other 2 part bodies were drained
 *   - T-007: parser always returns undefined → parts.length === 0;
 *     bytes > 0; elapsedMs > 0
 *   - T-008: parser throws on part 2 → outer reject; full FR-010 cleanup
 *   - T-014 full: onProgress per yielded part PLUS one completion-tick
 *     call; final call has finite rateBps and final bytes
 *   - T-019: caller-supplied event-style logger receives Layer-B
 *     completion-tick onProgress-throw event
 *   - T-020: default console.warn fallback when logger omitted
 *   - T-031..T-033: FR-017 silent-catch replacement sites — onProgress
 *     throws (Layer A per-part site + Layer B completion-tick site)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAndHandleMultipart,
  type ProgressSnapshot,
  type StreamingMultipartPart,
  streamToString,
} from '../../src/index.js';
import {
  captureDicerActivity,
  type DicerActivityTracker,
} from '../fixtures/dicer-activity.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';
import { startMultipartServer } from '../fixtures/start-multipart-server.js';

const BOUNDARY = 'FETCH-BOUNDARY';
const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

function buildThreePartEnvelope(): Buffer {
  return buildMultipartBody({
    boundary: BOUNDARY,
    parts: [
      {
        headers: { 'Content-Type': 'application/json', 'Content-ID': '<meta>' },
        body: '{"hello":"world"}',
      },
      {
        headers: { 'Content-Type': 'text/plain', 'Content-ID': '<plain>' },
        body: 'second part body',
      },
      {
        headers: { 'Content-Type': 'application/octet-stream' },
        body: 'third part body',
      },
    ],
  });
}

describe('fetchAndHandleMultipart — orchestration (T-006 / T-007 / T-008)', () => {
  let tracker: DicerActivityTracker;

  beforeEach(() => {
    tracker = captureDicerActivity();
  });

  afterEach(() => {
    tracker.restore();
  });

  it('T-006: parser keeps only the <meta> part; other bodies drained; harness clean', async () => {
    const body = buildThreePartEnvelope();
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const result = await fetchAndHandleMultipart<string>(server.url, {
        ...TIMEOUTS,
        parser: async (part) => {
          if (part.contentId === '<meta>') {
            return await streamToString(part.body);
          }
          return undefined;
        },
      });

      expect(result.parts).toHaveLength(1);
      expect(result.parts[0]).toBe('{"hello":"world"}');
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(result.status).toBe(200);

      // Listener-leak harness: every part stream was destroyed (drain-on-
      // finally), and the dicer instance has zero 'part' / 'finish'
      // listeners but its 'error' listener is still attached (FR-011).
      const dicers = tracker.dicerInstances();
      expect(dicers.length).toBeGreaterThanOrEqual(1);
      for (const dicer of dicers) {
        expect(dicer.listenerCount('part')).toBe(0);
        expect(dicer.listenerCount('finish')).toBe(0);
        expect(dicer.listenerCount('error')).toBeGreaterThanOrEqual(1);
      }
      for (const partStream of tracker.partStreams()) {
        expect(partStream.destroyed).toBe(true);
      }
    } finally {
      await server.close();
    }
  });

  it('T-007: parser always returning undefined yields parts.length === 0 and bytes > 0', async () => {
    const body = buildThreePartEnvelope();
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const result = await fetchAndHandleMultipart<string>(server.url, {
        ...TIMEOUTS,
        parser: async () => undefined,
      });

      expect(result.parts).toHaveLength(0);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    } finally {
      await server.close();
    }
  });

  it('T-008: parser throwing on part 2 surfaces the parser error; full cleanup runs', async () => {
    const body = buildThreePartEnvelope();
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      let seen = 0;
      const op = fetchAndHandleMultipart<string>(server.url, {
        ...TIMEOUTS,
        parser: async (part: StreamingMultipartPart) => {
          seen += 1;
          // Drain the body so dicer can advance to the next part on
          // every iteration but the throwing one.
          if (seen === 2) {
            throw new Error('boom');
          }
          return await streamToString(part.body);
        },
      });

      await expect(op).rejects.toThrow(/boom/);
      // FR-010 cleanup ran: source destroyed, listeners cleaned, parts drained.
      const dicers = tracker.dicerInstances();
      expect(dicers.length).toBeGreaterThanOrEqual(1);
      for (const dicer of dicers) {
        expect(dicer.listenerCount('part')).toBe(0);
        expect(dicer.listenerCount('finish')).toBe(0);
        expect(dicer.listenerCount('error')).toBeGreaterThanOrEqual(1);
      }
      for (const partStream of tracker.partStreams()) {
        expect(partStream.destroyed).toBe(true);
      }
    } finally {
      await server.close();
    }
  });
});

describe('fetchAndHandleMultipart — onProgress completion tick (T-014 full)', () => {
  it('fires onProgress >= once per yielded part PLUS once at completion with final bytes', async () => {
    const body = buildThreePartEnvelope();
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const calls: ProgressSnapshot[] = [];
      const onProgress = vi.fn((snap: ProgressSnapshot) => {
        calls.push(snap);
      });
      const result = await fetchAndHandleMultipart<string>(server.url, {
        ...TIMEOUTS,
        onProgress,
        parser: async (part) => streamToString(part.body),
      });

      // 3 per-part calls + 1 completion-tick call (T-014 full).
      expect(calls.length).toBeGreaterThanOrEqual(4);
      // Bytes monotonic non-decreasing.
      let prev = -1;
      for (const snap of calls) {
        expect(snap.bytes).toBeGreaterThanOrEqual(prev);
        prev = snap.bytes;
      }
      // Final call's bytes match the result struct's bytes.
      const last = calls.at(-1)!;
      expect(last.bytes).toBe(result.bytes);
      expect(last.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(last.rateBps)).toBe(true);
      expect(last.rateBps).toBeGreaterThanOrEqual(0);
    } finally {
      await server.close();
    }
  });

  it('completion-tick rateBps is finite even when elapsed is 0 (defensive)', async () => {
    // Synthetic-fast envelope: completion-tick path's rateBps assertion
    // must still hold when wallclock is 0 (Math.round(0/0) is NaN — the
    // implementation uses Math.max(1, elapsedMs/1000)? Actually we use
    // `elapsedMs <= 0 ? 0 : Math.round(...)`).
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [{ headers: { 'Content-Type': 'text/plain' }, body: 'tiny' }],
    });
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const calls: ProgressSnapshot[] = [];
      await fetchAndHandleMultipart(server.url, {
        ...TIMEOUTS,
        onProgress: (snap) => calls.push(snap),
        parser: async (part) => streamToString(part.body),
      });
      for (const snap of calls) {
        expect(Number.isFinite(snap.rateBps)).toBe(true);
        expect(snap.rateBps).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await server.close();
    }
  });
});

describe('fetchAndHandleMultipart — logger contract (T-019 / T-020)', () => {
  it('T-019: caller-supplied event-style logger receives the completion-tick onProgress-throw event', async () => {
    const body = buildThreePartEnvelope();
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const events: Array<{
        level: 'warn';
        msg: string;
        meta?: unknown;
      }> = [];
      const logger = vi.fn(
        (event: { level: 'warn'; msg: string; meta?: unknown }) => {
          events.push(event);
        },
      );
      // onProgress is called per-part (Layer A site) AND once at
      // completion (Layer B site). Throw ONLY at completion to isolate
      // the Layer B catch site.
      let calls = 0;
      const onProgress = vi.fn(() => {
        calls += 1;
        // 3 parts + completion = 4. Throw on the 4th.
        if (calls === 4) {
          throw new Error('completion sink died');
        }
      });

      await fetchAndHandleMultipart(server.url, {
        ...TIMEOUTS,
        logger,
        onProgress,
        parser: async (part) => {
          await streamToString(part.body);
          return undefined;
        },
      });

      // Logger was called as a FUNCTION (event-style), not as a
      // method-bag .warn(...).
      expect(logger).toHaveBeenCalled();
      const completionEvents = events.filter((e) =>
        e.msg.includes('onProgress threw on completion tick'),
      );
      expect(completionEvents.length).toBeGreaterThanOrEqual(1);
      const event = completionEvents[0]!;
      expect(event.level).toBe('warn');
      expect(event.meta).toBeDefined();
      const meta = event.meta as {
        errSummary: { name: string; message: string };
      };
      expect(meta.errSummary.name).toBe('Error');
      // Messages are JSON-stringified per NFR-DR-S-006.
      expect(meta.errSummary.message).toBe('"completion sink died"');
    } finally {
      await server.close();
    }
  });

  it('T-020: default console.warn fallback when logger omitted', async () => {
    const body = buildThreePartEnvelope();
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {
        // suppress real console output
      });
      try {
        let calls = 0;
        await fetchAndHandleMultipart(server.url, {
          ...TIMEOUTS,
          // logger omitted → defaultLogger fallback → console.warn
          onProgress: () => {
            calls += 1;
            if (calls === 4) throw new Error('completion sink died');
          },
          parser: async () => undefined,
        });
        expect(consoleSpy).toHaveBeenCalled();
        // Find the completion-tick call.
        const completionCalls = consoleSpy.mock.calls.filter((args) => {
          const msg: unknown = args[0];
          return (
            typeof msg === 'string' &&
            msg.includes('onProgress threw on completion tick')
          );
        });
        expect(completionCalls.length).toBeGreaterThanOrEqual(1);
        // FR-018: console.warn fallback uses POSITIONAL (msg, meta), NOT
        // event-style payload. Assert the second arg is a plain object,
        // not the event itself.
        const firstCall = completionCalls[0]!;
        const msg: unknown = firstCall[0];
        const meta: unknown = firstCall[1];
        expect(typeof msg).toBe('string');
        expect(meta).toBeDefined();
        expect(meta).toHaveProperty('errSummary');
      } finally {
        consoleSpy.mockRestore();
      }
    } finally {
      await server.close();
    }
  });
});

describe('fetchAndHandleMultipart — input validation (FR-005 / FR-006)', () => {
  it('rejects synchronously with TypeError when options.parser is missing', async () => {
    // Cast to launder past the static `parser: PartParser<T>` requirement
    // — the runtime guard catches consumers who bypass the type system.
    const opts = {
      idleTimeoutMs: 1000,
      totalTimeoutMs: 5000,
      // parser deliberately omitted
    } as unknown as Parameters<typeof fetchAndHandleMultipart>[1];
    await expect(
      fetchAndHandleMultipart('http://127.0.0.1:1/', opts),
    ).rejects.toThrow(TypeError);
    await expect(
      fetchAndHandleMultipart('http://127.0.0.1:1/', opts),
    ).rejects.toThrow(/options\.parser is required/);
  });

  it('rejects when options.parser is non-function (e.g. accidentally passed an object)', async () => {
    const opts = {
      idleTimeoutMs: 1000,
      totalTimeoutMs: 5000,
      parser: {} as unknown,
    } as unknown as Parameters<typeof fetchAndHandleMultipart>[1];
    await expect(
      fetchAndHandleMultipart('http://127.0.0.1:1/', opts),
    ).rejects.toThrow(/options\.parser is required/);
  });

  it('rejects synchronously when idleTimeoutMs is missing (FR-006 surfaces from validatePositiveTimeout)', async () => {
    const opts = {
      totalTimeoutMs: 5000,
      parser: async () => undefined,
    } as unknown as Parameters<typeof fetchAndHandleMultipart>[1];
    await expect(
      fetchAndHandleMultipart('http://127.0.0.1:1/', opts),
    ).rejects.toThrow(/idleTimeoutMs/);
  });
});

describe('fetchAndHandleMultipart — cap-forwarding (FR-DR-A-026)', () => {
  // These tests assert the forwarding path: passing a cap value reaches
  // `parseMultipartRelated` without throwing, and a well-formed envelope
  // still parses successfully (because no cap is tripped). The trip-time
  // behavior is asserted by `fetch-resource-caps.test.ts`.
  it('forwards maxPartBytes, maxParts, maxHeadersPerPart, maxHeaderBytesPerPart to Layer A', async () => {
    const body = buildThreePartEnvelope();
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const result = await fetchAndHandleMultipart<string>(server.url, {
        ...TIMEOUTS,
        // Set every cap to a high value so a well-formed 3-part envelope
        // still passes — this exercises the conditional-spread branches
        // in fetch-and-handle-multipart.ts.
        maxPartBytes: 1_000_000,
        maxParts: 100,
        maxHeadersPerPart: 50,
        maxHeaderBytesPerPart: 8192,
        parser: async (part) => streamToString(part.body),
      });
      expect(result.parts).toHaveLength(3);
    } finally {
      await server.close();
    }
  });
});

describe('fetchAndHandleMultipart — FR-017 silent-catch replacement (T-031..T-033)', () => {
  it('T-031..T-033: per-part onProgress throw routes through Layer A logger; parsing continues', async () => {
    // The Layer A onProgress catch site is exercised here through Layer
    // B (the wrapper forwards the same logger). This is the integration
    // mirror of the parse-progress.test.ts 'onProgress callback throwing
    // does NOT derail parsing' assertion.
    const body = buildThreePartEnvelope();
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const events: Array<{
        level: 'warn';
        msg: string;
        meta?: unknown;
      }> = [];
      const logger = vi.fn(
        (event: { level: 'warn'; msg: string; meta?: unknown }) => {
          events.push(event);
        },
      );
      // Throw on EVERY onProgress call. The Layer-A site at fireProgress
      // should catch and route through `logger`, AND the Layer-B
      // completion-tick site should ALSO catch and route through `logger`.
      const result = await fetchAndHandleMultipart<string>(server.url, {
        ...TIMEOUTS,
        logger,
        onProgress: () => {
          throw new Error('progress sink died');
        },
        parser: async (part) => streamToString(part.body),
      });

      // Parsing continued (parts collected) — proves the logger.warn
      // path doesn't derail.
      expect(result.parts).toHaveLength(3);
      expect(events.length).toBeGreaterThanOrEqual(3);
      // At least one event should match the per-part site message.
      const perPart = events.filter((e) =>
        e.msg.includes('onProgress threw'),
      );
      expect(perPart.length).toBeGreaterThanOrEqual(3);
      for (const event of perPart) {
        expect(event.level).toBe('warn');
        const meta = event.meta as {
          errSummary: { name: string; message: string };
        };
        expect(meta.errSummary.name).toBe('Error');
        // Messages are JSON-stringified per NFR-DR-S-006.
        expect(meta.errSummary.message).toBe('"progress sink died"');
      }
    } finally {
      await server.close();
    }
  });
});
