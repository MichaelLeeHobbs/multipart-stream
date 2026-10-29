/* eslint-disable max-params -- fast-check passes one parameter per generated input */
/**
 * Hostile inputs to every public entry point. The contract under test:
 * every call settles (no hang), never raises an uncaught exception or an
 * unhandled rejection, and fails only with a documented error — a typed
 * `Multipart*Error`, a documented `multipart: …` Error/TypeError, or an
 * error thrown by caller code (getters/proxies/callbacks) propagated as-is.
 */

import { Readable } from 'node:stream';

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractBoundary,
  fetchAndHandleMultipart,
  MultipartAbortError,
  parseMultipartRelated,
  streamToBuffer,
  streamToString,
} from '../../src/index.js';
import {
  boundaryParam,
  chunkedReadable,
  chunkedWebStream,
  DEFAULT_TIMEOUTS,
  describeError,
  FUZZ_RUNS,
  rfcBoundary,
  serialize,
  settleTwice,
  testTimeout,
  TYPED_ERROR_NAMES,
  withDeadline,
} from './fuzz-helpers.js';

const params = { numRuns: FUZZ_RUNS } as const;
const quietLogger = (): void => undefined;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Collect uncaught exceptions / unhandled rejections raised while `fn` runs. */
async function trapAsyncErrors<T>(fn: () => Promise<T>): Promise<{ value: T; escaped: unknown[] }> {
  const escaped: unknown[] = [];
  const onErr = (e: unknown): void => {
    escaped.push(e);
  };
  process.on('uncaughtException', onErr);
  process.on('unhandledRejection', onErr);
  try {
    const value = await fn();
    await settleTwice();
    await new Promise((r) => setTimeout(r, 2));
    return { value, escaped };
  } finally {
    process.off('uncaughtException', onErr);
    process.off('unhandledRejection', onErr);
  }
}

/** Sentinel thrown by hostile getters / proxies so we can recognise it. */
class Sentinel extends Error {
  override name = 'Sentinel';
}

// ---------------------------------------------------------------------------
// Hostile value generators
// ---------------------------------------------------------------------------

const MAX_T = 2_147_483_647;

const hostileNumber = fc.oneof(
  fc.constantFrom(
    Number.NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    -1,
    0.5,
    1.5,
    MAX_T,
    MAX_T + 1,
    Number.MAX_SAFE_INTEGER,
    Number.MIN_VALUE,
  ),
  fc.double(),
  fc.integer({ min: -10, max: 10 }),
);
const hostileValue = fc.oneof(
  hostileNumber,
  fc.constantFrom<unknown>(
    null,
    undefined,
    '',
    '100',
    100n,
    true,
    [],
    [100],
    {},
    Symbol('x'),
    () => 100,
    { valueOf: () => 100 },
    new Number(100),
  ),
  fc.string({ maxLength: 8 }),
);
const validTimeout = fc.integer({ min: 1_000, max: MAX_T });
const timeoutArb = fc.oneof(
  { weight: 2, arbitrary: validTimeout },
  { weight: 3, arbitrary: hostileValue },
);

const isValidTimeout = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_T;

type Shape = 'plain' | 'nullProto' | 'proxy' | 'frozen' | 'selfRef' | 'protoGetters' | 'symbolKeys';
const shapeArb = fc.constantFrom<Shape>(
  'plain',
  'nullProto',
  'proxy',
  'frozen',
  'selfRef',
  'protoGetters',
  'symbolKeys',
);

/**
 * Wrap a field map into a hostile container. `throwing` names fields whose
 * read throws a Sentinel.
 */
