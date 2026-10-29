/* eslint-disable max-params -- fast-check passes one parameter per generated input */
/**
 * "Every termination path settles." For a random well-framed envelope,
 * random chunking and ONE random termination event injected at a random
 * byte offset (idle stall, total timeout, caller abort, source error,
 * source destroy without error, truncation, cap overflow, consumer break,
 * consumer / parser-callback throw), across three wirings (Node Readable
 * into parseMultipartRelated, Web Response into parseMultipartRelated, and
 * fetchAndHandleMultipart over a stubbed fetch), assert that:
 *
 *   - the iterator / returned promise settles;
 *   - every body the consumer awaits settles: it resolves with the exact
 *     bytes when its delimiter arrived before the event, and otherwise it
 *     may only reject with the SAME error instance the operation rejects
 *     with;
 *   - no timer, source listener (other than the retained 'error' one) or
 *     caller-signal listener remains;
 *   - nothing escapes as an uncaught exception / unhandled rejection.
 */

import { getEventListeners } from 'node:events';
import { Readable } from 'node:stream';

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAndHandleMultipart,
  MultipartAbortError,
  type ParseMultipartOptions,
  parseMultipartRelated,
  type StreamingMultipartPart,
  streamToBuffer,
} from '../../src/index.js';
import {
  activeTimeouts,
  boundaryParam,
  chunkPlanArb,
  envelopeArb,
  FUZZ_RUNS,
  type GenEnvelope,
  serialize,
  settleTwice,
  splitChunks,
  testTimeout,
  TYPED_ERROR_NAMES,
  withDeadline,
} from './fuzz-helpers.js';

const CRLF = Buffer.from('\r\n');
const quietLogger = (): void => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
});

type ByteEvent = 'stall' | 'total' | 'abort' | 'sourceError' | 'sourceDestroy' | 'truncate';

type TermEvent =
  | { readonly kind: 'none' }
  | { readonly kind: ByteEvent; readonly at: number }
  | { readonly kind: 'maxPartBytes'; readonly cap: number }
  | { readonly kind: 'maxParts'; readonly cap: number }
  | { readonly kind: 'break'; readonly afterPart: number }
  | { readonly kind: 'consumerThrow'; readonly onPart: number };

type Wiring = 'readable' | 'response' | 'fetch';
type BodyMode = 'drain' | 'destroy' | 'ignore';

const eventArb: fc.Arbitrary<TermEvent> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ kind: 'none' as const }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constantFrom<ByteEvent>(
        'stall',
        'total',
        'abort',
        'sourceError',
        'sourceDestroy',
        'truncate',
      ),
      // Taken modulo (envelope length + 1) at run time.
      at: fc.nat(),
    }),
  },
  fc.record({ kind: fc.constant('maxPartBytes' as const), cap: fc.integer({ min: 1, max: 200 }) }),
  fc.record({ kind: fc.constant('maxParts' as const), cap: fc.integer({ min: 1, max: 4 }) }),
  fc.record({ kind: fc.constant('break' as const), afterPart: fc.nat({ max: 4 }) }),
  fc.record({ kind: fc.constant('consumerThrow' as const), onPart: fc.nat({ max: 4 }) }),
);

/**
 * Offset (exclusive end) by which part i's closing delimiter is confirmed:
 * `--boundary` CRLF for the next part, `--boundary--` CRLF for the close.
 * Infinity when the close delimiter has no CRLF (confirmed only at EOF).
 */
function confirmedAt(env: GenEnvelope, bytes: Buffer): number[] {
  const needle = Buffer.from(`\r\n--${env.boundary}`);
  const hay = Buffer.concat([CRLF, bytes]);
  const starts: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) starts.push(i);
  const blen = Buffer.byteLength(env.boundary);
  const hasCloseCrlf = env.closingCrlf || env.epilogue.length > 0;
  return env.parts.map((_p, i) => {
    // In `bytes`, the delimiter's `--` begins at starts[j] (the CRLF prefix
    // added 2 bytes and the needle's own CRLF is 2 bytes).
    const start = starts[i + 1] ?? Number.POSITIVE_INFINITY;
    const isClose = i + 1 === env.parts.length;
    if (isClose) return hasCloseCrlf ? start + 2 + blen + 2 + 2 : Number.POSITIVE_INFINITY;
    return start + 2 + blen + 2;
  });
}

interface Injector {
  /** Called when the source reaches offset `at`; returns false to stop delivery. */
  fire(): 'continue' | 'stop' | 'end';
}

function nodeSource(chunks: Buffer[], atChunk: number, inj: Injector | undefined): Readable {
  let i = 0;
  let fired = false;
  let waiting = false;
  const s = new Readable({
    read() {
      if (waiting) return;
      if (inj !== undefined && !fired && i === atChunk) {
        fired = true;
        waiting = true;
        // Deferred, so every earlier chunk has reached the parser.
        setImmediate(() => {
          waiting = false;
          const r = inj.fire();
          if (s.destroyed) return;
          if (r === 'end') s.push(null);
          else if (r === 'continue') pushNext();
        });
        return;
      }
      pushNext();
    },
  });
  const pushNext = (): void => {
    if (i < chunks.length) s.push(chunks[i++]);
    else s.push(null);
  };
  return s;
}

