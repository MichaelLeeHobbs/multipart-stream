/**
 * Shared arbitraries + harness for the property-based fuzz suite
 * (`tests/fuzz/*.fuzz.test.ts`). Not part of the published surface.
 *
 * `FUZZ_RUNS` controls numRuns for every property (CI default 100; hunt
 * locally with e.g. `FUZZ_RUNS=2000 pnpm vitest run tests/fuzz`).
 */

import { Readable } from 'node:stream';

import fc from 'fast-check';

import {
  type ParseMultipartOptions,
  parseMultipartRelated,
  streamToBuffer,
} from '../../src/index.js';

export const FUZZ_RUNS = Number(process.env.FUZZ_RUNS ?? 100);

/** Per-test vitest timeout scaled to the run count. */
export const testTimeout = (perRunMs: number): number => Math.max(30_000, FUZZ_RUNS * perRunMs);

const CRLF = Buffer.from('\r\n');

// ---------------------------------------------------------------------------
// RFC 2046 boundary grammar
//   boundary      := 0*69<bchars> bcharsnospace
//   bchars        := bcharsnospace / " "
//   bcharsnospace := DIGIT / ALPHA / "'" / "(" / ")" / "+" / "_" / "," /
//                    "-" / "." / "/" / ":" / "=" / "?"
// ---------------------------------------------------------------------------

export const BCHARS_NOSPACE =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'()+_,-./:=?";
/** RFC 2045 tspecials (+ space) — values containing these must be quoted. */
const NEEDS_QUOTING = /[()<>@,;:\\"/[\]?= \t]/;

const bcharNoSpace = fc.constantFrom(...BCHARS_NOSPACE.split(''));
const bchar = fc.oneof(
  { weight: 9, arbitrary: bcharNoSpace },
  { weight: 1, arbitrary: fc.constant(' ') },
);

/** A boundary that satisfies RFC 2046 (1..70 chars, last char not space). */
export const rfcBoundary: fc.Arbitrary<string> = fc
  .tuple(fc.array(bchar, { maxLength: 69 }), bcharNoSpace)
  .map(([head, last]) => head.join('') + last);

/** Serialize a boundary as a Content-Type parameter value (quoted iff needed). */
export function boundaryParam(boundary: string, forceQuote = false): string {
  if (forceQuote || NEEDS_QUOTING.test(boundary) || boundary.length === 0) {
    return `"${boundary.replace(/(["\\])/g, '\\$1')}"`;
  }
  return boundary;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

export interface GenPart {
  /** Header lines in wire order: [name, value]. Values are latin1 strings. */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Buffer;
  /**
   * With an empty body, drop the CRLF that introduces the body section:
   * RFC 2046 allows a part of headers only (`headers [CRLF *OCTET]`).
   */
  readonly omitBodySection?: boolean;
}

export interface GenEnvelope {
  readonly boundary: string;
  readonly parts: readonly GenPart[];
  readonly preamble: Buffer;
  readonly epilogue: Buffer;
  /** Whether to end the close-delimiter line with CRLF. */
  readonly closingCrlf: boolean;
}

const TOKEN_CHARS = "!#$%&'*+.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-";

export const headerName: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      'Content-Type',
      'Content-ID',
      'Content-Length',
      'content-type',
      'X-Thing',
      'Content-Transfer-Encoding',
    ),
  },
  {
    weight: 4,
    arbitrary: fc.string({
      unit: fc.constantFrom(...TOKEN_CHARS.split('')),
      minLength: 1,
      maxLength: 16,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom('__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'),
  },
);

/** Latin1 header-value chars that the wire format can carry (no CTLs). */
const headerValueChar = fc
  .oneof(
    { weight: 20, arbitrary: fc.integer({ min: 0x20, max: 0x7e }) },
    { weight: 1, arbitrary: fc.constant(0x09) },
    { weight: 2, arbitrary: fc.integer({ min: 0x80, max: 0xff }) },
  )
  .map((c) => String.fromCharCode(c));

export const headerValue: fc.Arbitrary<string> = fc.oneof(
  { weight: 1, arbitrary: fc.constant('') },
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      'text/plain',
      'application/json',
      '<cid@x>',
      '42',
      'multipart/related; boundary=inner',
    ),
  },
  { weight: 8, arbitrary: fc.string({ unit: headerValueChar, maxLength: 40 }) },
);