function buildOptions(
  fields: Record<string, unknown>,
  shape: Shape,
  throwing: readonly string[],
): object {
  const define = (target: object): object => {
    for (const [k, v] of Object.entries(fields)) {
      if (throwing.includes(k)) {
        Object.defineProperty(target, k, {
          enumerable: true,
          configurable: true,
          get() {
            throw new Sentinel(`getter ${k}`);
          },
        });
      } else {
        Object.defineProperty(target, k, {
          value: v,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    return target;
  };
  switch (shape) {
    case 'plain':
      return define({});
    case 'nullProto':
      return define(Object.create(null) as object);
    case 'frozen':
      return Object.freeze(define({}));
    case 'selfRef': {
      const o = define({}) as Record<string, unknown>;
      o.self = o;
      o.nested = { o };
      return o;
    }
    case 'symbolKeys': {
      const o = define({}) as Record<PropertyKey, unknown>;
      o[Symbol('idleTimeoutMs')] = 1;
      o[Symbol.toPrimitive] = () => {
        throw new Sentinel('toPrimitive');
      };
      return o;
    }
    case 'protoGetters':
      // All fields live on the prototype, not as own props.
      return Object.create(define({})) as object;
    case 'proxy':
      return new Proxy(define({}), {
        ownKeys() {
          throw new Sentinel('ownKeys');
        },
        getOwnPropertyDescriptor(t, k) {
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
        has(t, k) {
          return Reflect.has(t, k);
        },
        get(t, k, r) {
          return Reflect.get(t, k, r) as unknown;
        },
      });
  }
}

const signalArb = fc.oneof(
  fc.constant<unknown>(undefined),
  fc.constant('live'),
  fc.anything().map((reason) => ({ abortedWith: reason })),
  fc.constantFrom<unknown>({ aborted: false }, { aborted: true, reason: 'fake' }, null, 42),
);
function materializeSignal(s: unknown): unknown {
  if (s === 'live') return new AbortController().signal;
  if (s !== null && typeof s === 'object' && 'abortedWith' in s) {
    const c = new AbortController();
    c.abort(s.abortedWith);
    return c.signal;
  }
  return s;
}

const fnArb = fc.constantFrom<unknown>(
  () => undefined,
  () => {
    throw new Sentinel('callback threw');
  },
  42,
  'str',
  null,
  undefined,
  {},
);

const capArb = fc.oneof(
  fc.constant<unknown>(undefined),
  fc.integer({ min: 1, max: 1_000 }),
  hostileValue,
);

const optionFieldsArb = fc.record({
  idleTimeoutMs: timeoutArb,
  totalTimeoutMs: timeoutArb,
  signal: signalArb,
  onProgress: fnArb,
  logger: fc.constantFrom<unknown>(quietLogger, undefined),
  maxPartBytes: capArb,
  maxParts: capArb,
  maxHeadersPerPart: capArb,
  maxHeaderBytesPerPart: capArb,
});

const FIELDS = [
  'idleTimeoutMs',
  'totalTimeoutMs',
  'signal',
  'onProgress',
  'logger',
  'maxPartBytes',
  'maxParts',
  'maxHeadersPerPart',
  'maxHeaderBytesPerPart',
  'boundary',
  'parser',
  'fetchInit',
];
const throwingArb = fc.subarray(FIELDS, { maxLength: 2 });

const isDocumented = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  if (err instanceof Sentinel) return true;
  if (TYPED_ERROR_NAMES.has(err.name)) return true;
  return err.message.startsWith('multipart: ');
};

/** A tiny valid 1-part envelope for a given boundary. */
function tinyEnvelope(boundary: string): Buffer {
  return serialize({
    boundary,
    parts: [{ headers: [['Content-Type', 'text/plain']], body: Buffer.from('hi') }],
    preamble: Buffer.alloc(0),
    epilogue: Buffer.alloc(0),
    closingCrlf: true,
  }).bytes;
}

async function drainParse(
  input: unknown,
  opts: unknown,
  destroyOnly = false,
): Promise<{ ok: true; n: number } | { ok: false; err: unknown }> {
  try {
    let n = 0;
    for await (const part of parseMultipartRelated(input as Readable, opts as never)) {
      if (destroyOnly) part.body.destroy();
      else await streamToBuffer(part.body);
      n++;
    }
    return { ok: true, n };
  } catch (err) {
    return { ok: false, err };
  }
}

const CAP_FIELDS = [
  'maxPartBytes',
  'maxParts',
  'maxHeadersPerPart',
  'maxHeaderBytesPerPart',
] as const;

/**
 * Documented expectation for a non-throwing options bag, in check order
 * (timeouts first, then resource caps, then input/boundary, then signal).
 */
function expectOptionsOutcome(
  fields: Record<string, unknown>,
  throwing: readonly string[],
  out: { ok: true; n: number } | { ok: false; err: unknown },
): void {
  if (!out.ok && out.err instanceof Sentinel) return; // caller's getter/callback error, propagated
  const t = (k: string): boolean => !throwing.includes(k);
  if (t('idleTimeoutMs') && !isValidTimeout(fields.idleTimeoutMs)) {
    expect(out.ok).toBe(false);
    expect(out.ok ? undefined : out.err).toBeInstanceOf(TypeError);
    expect(out.ok ? '' : (out.err as Error).message).toMatch(
      /^multipart: idleTimeoutMs must be a positive finite integer/,
    );
    return;
  }
  if (t('totalTimeoutMs') && !isValidTimeout(fields.totalTimeoutMs)) {
    expect(out.ok ? undefined : out.err).toBeInstanceOf(TypeError);
    expect(out.ok ? '' : (out.err as Error).message).toMatch(
      /^multipart: totalTimeoutMs must be a positive finite integer/,
    );
    return;
  }
  for (const cap of CAP_FIELDS) {
    const v = fields[cap];
    if (t(cap) && v !== undefined && !(Number.isSafeInteger(v) && (v as number) >= 1)) {
      expect(out.ok ? undefined : out.err).toBeInstanceOf(TypeError);
      expect(out.ok ? '' : (out.err as Error).message).toMatch(
        new RegExp(`^multipart: ${cap} must be a positive safe integer`),
      );
      return;
    }
  }
  const sig = fields.signal;
  if (t('signal') && sig instanceof AbortSignal && sig.aborted) {
    expect(out.ok ? undefined : out.err).toBeInstanceOf(MultipartAbortError);
    expect((out as { err: MultipartAbortError }).err.reason).toBe(sig.reason);
  }
}

describe('fuzz: hostile options — parseMultipartRelated', () => {
  it(
    'settles with a documented outcome for any option-bag shape/values',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          optionFieldsArb,
          shapeArb,
          throwingArb,
          rfcBoundary,
          fc.boolean(),
          async (f, shape, throwing, boundary, asResponse) => {
            const fields: Record<string, unknown> = {
              ...f,
              signal: materializeSignal(f.signal),
              boundary,
            };
            const opts = buildOptions(fields, shape, throwing);
            const bytes = tinyEnvelope(boundary);
            const input = asResponse
              ? new Response(chunkedWebStream([bytes]).stream, {
                  headers: {
                    'content-type': `multipart/related; boundary=${boundaryParam(boundary)}`,
                  },
                })
              : chunkedReadable([bytes]);
            const { value: r, escaped } = await trapAsyncErrors(async () =>
              withDeadline(drainParse(input, opts), 1_500),
            );
            expect(escaped).toEqual([]);
            expect(r.hung).toBe(false);
            if (r.hung) return;
            const out = r.value;
            if (!out.ok) expect(isDocumented(out.err) || out.err instanceof TypeError).toBe(true);
            expectOptionsOutcome(fields, throwing, out);
          },
        ),
        params,
      );
    },
    testTimeout(20),
  );

  it('non-object / nullish opts reject with the documented multipart TypeError, not a raw property-access TypeError', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<unknown>(undefined, null, 0, 'opts', true, Symbol('o')),
        async (opts) => {
          const out = await drainParse(chunkedReadable([tinyEnvelope('b')]), opts);
          expect(out.ok).toBe(false);
          if (out.ok) return;
          expect(out.err).toBeInstanceOf(TypeError);
          expect((out.err as Error).message).toMatch(/^multipart: /);
        },
      ),
      { numRuns: Math.min(FUZZ_RUNS, 50) },
    );
  });

  it('hostile `input` values settle with an Error (never hang, never crash)', async () => {
    const inputArb = fc.oneof(
      fc.constantFrom<unknown>(null, undefined, 42, 'str', {}, [], Symbol('i')),
      fc.constant('fakeResponseThrowingHeaders'),
      fc.constant('fakeResponseStringBody'),
      fc.constant('fakeReadable'),
      fc.constant('destroyedReadable'),
    );
    await fc.assert(
      fc.asyncProperty(inputArb, async (kind) => {
        let input: unknown = kind;
        if (kind === 'fakeResponseThrowingHeaders') {
          input = {
            body: new ReadableStream(),
            headers: {
              get: () => {
                throw new Sentinel('headers.get');
              },
            },
          };
        } else if (kind === 'fakeResponseStringBody') {
          input = { body: 'not a stream', headers: { get: () => 'multipart/related; boundary=b' } };
        } else if (kind === 'fakeReadable') {
          input = { pipe: () => undefined, on: () => undefined };
        } else if (kind === 'destroyedReadable') {
          const r = chunkedReadable([tinyEnvelope('b')]);
          r.destroy();
          input = r;
        }
        const { value: r, escaped } = await trapAsyncErrors(() =>
          withDeadline(
            drainParse(input, {
              ...DEFAULT_TIMEOUTS,
              idleTimeoutMs: 50,
              boundary: 'b',
              logger: quietLogger,
            }),
            3_000,
          ),
        );
        expect(escaped).toEqual([]);
        expect(r.hung).toBe(false);
        if (!r.hung && !r.value.ok) expect(r.value.err).toBeInstanceOf(Error);
      }),
      { numRuns: Math.min(FUZZ_RUNS, 100) },
    );
  });

  it(
    'hostile `boundary` option for a Readable: documented error, or a correct parse when the envelope matches',
    async () => {
      const boundaryArb = fc.oneof(
        fc.constantFrom<unknown>('', undefined, null, 0, 123, {}, ['b']),
        fc.string({ minLength: 1, maxLength: 20, unit: 'grapheme' }),
        fc.string({ minLength: 71, maxLength: 5_000 }),
      );
      await fc.assert(
        fc.asyncProperty(boundaryArb, async (b) => {
          const env = typeof b === 'string' && b.length > 0 ? tinyEnvelope(b) : tinyEnvelope('x');
          const { value: out, escaped } = await trapAsyncErrors(() =>
            drainParse(chunkedReadable([env]), {
              ...DEFAULT_TIMEOUTS,
              boundary: b,
              logger: quietLogger,
            }),
          );
          expect(escaped).toEqual([]);
          if (typeof b !== 'string' || b === '') {
            expect(out.ok).toBe(false);
            expect(out.ok ? '' : (out.err as Error).message).toBe(
              'multipart: boundary option is required when input is a Readable',
            );
          } else if (!/[\r\n]/.test(b)) {
            expect(out).toEqual({ ok: true, n: 1 });
          }
        }),
        params,
      );
    },
    testTimeout(10),
  );
});