function webSource(
  chunks: Buffer[],
  atChunk: number,
  inj: (ctl: ReadableStreamDefaultController<Uint8Array>) => Injector | undefined,
): ReadableStream<Uint8Array> {
  let i = 0;
  let fired = false;
  let stalled = false;
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      if (stalled) return new Promise<void>(() => undefined);
      const injector = inj(ctl);
      if (injector !== undefined && !fired && i === atChunk) {
        fired = true;
        await new Promise<void>((r) => setImmediate(r));
        const r = injector.fire();
        if (r === 'stop') {
          stalled = true;
          return new Promise<void>(() => undefined);
        }
        if (r === 'end') {
          ctl.close();
          return undefined;
        }
      }
      const c = chunks[i++];
      if (c === undefined) ctl.close();
      else ctl.enqueue(new Uint8Array(c));
      return undefined;
    },
  });
}

interface BodyRecord {
  readonly index: number;
  readonly ok: boolean;
  readonly bytes?: Buffer;
  readonly err?: unknown;
}

interface RunResult {
  readonly hung: boolean;
  readonly ok: boolean;
  readonly err?: unknown;
  readonly bodies: BodyRecord[];
  readonly seen: number;
  readonly source?: Readable;
}

async function runOnce(
  env: GenEnvelope,
  plan: readonly number[],
  event: TermEvent,
  wiring: Wiring,
  bodyModes: readonly BodyMode[],
  sourceErr: Error,
  thrown: Error,
  controller: AbortController,
): Promise<RunResult> {
  const { bytes } = serialize(env);
  const at = 'at' in event ? event.at % (bytes.length + 1) : -1;
  const head = at >= 0 ? splitChunks(bytes.subarray(0, at), plan) : [];
  const tail = at >= 0 ? splitChunks(bytes.subarray(at), plan) : splitChunks(bytes, plan);
  const chunks = [...head, ...tail];
  const atChunk = head.length;

  const timeouts =
    event.kind === 'stall'
      ? { idleTimeoutMs: 15, totalTimeoutMs: 5_000 }
      : event.kind === 'total'
        ? { idleTimeoutMs: 5_000, totalTimeoutMs: 40 }
        : { idleTimeoutMs: 5_000, totalTimeoutMs: 10_000 };
  const caps: Partial<ParseMultipartOptions> =
    event.kind === 'maxPartBytes'
      ? { maxPartBytes: event.cap }
      : event.kind === 'maxParts'
        ? { maxParts: event.cap }
        : {};
  const opts: ParseMultipartOptions = {
    ...timeouts,
    ...caps,
    signal: controller.signal,
    logger: quietLogger,
  };

  const fireFor = (destroy: (err?: Error) => void): Injector => ({
    fire() {
      switch (event.kind) {
        case 'stall':
        case 'total':
          return 'stop';
        case 'abort':
          controller.abort(thrown);
          return 'continue';
        case 'sourceError':
          destroy(sourceErr);
          return 'stop';
        case 'sourceDestroy':
          destroy();
          return 'stop';
        case 'truncate':
          return 'end';
        case 'none':
        case 'maxPartBytes':
        case 'maxParts':
        case 'break':
        case 'consumerThrow':
          return 'continue';
      }
    },
  });

  const bodies: BodyRecord[] = [];
  let seen = 0;
  const readBody = async (part: StreamingMultipartPart): Promise<void> => {
    try {
      bodies.push({ index: part.index, ok: true, bytes: await streamToBuffer(part.body) });
    } catch (err) {
      // Soft-fail: keep going so the operation's own error surfaces next.
      bodies.push({ index: part.index, ok: false, err });
    }
  };
  const onPart = async (part: StreamingMultipartPart): Promise<void> => {
    seen++;
    const mode = bodyModes[part.index % bodyModes.length] ?? 'drain';
    if (mode === 'destroy') part.body.destroy();
    // 'ignore' lets fetchAndHandleMultipart drain; the iterator needs a reader.
    else if (mode === 'drain' || wiring !== 'fetch') await readBody(part);
    if (event.kind === 'consumerThrow' && event.onPart === part.index) throw thrown;
  };
  const consume = async (parts: AsyncIterable<StreamingMultipartPart>): Promise<void> => {
    for await (const part of parts) {
      await onPart(part);
      if (event.kind === 'break' && event.afterPart === part.index) break;
    }
  };

  let source: Readable | undefined;
  const drive = async (): Promise<void> => {
    if (wiring === 'readable') {
      const inj = 'at' in event ? fireFor((e) => source?.destroy(e)) : undefined;
      source = nodeSource(chunks, atChunk, inj);
      await consume(parseMultipartRelated(source, { ...opts, boundary: env.boundary }));
      return;
    }
    const stream = webSource(chunks, atChunk, (ctl) =>
      'at' in event ? fireFor((e) => ctl.error(e ?? new Error('destroyed'))) : undefined,
    );
    const res = new Response(stream, {
      headers: { 'content-type': `multipart/related; boundary=${boundaryParam(env.boundary)}` },
    });
    if (wiring === 'response') {
      await consume(parseMultipartRelated(res, opts));
      return;
    }
    // fetch: a 'break' event cannot be expressed and runs to completion.
    vi.stubGlobal('fetch', async () => res);
    await fetchAndHandleMultipart('http://x.invalid/', {
      ...opts,
      parser: async (part) => {
        await onPart(part);
        return undefined;
      },
    });
  };
  const run = async (): Promise<{ ok: boolean; err?: unknown }> => {
    try {
      await drive();
      return { ok: true };
    } catch (err) {
      return { ok: false, err };
    }
  };

  const r = await withDeadline(run(), 3_000);
  if (r.hung) {
    source?.destroy();
    return { hung: true, ok: false, bodies, seen, ...(source ? { source } : {}) };
  }
  return { hung: false, ...r.value, bodies, seen, ...(source ? { source } : {}) };
}