/** Byte fragments that stress delimiter detection. */
function trickyFragments(boundary: string): fc.Arbitrary<Buffer> {
  const pre = (n: number): string =>
    boundary.slice(0, Math.max(0, Math.min(boundary.length - 1, n)));
  return fc
    .oneof(
      fc.constantFrom('\r\n', '\r', '\n', '--', '\r\n--', '\r\n-', '--\r\n', '\r\n\r\n', '\r\r\n'),
      fc.nat({ max: 70 }).map((n) => `\r\n--${pre(n)}`),
      fc.nat({ max: 70 }).map((n) => `--${pre(n)}`),
      fc.constant(`--${boundary}`), // no leading CRLF → not a delimiter mid-body
      fc.constant(`\r\n-${boundary}`),
    )
    .map((s) => Buffer.from(s, 'utf8'));
}

export function bodyBytes(boundary: string, maxPieces = 8): fc.Arbitrary<Buffer> {
  const needle = Buffer.from(`\r\n--${boundary}`);
  return (
    fc
      .array(
        fc.oneof(
          { weight: 3, arbitrary: fc.uint8Array({ maxLength: 64 }).map((u) => Buffer.from(u)) },
          { weight: 2, arbitrary: trickyFragments(boundary) },
        ),
        { maxLength: maxPieces },
      )
      .map((pieces) => Buffer.concat(pieces))
      // RFC 2046: the delimiter must not occur inside encapsulated data.
      .filter((b) => !b.includes(needle))
  );
}

export function partArb(boundary: string): fc.Arbitrary<GenPart> {
  return fc.record({
    headers: fc.array(fc.tuple(headerName, headerValue), { maxLength: 6 }),
    body: bodyBytes(boundary),
    omitBodySection: fc.boolean(),
  });
}

export const envelopeArb: fc.Arbitrary<GenEnvelope> = rfcBoundary
  .chain((boundary) => {
    const needle = Buffer.from(`\r\n--${boundary}`);
    return fc.record({
      boundary: fc.constant(boundary),
      parts: fc.array(partArb(boundary), { maxLength: 5 }),
      preamble: fc
        .oneof(
          { weight: 3, arbitrary: fc.constant(Buffer.alloc(0)) },
          { weight: 1, arbitrary: bodyBytes(boundary, 3) },
        )
        .filter((p) => !Buffer.concat([CRLF, p, CRLF]).subarray(0, -2).includes(needle)),
      epilogue: fc.oneof(
        { weight: 3, arbitrary: fc.constant(Buffer.alloc(0)) },
        { weight: 1, arbitrary: fc.uint8Array({ maxLength: 40 }).map((u) => Buffer.from(u)) },
      ),
      closingCrlf: fc.boolean(),
    });
  })
  .filter(isWellFramed);

