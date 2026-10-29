/**
 * extractBoundary properties vs. the RFC 2045/2046 parameter + boundary
 * grammar, plus totality / sanitization on arbitrary input.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { extractBoundary } from '../../src/index.js';
import { boundaryParam, FUZZ_RUNS, rfcBoundary } from './fuzz-helpers.js';

const params = { numRuns: FUZZ_RUNS } as const;

const ws = fc.constantFrom('', ' ', '  ', '\t', ' \t ');
const tokenChars = "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const token = fc.string({
  unit: fc.constantFrom(...tokenChars.split('')),
  minLength: 1,
  maxLength: 12,
});
/** Quoted-string content, including characters that look like syntax. */
const qcontent = fc.string({
  unit: fc.oneof(
    fc.constantFrom(';', '=', ' ', '"', '\\', ',', 'boundary', 'boundary=evil', 'é', '\u{1F600}'),
    fc.string({ unit: fc.constantFrom(...tokenChars.split('')), maxLength: 3 }),
  ),
  maxLength: 8,
});
const quoted = qcontent.map((v) => `"${v.replace(/(["\\])/g, '\\$1')}"`);

/** A non-boundary parameter whose name is never `boundary` (any case). */
const otherParam = fc
  .tuple(
    token.filter((n) => n.toLowerCase() !== 'boundary'),
    fc.oneof(token, quoted),
    ws,
    ws,
  )
  .map(([n, v, w1, w2]) => `${w1}${n}=${v}${w2}`);

const boundaryName = fc
  .array(fc.boolean(), { minLength: 8, maxLength: 8 })
  .map((caps) => [...'boundary'].map((c, i) => (caps[i] ? c.toUpperCase() : c)).join(''));

const mediaType = fc.constantFrom(
  'multipart/related',
  'Multipart/Related',
  'multipart/mixed',
  'application/x-weird',
);

/** Builds a header with the boundary at a random position among other params. */
const headerWithBoundary = fc
  .record({
    type: mediaType,
    boundary: rfcBoundary,
    name: boundaryName,
    forceQuote: fc.boolean(),
    before: fc.array(otherParam, { maxLength: 3 }),
    after: fc.array(otherParam, { maxLength: 3 }),
    sep: fc.constantFrom(';', '; ', ' ;', ';\t', ';;', ' ; '),
  })
  .map((r) => {
    const bp = `${r.name}=${boundaryParam(r.boundary, r.forceQuote)}`;
    const ps = [...r.before, bp, ...r.after];
    return { header: `${r.type}${r.sep}${ps.join(r.sep)}`, boundary: r.boundary };
  });

const DOCUMENTED = [
  /^multipart: Content-Type header is required to extract boundary$/,
  /^multipart: boundary parameter missing from Content-Type: /,
  /^multipart: boundary parameter is empty in Content-Type: /,
];

describe('fuzz: extractBoundary', () => {
  it('recovers any RFC 2046 boundary from any well-formed parameter list', () => {
    fc.assert(
      fc.property(headerWithBoundary, ({ header, boundary }) => {
        expect(extractBoundary(header)).toBe(boundary);
      }),
      params,
    );
  });

  it('first boundary parameter wins when duplicated', () => {
    fc.assert(
      fc.property(rfcBoundary, rfcBoundary, fc.boolean(), (a, b, q) => {
        const h = `multipart/related; boundary=${boundaryParam(a, q)}; BOUNDARY=${boundaryParam(b, !q)}`;
        expect(extractBoundary(h)).toBe(a);
      }),
      params,
    );
  });

  it('is total: returns a non-empty string or throws a documented, sanitized Error', () => {
    const anyHeader = fc.oneof(
      fc.string({ maxLength: 200 }),
      fc.string({ unit: 'binary', maxLength: 200 }),
      fc.string({
        unit: fc.constantFrom(
          ';',
          '=',
          '"',
          '\\',
          ' ',
          '\t',
          'b',
          'boundary',
          'BOUNDARY=',
          '\r\n',
          '\x1b[31m',
          '\u0000',
          '\ud800',
          'é',
        ),
        maxLength: 60,
      }),
      fc.constantFrom(null, undefined, ''),
    );
    fc.assert(
      fc.property(anyHeader, (h) => {
        let out: string;
        try {
          out = extractBoundary(h);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect(err).not.toBeInstanceOf(TypeError);
          const msg = (err as Error).message;
          expect(DOCUMENTED.some((re) => re.test(msg))).toBe(true);
          // NFR-DR-S-006: no raw control chars / ANSI in the message, embed bounded.
          expect(/[\x00-\x1f\x7f]/.test(msg)).toBe(false);
          const embed = msg.replace(/^[^:]*:[^:]*: /, '');
          expect(embed.length).toBeLessThanOrEqual(121);
          return;
        }
        expect(typeof out).toBe('string');
        expect(out.length).toBeGreaterThan(0);
      }),
      params,
    );
  });

  it('is idempotent: re-serializing the extracted boundary yields the same boundary', () => {
    const anyHeader = fc.oneof(
      headerWithBoundary.map((h) => h.header),
      fc
        .string({
          unit: fc.constantFrom(
            ';',
            '=',
            '"',
            '\\',
            ' ',
            '\t',
            'a',
            'boundary',
            'boundary=',
            'x"y',
          ),
          maxLength: 40,
        })
        .map((s) => `multipart/related;${s}`),
    );
    fc.assert(
      fc.property(anyHeader, fc.boolean(), (h, forceQuote) => {
        let b: string;
        try {
          b = extractBoundary(h);
        } catch {
          return;
        }
        expect(extractBoundary(`multipart/related; boundary=${boundaryParam(b, forceQuote)}`)).toBe(
          b,
        );
      }),
      params,
    );
  });

  it('a "boundary=" inside another parameter\'s quoted value is never matched', () => {
    fc.assert(
      fc.property(rfcBoundary, rfcBoundary, (evil, good) => {
        const h = `multipart/related; type="x; boundary=${evil.replace(/(["\\])/g, '\\$1')}"; boundary=${boundaryParam(good)}`;
        expect(extractBoundary(h)).toBe(good);
      }),
      params,
    );
  });

  it('bare-token results never contain parameter delimiters or whitespace', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (tail) => {
        let b: string;
        try {
          b = extractBoundary(`multipart/related; boundary=${tail}`);
        } catch {
          return;
        }
        if (!tail.trimStart().startsWith('"')) expect(/[; \t]/.test(b)).toBe(false);
      }),
      params,
    );
  });

  // Wall-clock budget; PERF_BUDGET_MS lets instrumented runs (mutation
  // testing, coverage) relax it without weakening the CI default.
  const budgetMs = Number(process.env.PERF_BUDGET_MS ?? 50);

  it('stays linear on 64 KiB adversarial input (NFR-DR-S-011, < 50 ms)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('\\"', '\\', '"', ';', '=', ' ', 'boundary', ';boundary'),
        fc.constantFrom(
          'multipart/related; boundary="',
          'multipart/related; a="',
          'multipart/related;',
          '',
        ),
        (unit, prefix) => {
          const h = prefix + unit.repeat(Math.ceil(65_536 / unit.length));
          const t0 = performance.now();
          try {
            extractBoundary(h);
          } catch {
            // either outcome is fine; we only time it
          }
          expect(performance.now() - t0).toBeLessThan(budgetMs);
        },
      ),
      { numRuns: Math.min(FUZZ_RUNS, 64) },
    );
  });
});