describe('termination: every termination path settles', () => {
  it(
    'settles iterator and bodies with one error instance, leaving no timers/listeners/uncaught',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          envelopeArb,
          chunkPlanArb,
          eventArb,
          fc.constantFrom<Wiring>('readable', 'response', 'fetch'),
          fc.array(fc.constantFrom<BodyMode>('drain', 'drain', 'destroy', 'ignore'), {
            minLength: 1,
            maxLength: 4,
          }),
          async (env, plan, event, wiring, bodyModes) => {
            const escaped: unknown[] = [];
            const onErr = (e: unknown): void => {
              escaped.push(e);
            };
            process.on('uncaughtException', onErr);
            process.on('unhandledRejection', onErr);
            const baseTimers = activeTimeouts();
            const sourceErr = new Error('source-error');
            const thrown = new Error('caller-thrown');
            const controller = new AbortController();
            let result: RunResult;
            try {
              result = await runOnce(
                env,
                plan,
                event,
                wiring,
                bodyModes,
                sourceErr,
                thrown,
                controller,
              );
              await settleTwice();
              await new Promise((r) => setTimeout(r, 2));
            } finally {
              process.off('uncaughtException', onErr);
              process.off('unhandledRejection', onErr);
            }

            // 1. Settles, nothing escapes.
            expect(result.hung).toBe(false);
            expect(escaped).toEqual([]);

            // 2. Outcome is a documented one for the injected event.
            if (!result.ok) {
              const err = result.err;
              const allowed =
                err === thrown ||
                err === sourceErr ||
                (err instanceof Error && TYPED_ERROR_NAMES.has(err.name)) ||
                // A Web body errored by the source surfaces its own error.
                (wiring !== 'readable' && event.kind === 'sourceDestroy');
              expect(allowed, `unexpected error ${String(err)}`).toBe(true);
              if (err instanceof MultipartAbortError) expect(err.reason).toBe(thrown);
            } else {
              const stopsEarly = event.kind === 'break' || event.kind === 'consumerThrow';
              if (!stopsEarly) expect(result.seen).toBe(env.parts.length);
            }

            // 3. Every awaited body settled; complete bodies resolve exactly;
            //    a rejected body carries the operation's error instance.
            const { bytes } = serialize(env);
            const confirmed = confirmedAt(env, bytes);
            const at = 'at' in event ? event.at % (bytes.length + 1) : -1;
            for (const b of result.bodies) {
              const expected = env.parts[b.index]?.body;
              if (b.ok) {
                expect(b.bytes?.equals(expected ?? Buffer.alloc(0))).toBe(true);
                continue;
              }
              expect(result.ok, `body ${String(b.index)} rejected but operation succeeded`).toBe(
                false,
              );
              expect(b.err, `body ${String(b.index)} error is not the operation error`).toBe(
                result.err,
              );
              if (at >= 0 && event.kind !== 'stall' && event.kind !== 'total') {
                expect(
                  at < (confirmed[b.index] ?? Number.POSITIVE_INFINITY),
                  `complete body ${String(b.index)} rejected`,
                ).toBe(true);
              }
            }

            // 4. No leftovers.
            expect(activeTimeouts()).toBeLessThanOrEqual(baseTimers);
            expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
            const src = result.source;
            if (src !== undefined) {
              for (const ev of ['data', 'end', 'close', 'readable'] as const) {
                expect(src.listenerCount(ev), `source '${ev}' listeners`).toBe(0);
              }
              expect(src.destroyed).toBe(true);
            }
          },
        ),
        { numRuns: FUZZ_RUNS },
      );
    },
    testTimeout(60),
  );
});