/** Count non-overlapping-start occurrences of `needle` in `hay`. */
export function countOccurrences(hay: Buffer, needle: Buffer): number {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

/**
 * RFC 2046: the delimiter may only occur where we placed it. Header names or
 * bodies starting with `--boundary` (right after a CRLF) would otherwise
 * form an extra delimiter.
 */
export function isWellFramed(env: GenEnvelope): boolean {
  const { bytes, closeEnd } = serialize(env);
  const needle = Buffer.from(`\r\n--${env.boundary}`);
  return (
    countOccurrences(Buffer.concat([CRLF, bytes.subarray(0, closeEnd)]), needle) ===
    env.parts.length + 1
  );
}

export function serializeHeaders(headers: GenPart['headers']): Buffer {
  return Buffer.from(headers.map(([n, v]) => `${n}: ${v}\r\n`).join(''), 'latin1');
}

export interface Serialized {
  readonly bytes: Buffer;
  /** Offset just past the closing `--boundary--` (before optional CRLF). */
  readonly closeEnd: number;
}

/**
 * `padding[i]` is RFC 2046 transport-padding (LWSP) written after the i-th
 * delimiter (the last entry pads the close-delimiter).
 */
export function serialize(env: GenEnvelope, padding: readonly string[] = []): Serialized {
  const chunks: Buffer[] = [];
  if (env.preamble.length > 0) chunks.push(env.preamble, CRLF);
  env.parts.forEach((part, i) => {
    chunks.push(
      Buffer.from(`--${env.boundary}${padding[i] ?? ''}\r\n`),
      serializeHeaders(part.headers),
      ...(part.omitBodySection === true && part.body.length === 0 ? [] : [CRLF, part.body]),
      CRLF,
    );
  });
  chunks.push(Buffer.from(`--${env.boundary}--${padding[env.parts.length] ?? ''}`));
  const closeEnd = Buffer.concat(chunks).length;
  // RFC 2046: close-delimiter [CRLF epilogue] — an epilogue needs the CRLF.
  if (env.closingCrlf || env.epilogue.length > 0) chunks.push(CRLF, env.epilogue);
  return { bytes: Buffer.concat(chunks), closeEnd };
}

/** Expected flattened header bag per the documented contract. */
export function expectedHeaders(headers: GenPart['headers']): Record<string, string> {
  const grouped = new Map<string, string[]>();
  for (const [n, v] of headers) {
    const k = n.toLowerCase();
    const list = grouped.get(k) ?? [];
    // Whitespace around a field value is not part of it.
    list.push(v.replace(/^[ \t]+|[ \t]+$/g, ''));
    grouped.set(k, list);
  }
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, vs] of grouped) {
    out[k] = vs.join(', ');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export const chunkPlanArb: fc.Arbitrary<readonly number[]> = fc.oneof(
  fc.constant([1]),
  fc.array(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 8 }),
  fc.array(fc.integer({ min: 1, max: 300 }), { minLength: 1, maxLength: 8 }),
  fc.constant([1 << 20]),
);

export function splitChunks(buf: Buffer, plan: readonly number[]): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  let i = 0;
  while (off < buf.length) {
    const size = plan[i % plan.length] ?? 1;
    out.push(Buffer.from(buf.subarray(off, off + size)));
    off += size;
    i++;
  }
  return out;
}

/** A plain (non-object-mode) byte Readable yielding `chunks` then EOF. */
export function chunkedReadable(chunks: readonly Buffer[], opts: { end?: boolean } = {}): Readable {
  const end = opts.end ?? true;
  let i = 0;
  return new Readable({
    read() {
      if (i < chunks.length) {
        this.push(chunks[i++]);
      } else if (end) {
        this.push(null);
      }
    },
  });
}

export interface WebSource {
  readonly stream: ReadableStream<Uint8Array>;
  readonly state: { cancelled: boolean; pulledAll: boolean };
}

export function chunkedWebStream(chunks: readonly Buffer[]): WebSource {
  const state = { cancelled: false, pulledAll: false };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const c = chunks[i++];
      if (c === undefined) {
        state.pulledAll = true;
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(c));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

// ---------------------------------------------------------------------------
// Outcome collection (with hang detection)
// ---------------------------------------------------------------------------

export interface PartRecord {
  readonly index: number;
  readonly headers: Record<string, string | undefined>;
  readonly rawHeaders: string;
  readonly contentType: string;
  readonly contentId: string | undefined;
  readonly contentLength: number | undefined;
  readonly body: string; // hex
}

export interface Outcome {
  readonly parts: PartRecord[];
  readonly error?:
    | { readonly name: string; readonly message: string; readonly ctor: string }
    | undefined;
  readonly errorObj?: unknown;
  readonly hung?: boolean;
}

export function recordPart(
  part: {
    index: number;
    headers: Readonly<Record<string, string | undefined>>;
    rawHeaders: Buffer;
    contentType: string;
    contentId?: string | undefined;
    contentLength?: number | undefined;
  },
  body: Buffer,
): PartRecord {
  // fromEntries defines own data properties, so a `__proto__` header is kept.
  const headers: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(part.headers).map((k) => [k, part.headers[k]]),
  );
  return {
    index: part.index,
    headers,
    rawHeaders: part.rawHeaders.toString('hex'),
    contentType: part.contentType,
    contentId: part.contentId,
    contentLength: part.contentLength,
    body: body.toString('hex'),
  };
}