describe('fuzz: hostile options — fetchAndHandleMultipart', () => {
  const parserArb = fc.oneof(
    {
      weight: 3,
      arbitrary: fc.constant<unknown>(
        async (p: { body: Readable }) => (await streamToBuffer(p.body)).length,
      ),
    },
    { weight: 1, arbitrary: fc.constant<unknown>(() => 1) },
    {
      weight: 1,
      arbitrary: fc.constant<unknown>(() => {
        throw new Sentinel('parser threw');
      }),
    },
    {
      weight: 1,
      arbitrary: fc.constant<unknown>(async () => {
        throw new Sentinel('parser rejected');
      }),
    },
    {
      weight: 2,
      arbitrary: fc.constantFrom<unknown>(undefined, null, 42, 'fn', {}, Symbol('p'), [() => 1]),
    },
  );
  const fetchInitArb = fc.constantFrom<unknown>(
    undefined,
    {},
    { method: 'GET' },
    { signal: new AbortController().signal },
    { signal: undefined },
    null,
  );

  it(
    'settles with the documented outcome for any option-bag shape/values',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          optionFieldsArb,
          parserArb,
          fetchInitArb,
          shapeArb,
          throwingArb,
          rfcBoundary,
          async (f, parser, fetchInit, shape, throwing, boundary) => {
            const fields: Record<string, unknown> = {
              ...f,
              signal: materializeSignal(f.signal),
              parser,
              fetchInit,
            };
            const opts = buildOptions(fields, shape, throwing);
            let fetchCalls = 0;
            vi.stubGlobal('fetch', async () => {
              fetchCalls++;
              return new Response(chunkedWebStream([tinyEnvelope(boundary)]).stream, {
                headers: {
                  'content-type': `multipart/related; boundary=${boundaryParam(boundary)}`,
                },
              });
            });
            const { value: r, escaped } = await trapAsyncErrors(() =>
              withDeadline(
                fetchAndHandleMultipart('http://fuzz.invalid/', opts as never).then(
                  (v) => ({ ok: true as const, n: v.parts.length }),
                  (err: unknown) => ({ ok: false as const, err }),
                ),
                3_000,
              ),
            );
            expect(escaped).toEqual([]);
            expect(r.hung).toBe(false);
            if (r.hung) return;
            const out = r.value;
            if (!out.ok) expect(isDocumented(out.err) || out.err instanceof TypeError).toBe(true);
            if (!out.ok && out.err instanceof Sentinel) return;
            const readable = (k: string): boolean => !throwing.includes(k);
            if (readable('parser') && typeof parser !== 'function') {
              expect(out.ok ? undefined : (out.err as Error).message).toBe(
                'multipart: options.parser is required',
              );
              expect(fetchCalls).toBe(0);
              return;
            }
            // `fetchInit: null` is outside the declared type; it trips the
            // FR-024 `'signal' in fetchInit` check with a raw TypeError first.
            if (
              fetchInit === null &&
              readable('fetchInit') &&
              !out.ok &&
              out.err instanceof TypeError
            )
              return;
            const fi = fetchInit as { signal?: unknown } | undefined;
            if (
              readable('fetchInit') &&
              fi?.signal !== undefined &&
              isValidTimeout(fields.idleTimeoutMs) &&
              isValidTimeout(fields.totalTimeoutMs) &&
              readable('idleTimeoutMs') &&
              readable('totalTimeoutMs')
            ) {
              expect(out.ok ? undefined : (out.err as Error).message).toBe(
                'multipart: pass signal via options.signal — fetchInit.signal is reserved for internal use',
              );
              expect(fetchCalls).toBe(0);
              return;
            }
            if (readable('parser')) {
              expectOptionsOutcome(fields, throwing, out);
              const sig = fields.signal;
              if (
                readable('signal') &&
                sig instanceof AbortSignal &&
                sig.aborted &&
                readable('idleTimeoutMs') &&
                readable('totalTimeoutMs')
              ) {
                expect(fetchCalls).toBe(0);
              }
            }
          },
        ),
        params,
      );
    },
    testTimeout(20),
  );

  it('nullish / non-object options reject with a documented multipart TypeError', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<unknown>(undefined, null, 0, 'o'), async (opts) => {
        const err = await fetchAndHandleMultipart('http://fuzz.invalid/', opts as never).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(TypeError);
        expect((err as Error).message).toMatch(/^multipart: /);
      }),
      { numRuns: Math.min(FUZZ_RUNS, 50) },
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile Content-Type headers
// ---------------------------------------------------------------------------

