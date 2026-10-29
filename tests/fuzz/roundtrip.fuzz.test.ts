/**
 * Round-trip / consistency properties for parseMultipartRelated and
 * fetchAndHandleMultipart. See fuzz-helpers.ts for the generators.
 */

import { Readable } from 'node:stream';

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAndHandleMultipart,
  MultipartHeadersTooLargeError,
  MultipartPartTooLargeError,
  MultipartTooManyPartsError,
  MultipartTruncatedError,
  parseMultipartRelated,
  streamToBuffer,
} from '../../src/index.js';
import {
  activeTimeouts,
  applyMutations,
  boundaryParam,
  chunkedReadable,
  chunkedWebStream,
  chunkPlanArb,
  collectParse,
  comparable,
  DEFAULT_TIMEOUTS,
  describeError,
  envelopeArb,
  expectedHeaders,
  FUZZ_RUNS,
  type GenEnvelope,
  mutationArb,
  type Outcome,
  type PartRecord,
  recordPart,
  serialize,
  serializeHeaders,
  settleTwice,
  splitChunks,
  testTimeout,
  withDeadline,
} from './fuzz-helpers.js';

const params = { numRuns: FUZZ_RUNS } as const;
const quietLogger = (): void => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
});

function parseReadable(
  bytes: Buffer,
  plan: readonly number[],
  boundary: string,
  extra: Record<string, unknown> = {},
): Promise<Outcome> {
  return collectParse(chunkedReadable(splitChunks(bytes, plan)), {
    ...DEFAULT_TIMEOUTS,
    logger: quietLogger,
    boundary,
    ...extra,
  });
}

function expectRoundTrip(env: GenEnvelope, outcome: Outcome): void {
  expect(outcome.hung ?? false).toBe(false);
  expect(outcome.error).toBeUndefined();
  expect(outcome.parts).toHaveLength(env.parts.length);
  env.parts.forEach((p, i) => {
    const got = outcome.parts[i]!;
    const want = expectedHeaders(p.headers);
    expect(got.index).toBe(i);
    expect(got.body).toBe(p.body.toString('hex'));
    expect(got.headers).toEqual({ ...want });
    expect(got.rawHeaders).toBe(
      Buffer.concat([serializeHeaders(p.headers), Buffer.from('\r\n')]).toString('hex'),
    );
    expect(got.contentType).toBe(want['content-type'] ?? '');
    expect(got.contentId).toBe(want['content-id']);
    // Documented: a non-negative decimal integer, else undefined.
    const rawLength = want['content-length']?.trim();
    const cl = rawLength !== undefined && /^\d+$/.test(rawLength) ? Number(rawLength) : NaN;
    expect(got.contentLength).toBe(Number.isSafeInteger(cl) ? cl : undefined);
  });
}

describe('fuzz: round-trip', () => {
  it(
    'parsed parts equal the serialized originals for any chunking (Readable input)',
    async () => {
      await fc.assert(
        fc.asyncProperty(envelopeArb, chunkPlanArb, async (env, plan) => {
          const { bytes } = serialize(env);
          expectRoundTrip(env, await parseReadable(bytes, plan, env.boundary));
        }),
        params,
      );
    },
    testTimeout(20),
  );

  it(
    'parsed parts equal the originals when fed as a Response (Content-Type boundary)',
    async () => {
      await fc.assert(
        fc.asyncProperty(envelopeArb, chunkPlanArb, fc.boolean(), async (env, plan, forceQuote) => {
          const { bytes } = serialize(env);
          const { stream } = chunkedWebStream(splitChunks(bytes, plan));
          const res = new Response(stream, {
            headers: {
              'content-type': `multipart/related; type="text/plain"; boundary=${boundaryParam(env.boundary, forceQuote)}`,
            },
          });
          expectRoundTrip(
            env,
            await collectParse(res, { ...DEFAULT_TIMEOUTS, logger: quietLogger }),
          );
        }),
        params,
      );
    },
    testTimeout(20),
  );
});

describe('fuzz: RFC 2046 transport padding', () => {
  it(
    'linear whitespace after a delimiter (transport-padding) does not change the parse',
    async () => {
      const lwsp = fc.string({ unit: fc.constantFrom(' ', '\t'), minLength: 1, maxLength: 4 });
      await fc.assert(
        fc.asyncProperty(
          envelopeArb.filter((e) => e.closingCrlf || e.epilogue.length > 0),
          fc.array(lwsp, { minLength: 7, maxLength: 7 }),
          chunkPlanArb,
          async (env, padding, plan) => {
            const { bytes } = serialize(env, padding);
            expectRoundTrip(env, await parseReadable(bytes, plan, env.boundary));
          },
        ),
        params,
      );
    },
    testTimeout(20),
  );
});

