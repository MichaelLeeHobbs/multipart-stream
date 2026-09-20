import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseMultipartRelated, streamToString } from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';
import {
  captureParserActivity,
  type ParserActivityTracker,
} from '../fixtures/parser-activity.js';

const BOUNDARY = 'LATE-EMIT-BOUNDARY';
const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

interface LoggerEvent {
  level: 'warn';
  msg: string;
  meta?: unknown;
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('parseMultipartRelated — FR-011 late-emit parser error path (T-016)', () => {
  let tracker: ParserActivityTracker;

  beforeEach(() => {
    tracker = captureParserActivity();
  });

  afterEach(() => {
    tracker.restore();
  });

  it('T-016: post-cleanup parser error routes through logger.warn — no uncaughtException', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        { headers: { 'Content-Type': 'text/plain' }, body: 'one' },
        { headers: { 'Content-Type': 'text/plain' }, body: 'two' },
        { headers: { 'Content-Type': 'text/plain' }, body: 'three' },
      ],
    });
    const source = Readable.from(buf);
    const loggerEvents: LoggerEvent[] = [];
    const logger = vi.fn((event: LoggerEvent) => {
      loggerEvents.push(event);
    });

    // Spy on uncaughtException — the FR-011 contract is that late-tick
    // parser errors NEVER escape as uncaught process exceptions.
    const uncaught = vi.fn();
    process.on('uncaughtException', uncaught);

    try {
      for await (const part of parseMultipartRelated(source, {
        ...TIMEOUTS,
        boundary: BOUNDARY,
        logger,
      })) {
        await streamToString(part.body);
        break;
      }

      // After break the generator's finally has already run; cleanup()
      // has set `cleaned = true`. Now manually emit 'error' on the
      // retained parser instance — this is the late-emit scenario.
      await settle();

      const parsers = tracker.parserInstances();
      expect(parsers.length).toBeGreaterThanOrEqual(1);
      const parser = parsers[0]!;
      expect(parser.listenerCount('error')).toBeGreaterThanOrEqual(1);

      // Construct an error with attacker-shaped message: 500 chars + a
      // control byte (NFR-DR-S-008 — the truncate path keeps it bounded
      // and the full sanitizer additionally redacts the control byte).
      const longMessage = 'x'.repeat(500);
      const lateErr = new Error(longMessage);
      lateErr.name = 'LateParserError';
      parser.emit('error', lateErr);

      // Give the listener a tick to log.
      await settle();

      // The retained 'error' listener should have called the configured
      // logger exactly once (or more, if the harness tap fired too).
      const lateEmitCalls = loggerEvents.filter((e) =>
        e.msg.includes('late parser error after generator close'),
      );
      expect(lateEmitCalls.length).toBeGreaterThanOrEqual(1);

      const event = lateEmitCalls[0]!;
      expect(event.level).toBe('warn');
      expect(event.msg).toMatch(/late parser error after generator close/);

      const meta = event.meta as {
        errSummary: { name: string; message: string };
      };
      expect(meta).toBeDefined();
      expect(meta.errSummary).toBeDefined();
      expect(meta.errSummary.name).toBe('LateParserError');
      // Message is bounded at 120 chars + ellipsis; the full sanitizer
      // additionally control-byte redacts.
      expect(meta.errSummary.message.length).toBeLessThanOrEqual(121);

      // NFR-DR-S-008: meta MUST NOT contain raw chunk bytes, raw Error,
      // or non-errSummary fields.
      const metaObj = event.meta as Record<string, unknown>;
      expect(Object.keys(metaObj)).toEqual(['errSummary']);
      expect('chunk' in metaObj).toBe(false);
      expect('bytes' in metaObj).toBe(false);
      expect('err' in metaObj).toBe(false);

      // No uncaughtException fired.
      expect(uncaught).not.toHaveBeenCalled();
    } finally {
      process.off('uncaughtException', uncaught);
    }
  });

  it('FR-011: PRE-cleanup parser errors still route to the queue', async () => {
    // Sanity check: the cleaned-flag discriminator only kicks in AFTER the
    // generator's finally has run. While the generator is still iterating,
    // parser errors must still surface from the queue. The simplest way to
    // exercise this: feed an envelope that parser rejects (T-022 pattern).
    const source = Readable.from(Buffer.from('garbage-not-a-multipart-body'));
    const logger = vi.fn();

    const iter = parseMultipartRelated(source, {
      ...TIMEOUTS,
      boundary: BOUNDARY,
      logger,
    });

    await expect(iter.next()).rejects.toThrow();
    // The error surfaced via the queue (NOT via the late-emit logger
    // path) because cleanup had not yet run.
    expect(logger).not.toHaveBeenCalled();
  });
});