export function describeError(err: unknown): NonNullable<Outcome['error']> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, ctor: err.constructor.name };
  }
  return { name: typeof err, message: String(err), ctor: typeof err };
}

/**
 * Race `p` against a deadline. Resolves `{ hung: true }` if the deadline
 * elapses first. The deadline timer is always cleared.
 */
export async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ hung: false; value: T } | { hung: true }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ hung: true }>((resolve) => {
    timer = setTimeout(() => resolve({ hung: true }), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ hung: false as const, value })), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 30_000 } as const;

/** Drive parseMultipartRelated to completion, draining every body. */
export async function collectParse(
  input: Readable | Response,
  opts: ParseMultipartOptions,
  deadlineMs = 5_000,
  /** 'destroy' skips each body instead of draining it. */
  mode: 'drain' | 'destroy' = 'drain',
): Promise<Outcome> {
  const parts: PartRecord[] = [];
  const run = (async (): Promise<Outcome> => {
    try {
      for await (const part of parseMultipartRelated(
        input as Readable,
        opts as ParseMultipartOptions & { boundary: string },
      )) {
        if (mode === 'destroy') part.body.destroy();
        const body = mode === 'destroy' ? Buffer.alloc(0) : await streamToBuffer(part.body);
        parts.push(recordPart(part, body));
      }
      return { parts };
    } catch (err) {
      return { parts, error: describeError(err), errorObj: err };
    }
  })();
  const r = await withDeadline(run, deadlineMs);
  if (r.hung) {
    if (input instanceof Readable) input.destroy();
    return { parts, hung: true };
  }
  return r.value;
}

/** Strip the raw error object so outcomes can be deep-compared. */
export function comparable(o: Outcome): Omit<Outcome, 'errorObj'> {
  const { errorObj: _e, ...rest } = o;
  void _e;
  return rest;
}

export const activeTimeouts = (): number =>
  process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

export const settle = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

export async function settleTwice(): Promise<void> {
  await settle();
  await settle();
}

/** Byte-level mutations for "near-valid" hostile envelopes. */
export const mutationArb = fc.oneof(
  fc.record({
    kind: fc.constant('flip' as const),
    at: fc.nat(),
    value: fc.integer({ min: 0, max: 255 }),
  }),
  fc.record({
    kind: fc.constant('insert' as const),
    at: fc.nat(),
    bytes: fc.oneof(
      fc.uint8Array({ minLength: 1, maxLength: 8 }),
      fc.constantFrom(
        ...['\r\n', '--', '\r\n\r\n', ':', ' '].map((s) => new Uint8Array(Buffer.from(s))),
      ),
    ),
  }),
  fc.record({
    kind: fc.constant('delete' as const),
    at: fc.nat(),
    len: fc.integer({ min: 1, max: 8 }),
  }),
  fc.record({ kind: fc.constant('truncate' as const), at: fc.nat() }),
);
export type Mutation = typeof mutationArb extends fc.Arbitrary<infer M> ? M : never;

export function applyMutations(buf: Buffer, muts: readonly Mutation[]): Buffer {
  let b = Buffer.from(buf);
  for (const m of muts) {
    if (b.length === 0) break;
    const at = m.at % (b.length + 1);
    switch (m.kind) {
      case 'flip':
        if (at < b.length) b[at] = m.value;
        break;
      case 'insert':
        b = Buffer.concat([b.subarray(0, at), Buffer.from(m.bytes), b.subarray(at)]);
        break;
      case 'delete':
        b = Buffer.concat([b.subarray(0, at), b.subarray(at + m.len)]);
        break;
      case 'truncate':
        b = Buffer.from(b.subarray(0, at));
        break;
    }
  }
  return b;
}

/** Every public error class name. */
export const TYPED_ERROR_NAMES = new Set([
  'MultipartIdleTimeoutError',
  'MultipartTotalTimeoutError',
  'MultipartAbortError',
  'MultipartTruncatedError',
  'MultipartPartTooLargeError',
  'MultipartHeadersTooLargeError',
  'MultipartTooManyPartsError',
]);