const ws = fc.constantFrom('', ' ', '\t', '  \t ');
const contentTypeArb = fc.oneof(
  fc.string({ maxLength: 120 }),
  fc.string({ unit: 'binary', maxLength: 60 }),
  fc.string({
    unit: fc.constantFrom(
      ';',
      '=',
      '"',
      '\\',
      ' ',
      '\t',
      'boundary',
      'BOUNDARY',
      'multipart/related',
      'type',
      'x',
      'é',
      '\u{1F600}',
      '\x1b[2J',
      '\x00',
      '\r\n',
    ),
    maxLength: 30,
  }),
  fc
    .tuple(ws, ws, ws, rfcBoundary, fc.boolean())
    .map(([a, b, c, bd, q]) => `multipart/related${a};${b}boundary${c}=${boundaryParam(bd, q)}`),
  fc
    .tuple(rfcBoundary, rfcBoundary)
    .map(
      ([a, b]) => `multipart/related; boundary=${boundaryParam(a)}; boundary=${boundaryParam(b)}`,
    ),
  fc.string({ minLength: 1_000, maxLength: 20_000 }).map((s) => `multipart/related; boundary=${s}`),
  fc.constantFrom(
    '',
    'multipart/related',
    'multipart/related;',
    'multipart/related; boundary=',
    'multipart/related; boundary=""',
    'MULTIPART/RELATED; BOUNDARY=x',
    'multipart/relatedness; boundary=x',
    'multipart/form-data; boundary=x',
    'text/plain',
  ),
);