describe('fuzz: chunk-split invariance', () => {
  it(
    'outcome (parts + error) does not depend on chunking, even for mutated/hostile envelopes',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          envelopeArb,
          fc.array(mutationArb, { maxLength: 3 }),
          chunkPlanArb,
          chunkPlanArb,
          async (env, muts, planA, planB) => {
            const bytes = applyMutations(serialize(env).bytes, muts);
            const a = await parseReadable(bytes, planA, env.boundary);
            const b = await parseReadable(bytes, planB, env.boundary);
            expect(a.hung ?? false).toBe(false);
            expect(comparable(b)).toEqual(comparable(a));
          },
        ),
        params,
      );
    },
    testTimeout(30),
  );
});

describe('fuzz: parseMultipartRelated vs fetchAndHandleMultipart', () => {
  it(
    'agree on parts (success) or on error class + message (failure) for the same bytes',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          envelopeArb,
          fc.array(mutationArb, { maxLength: 2 }),
          chunkPlanArb,
          async (env, muts, plan) => {
            const bytes = applyMutations(serialize(env).bytes, muts);
            const ct = `multipart/related; boundary=${boundaryParam(env.boundary)}`;
            const direct = await parseReadable(bytes, plan, env.boundary);

            vi.stubGlobal(
              'fetch',
              async () =>
                new Response(chunkedWebStream(splitChunks(bytes, plan)).stream, {
                  status: 207,
                  headers: { 'content-type': ct },
                }),
            );
            const viaFetch = await withDeadline(
              fetchAndHandleMultipart<PartRecord>('http://fuzz.invalid/', {
                ...DEFAULT_TIMEOUTS,
                logger: quietLogger,
                parser: async (part) => recordPart(part, await streamToBuffer(part.body)),
              }).then(
                (r) => ({
                  ok: true as const,
                  parts: [...r.parts],
                  status: r.status,
                  bytes: r.bytes,
                }),
                (err: unknown) => ({ ok: false as const, error: describeError(err) }),
              ),
              5_000,
            );
            expect(direct.hung ?? false).toBe(false);
            expect(viaFetch.hung).toBe(false);
            if (viaFetch.hung) return;
            const f = viaFetch.value;
            if (direct.error === undefined) {
              // MultipartFetchResult.bytes = "Total bytes pulled from the source stream".
              expect(f).toEqual({
                ok: true,
                parts: direct.parts,
                status: 207,
                bytes: bytes.length,
              });
            } else {
              expect(f).toEqual({ ok: false, error: direct.error });
            }
          },
        ),
        params,
      );
    },
    testTimeout(30),
  );
});

type LimitKey = 'maxPartBytes' | 'maxParts' | 'maxHeadersPerPart' | 'maxHeaderBytesPerPart';

/** Actual per-envelope measure for each cap, per the documented semantics. */
function measures(env: GenEnvelope): Record<LimitKey, number[]> {
  return {
    maxPartBytes: env.parts.map((p) => p.body.length),
    maxParts: env.parts.map((_, i) => i + 1),
    maxHeadersPerPart: env.parts.map((p) => p.headers.length),
    maxHeaderBytesPerPart: env.parts.map((p) => serializeHeaders(p.headers).length + 2),
  };
}

const ERROR_FOR: Record<LimitKey, string> = {
  maxPartBytes: 'MultipartPartTooLargeError',
  maxParts: 'MultipartTooManyPartsError',
  maxHeadersPerPart: 'MultipartHeadersTooLargeError',
  maxHeaderBytesPerPart: 'MultipartHeadersTooLargeError',
};