/** Duck-typed Response: lets us deliver header values `Headers` would reject. */
function fakeResponse(
  ct: string | null,
  bytes: Buffer,
): { res: Response; web: ReturnType<typeof chunkedWebStream> } {
  const web = chunkedWebStream([bytes]);
  const headers = {
    get: (n: string) => (n.toLowerCase() === 'content-type' ? ct : null),
  } as unknown as Headers;
  const res = { status: 200, headers, body: web.stream } as unknown as Response;
  return { res, web };
}

describe('fuzz: hostile Content-Type', () => {
  it(
    'parseMultipartRelated(Response) agrees with extractBoundary and parses a matching envelope',
    async () => {
      await fc.assert(
        fc.asyncProperty(contentTypeArb, async (ct) => {
          let boundary: string | undefined;
          let expectedErr: string | undefined;
          try {
            boundary = extractBoundary(ct);
          } catch (e) {
            expectedErr = (e as Error).message;
          }
          const { res } = fakeResponse(ct, tinyEnvelope(boundary ?? 'unused'));
          const { value: r, escaped } = await trapAsyncErrors(() =>
            withDeadline(drainParse(res, { ...DEFAULT_TIMEOUTS, logger: quietLogger }), 3_000),
          );
          expect(escaped).toEqual([]);
          expect(r.hung).toBe(false);
          if (r.hung) return;
          if (expectedErr !== undefined) {
            expect(r.value.ok ? undefined : (r.value.err as Error).message).toBe(expectedErr);
          } else if (!/[\r\n]/.test(boundary ?? '')) {
            expect(r.value).toEqual({ ok: true, n: 1 });
          }
        }),
        params,
      );
    },
    testTimeout(20),
  );

  it(
    'fetchAndHandleMultipart: documented, sanitized rejection or success; the response body is never left open on rejection',
    async () => {
      await fc.assert(
        fc.asyncProperty(contentTypeArb, async (ct) => {
          let boundary: string | undefined;
          try {
            boundary = extractBoundary(ct);
          } catch {
            boundary = undefined;
          }
          const { res, web } = fakeResponse(ct, tinyEnvelope(boundary ?? 'unused'));
          vi.stubGlobal('fetch', async () => res);
          const { value: r, escaped } = await trapAsyncErrors(() =>
            withDeadline(
              fetchAndHandleMultipart('http://fuzz.invalid/', {
                ...DEFAULT_TIMEOUTS,
                logger: quietLogger,
                parser: async (p) => (await streamToBuffer(p.body)).toString(),
              }).then(
                (v) => ({ ok: true as const, parts: [...v.parts] }),
                (err: unknown) => ({ ok: false as const, err: describeError(err) }),
              ),
              3_000,
            ),
          );
          expect(escaped).toEqual([]);
          expect(r.hung).toBe(false);
          if (r.hung) return;
          const out = r.value;
          if (!ct.toLowerCase().startsWith('multipart/related')) {
            expect(out.ok).toBe(false);
            if (out.ok) return;
            expect(
              out.err.message.startsWith(
                'multipart: response Content-Type is not multipart/related; got ',
              ),
            ).toBe(true);
          } else if (boundary === undefined) {
            expect(out.ok).toBe(false);
            if (out.ok) return;
            expect(out.err.message).toMatch(
              /^multipart: boundary parameter (missing from|is empty in) Content-Type: /,
            );
          } else if (!/[\r\n]/.test(boundary)) {
            expect(out).toEqual({ ok: true, parts: ['hi'] });
          }
          if (!out.ok) {
            // NFR-DR-S-006: no raw control characters in the message.
            expect(/[\x00-\x1f\x7f]/.test(out.err.message)).toBe(false);
            expect(out.err.message.length).toBeLessThan(260);
            // US-007 "no leaked sockets": the library owns this Response; on
            // rejection its body must be cancelled or fully consumed.
            expect(web.state.cancelled || web.state.pulledAll).toBe(true);
          }
        }),
        params,
      );
    },
    testTimeout(20),
  );
});

// ---------------------------------------------------------------------------
// streamToString / streamToBuffer
// ---------------------------------------------------------------------------

describe('fuzz: stream helpers', () => {
  const chunkArb = fc.oneof(
    fc.uint8Array({ maxLength: 16 }).map((u) => Buffer.from(u)),
    fc.string({ maxLength: 8 }),
    fc.uint8Array({ maxLength: 8 }),
  );

  it(
    'round-trip bytes exactly and honor maxBytes exactly',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.uint8Array({ maxLength: 32 }), { maxLength: 8 }),
          fc.option(fc.integer({ min: 1, max: 200 }), { nil: undefined }),
          async (chunks, maxBytes) => {
            const bufs = chunks.map((c) => Buffer.from(c));
            const all = Buffer.concat(bufs);
            const opts = maxBytes === undefined ? {} : { maxBytes };
            const b = await streamToBuffer(chunkedReadable(bufs), opts).then(
              (v) => v,
              (e: Error) => e,
            );
            const s = await streamToString(chunkedReadable(bufs), 'latin1', opts).then(
              (v) => v,
              (e: Error) => e,
            );
            if (maxBytes !== undefined && all.length > maxBytes) {
              expect((b as Error).message).toBe(
                `streamToBuffer: input exceeded maxBytes (${String(maxBytes)})`,
              );
              expect((s as Error).message).toBe(
                `streamToString: input exceeded maxBytes (${String(maxBytes)})`,
              );
            } else {
              expect(Buffer.isBuffer(b) && b.equals(all)).toBe(true);
              expect(s).toBe(all.toString('latin1'));
            }
          },
        ),
        // A run that never settles fails with its counterexample and seed
        // instead of timing out the whole test with no inputs to replay.
        { ...params, timeout: 5000 },
      );
    },
    testTimeout(20),
  );

  it(
    'hostile readables / encodings / options settle (no hang, no uncaught exception)',
    async () => {
      const encodingArb = fc.constantFrom<unknown>(
        undefined,
        'utf8',
        'hex',
        'base64',
        'latin1',
        'utf16le',
        'bogus',
        '',
        42,
        null,
      );
      const maxArb = fc.oneof(fc.constant<unknown>(undefined), hostileValue);
      const readableArb = fc.oneof(
        fc.array(chunkArb, { maxLength: 4 }).map((cs) => ({ kind: 'bytes' as const, cs })),
        fc
          .array(fc.anything(), { minLength: 1, maxLength: 3 })
          .map((cs) => ({ kind: 'objectMode' as const, cs })),
        fc.constantFrom(
          { kind: 'erroring' as const, cs: [] as unknown[] },
          { kind: 'notAStream' as const, cs: [] as unknown[] },
        ),
      );
      await fc.assert(
        fc.asyncProperty(
          readableArb,
          encodingArb,
          maxArb,
          fc.boolean(),
          async (src, enc, maxBytes, asString) => {
            const make = (): unknown => {
              switch (src.kind) {
                case 'bytes':
                  return Readable.from(
                    src.cs.map((c) => (typeof c === 'string' ? c : Buffer.from(c))),
                    { objectMode: false },
                  );
                case 'objectMode':
                  return Readable.from(
                    src.cs.filter((c) => c !== null && c !== undefined),
                    { objectMode: true },
                  );
                case 'erroring':
                  return new Readable({
                    read() {
                      this.destroy(new Sentinel('source error'));
                    },
                  });
                case 'notAStream':
                  return { on: 1 };
              }
            };
            const { value: r, escaped } = await trapAsyncErrors(() =>
              withDeadline(
                (asString
                  ? streamToString(
                      make() as Readable,
                      enc as BufferEncoding,
                      { maxBytes } as { maxBytes?: number },
                    )
                  : streamToBuffer(make() as Readable, { maxBytes } as { maxBytes?: number })
                ).then(
                  (v) => ({ ok: true as const, v }),
                  (err: unknown) => ({ ok: false as const, err }),
                ),
                1_000,
              ),
            );
            expect(escaped).toEqual([]);
            expect(r.hung).toBe(false);
          },
        ),
        params,
      );
    },
    testTimeout(10),
  );
});