describe('fuzz: resource caps', () => {
  const keyArb = fc.constantFrom<LimitKey>(
    'maxPartBytes',
    'maxParts',
    'maxHeadersPerPart',
    'maxHeaderBytesPerPart',
  );

  it(
    'raising a cap never loses data: success under L implies identical success under 2L',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          envelopeArb,
          keyArb,
          fc.integer({ min: 1, max: 400 }),
          chunkPlanArb,
          async (env, key, L, plan) => {
            const { bytes } = serialize(env);
            const atL = await parseReadable(bytes, plan, env.boundary, { [key]: L });
            const at2L = await parseReadable(bytes, plan, env.boundary, { [key]: 2 * L });
            if (atL.error === undefined && !(atL.hung ?? false)) {
              expect(comparable(at2L)).toEqual(comparable(atL));
            }
          },
        ),
        params,
      );
    },
    testTimeout(30),
  );

  it(
    'caps are exact: the typed cap error fires iff some measure exceeds L, at the first offending part',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          envelopeArb,
          keyArb,
          fc.integer({ min: 1, max: 400 }),
          chunkPlanArb,
          async (env, key, L, plan) => {
            const { bytes } = serialize(env);
            const out = await parseReadable(bytes, plan, env.boundary, { [key]: L });
            expect(out.hung ?? false).toBe(false);
            const firstBad = measures(env)[key].findIndex((m) => m > L);
            if (firstBad < 0) {
              expectRoundTrip(env, out);
              return;
            }
            expect(out.error?.name).toBe(ERROR_FOR[key]);
            const err = out.errorObj;
            if (key === 'maxParts') {
              expect(err).toBeInstanceOf(MultipartTooManyPartsError);
              expect((err as MultipartTooManyPartsError).observed).toBe(L + 1);
            } else if (key === 'maxPartBytes') {
              expect(err).toBeInstanceOf(MultipartPartTooLargeError);
              expect((err as MultipartPartTooLargeError).partIndex).toBe(firstBad);
            } else {
              expect(err).toBeInstanceOf(MultipartHeadersTooLargeError);
              const e = err as MultipartHeadersTooLargeError;
              expect(e.partIndex).toBe(firstBad);
              expect(e.limit).toBe(key === 'maxHeadersPerPart' ? 'count' : 'bytes');
              if (key === 'maxHeadersPerPart') {
                expect(e.observed).toBe(measures(env)[key][firstBad]);
              } else {
                // The byte cap trips while the block accumulates, so
                // `observed` is the bytes held at that moment: past the cap,
                // at most the whole block.
                expect(e.observed).toBeGreaterThan(L);
                expect(e.observed).toBeLessThanOrEqual(measures(env)[key][firstBad]!);
              }
            }
            // Parts before the offending one are delivered intact.
            for (let i = 0; i < firstBad; i++) {
              expect(out.parts[i]?.body).toBe(env.parts[i]?.body.toString('hex'));
            }
          },
        ),
        params,
      );
    },
    testTimeout(20),
  );
});

describe('fuzz: caps above the internal header ceiling', () => {
  it(
    'a header block within a caller-raised maxHeaderBytesPerPart / maxHeadersPerPart parses (or fails with the typed cap error)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1_000, max: 120_000 }),
          fc.integer({ min: 1, max: 3_000 }),
          fc.constantFrom('bytes' as const, 'count' as const),
          async (valueLen, count, which) => {
            const headers: Array<readonly [string, string]> =
              which === 'bytes'
                ? [['X-Big', 'v'.repeat(valueLen)]]
                : Array.from({ length: count }, (_, i) => [`H${String(i)}`, 'v'] as const);
            const env: GenEnvelope = {
              boundary: 'cap',
              parts: [{ headers, body: Buffer.from('ok') }],
              preamble: Buffer.alloc(0),
              epilogue: Buffer.alloc(0),
              closingCrlf: true,
            };
            const rawLen = serializeHeaders(headers).length + 2;
            const caps =
              which === 'bytes'
                ? { maxHeaderBytesPerPart: rawLen }
                : { maxHeadersPerPart: count, maxHeaderBytesPerPart: rawLen };
            const out = await parseReadable(serialize(env).bytes, [65_536], 'cap', caps);
            expectRoundTrip(env, out);
          },
        ),
        { ...params, numRuns: Math.max(10, Math.floor(FUZZ_RUNS / 10)) },
      );
    },
    testTimeout(50),
  );
});

describe('fuzz: truncation', () => {
  it(
    'a body cut before the closing delimiter always rejects with MultipartTruncatedError (FR-022)',
    async () => {
      await fc.assert(
        fc.asyncProperty(envelopeArb, fc.nat(), chunkPlanArb, async (env, cutSeed, plan) => {
          const { bytes, closeEnd } = serialize(env);
          const cut = cutSeed % closeEnd; // strictly before the end of `--boundary--`
          const out = await parseReadable(bytes.subarray(0, cut), plan, env.boundary);
          expect(out.hung ?? false).toBe(false);
          // Never silently short: it must reject…
          expect(out.error).toBeDefined();
          // …and every yielded body is a prefix of the original (plus, at EOF,
          // possibly the held-back start of the delimiter it was cut inside).
          out.parts.forEach((p, i) => {
            const orig = env.parts[i]?.body ?? Buffer.alloc(0);
            const withDelim = Buffer.concat([orig, Buffer.from(`\r\n--${env.boundary}`)]).toString(
              'hex',
            );
            expect(withDelim.startsWith(p.body)).toBe(true);
          });
          // …with the documented class and byte count.
          expect(out.error?.name).toBe('MultipartTruncatedError');
          expect(out.errorObj).toBeInstanceOf(MultipartTruncatedError);
          expect((out.errorObj as MultipartTruncatedError).bytesReceived).toBe(cut);
        }),
        params,
      );
    },
    testTimeout(20),
  );

  it(
    'a stream that stalls (no EOF) at any byte rejects with MultipartIdleTimeoutError instead of hanging',
    async () => {
      await fc.assert(
        fc.asyncProperty(envelopeArb, fc.nat(), async (env, cutSeed) => {
          const { bytes, closeEnd } = serialize(env);
          const cut = cutSeed % closeEnd;
          const src = chunkedReadable(
            [bytes.subarray(0, cut)].filter((b) => b.length > 0),
            { end: false },
          );
          const opts = {
            idleTimeoutMs: 15,
            totalTimeoutMs: 2_000,
            boundary: env.boundary,
            logger: quietLogger,
          };
          const out = await collectParse(src, opts, 400, 'drain');
          expect(out.hung ?? false).toBe(false);
          expect(out.error?.name).toBe('MultipartIdleTimeoutError');
          expect(src.destroyed).toBe(true);
        }),
        { ...params, numRuns: Math.max(10, Math.floor(FUZZ_RUNS / 4)) },
      );
    },
    testTimeout(600),
  );
});

describe('fuzz: mid-stream failures never hang a draining consumer', () => {
  /** Source that delivers `head`, then (after a tick) runs `after`. */
  function headThen(head: Buffer, after: (r: Readable) => void): Readable {
    let sent = false;
    return new Readable({
      read() {
        if (sent) return;
        sent = true;
        if (head.length > 0) this.push(head);
        setTimeout(() => after(this), 5);
      },
    });
  }

  it(
    'a source error at any byte rejects with that error (network reset mid-body)',
    async () => {
      await fc.assert(
        fc.asyncProperty(envelopeArb, fc.nat(), async (env, cutSeed) => {
          const { bytes, closeEnd } = serialize(env);
          const cut = cutSeed % closeEnd;
          const boom = new Error('ECONNRESET (fuzz)');
          const src = headThen(bytes.subarray(0, cut), (r) => r.destroy(boom));
          const out = await collectParse(
            src,
            { ...DEFAULT_TIMEOUTS, boundary: env.boundary, logger: quietLogger },
            400,
            'drain',
          );
          expect(out.hung ?? false).toBe(false);
          expect(out.errorObj).toBe(boom);
        }),
        { ...params, numRuns: Math.max(10, Math.floor(FUZZ_RUNS / 4)) },
      );
    },
    testTimeout(600),
  );

  it(
    'a caller abort at any byte rejects with MultipartAbortError carrying the reason',
    async () => {
      await fc.assert(
        fc.asyncProperty(envelopeArb, fc.nat(), fc.anything(), async (env, cutSeed, reason) => {
          const { bytes, closeEnd } = serialize(env);
          const cut = cutSeed % closeEnd;
          const ctrl = new AbortController();
          const src = headThen(bytes.subarray(0, cut), () => ctrl.abort(reason));
          const out = await collectParse(
            src,
            {
              ...DEFAULT_TIMEOUTS,
              boundary: env.boundary,
              logger: quietLogger,
              signal: ctrl.signal,
            },
            400,
            'drain',
          );
          expect(out.hung ?? false).toBe(false);
          expect(out.error?.name).toBe('MultipartAbortError');
          expect((out.errorObj as { reason?: unknown }).reason).toBe(ctrl.signal.reason);
          expect(src.destroyed).toBe(true);
        }),
        { ...params, numRuns: Math.max(10, Math.floor(FUZZ_RUNS / 4)) },
      );
    },
    testTimeout(600),
  );
});

describe('fuzz: early break', () => {
  it(
    'breaking out after k parts destroys the source, every yielded body, and leaves no timers',
    async () => {
      const nonEmpty = envelopeArb.filter((e) => e.parts.length > 0);
      await fc.assert(
        fc.asyncProperty(
          nonEmpty,
          fc.nat(),
          fc.boolean(),
          chunkPlanArb,
          async (env, kSeed, drain, plan) => {
            const { bytes } = serialize(env);
            const k = kSeed % env.parts.length;
            await settleTwice();
            const timersBefore = activeTimeouts();
            const src = chunkedReadable(splitChunks(bytes, plan));
            const bodies: Readable[] = [];
            const logged: unknown[] = [];
            const run = (async () => {
              let i = 0;
              for await (const part of parseMultipartRelated(src, {
                idleTimeoutMs: 60_000,
                totalTimeoutMs: 120_000,
                boundary: env.boundary,
                logger: (e) => logged.push(e),
              })) {
                bodies.push(part.body);
                if (i === k) {
                  if (drain) await streamToBuffer(part.body);
                  break;
                }
                await streamToBuffer(part.body);
                i++;
              }
            })();
            const r = await withDeadline(run, 5_000);
            expect(r.hung).toBe(false);
            await settleTwice();
            expect(src.destroyed).toBe(true);
            for (const b of bodies) expect(b.destroyed || b.readableEnded).toBe(true);
            expect(activeTimeouts()).toBeLessThanOrEqual(timersBefore);
          },
        ),
        params,
      );
    },
    testTimeout(20),
  );
});
