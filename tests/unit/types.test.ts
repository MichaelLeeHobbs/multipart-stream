/**
 * Type-level tests for the public option-bag interfaces (T-070, T-019).
 *
 * These tests pass at typecheck time — vitest's `expectTypeOf` adds runtime
 * stubs that allow them to live in a regular `.test-d.ts` file. The whole
 * point is the static assertion: failure surfaces during `pnpm typecheck`.
 *
 * NFR-DR-A-013: every optional input field on `ParseMultipartOptions` and
 * `MultipartHandlerOptions<T>` MUST use the `field?: T | undefined` form
 * so callers can spread-merge dynamically-built option records under
 * `exactOptionalPropertyTypes: true`.
 */

import { describe, expectTypeOf, it } from 'vitest';

import type {
  Logger,
  MultipartHandlerOptions,
  ParseMultipartOptions,
  PartParser,
  ProgressSnapshot,
  StreamingMultipartPart,
} from '../../src/types.js';

describe('option-bag exactOptionalPropertyTypes ergonomics (T-070, NFR-DR-A-013)', () => {
  it('ParseMultipartOptions accepts a spread-merged maybe-undefined signal', () => {
    // Synthesized "dynamically built" option record under
    // exactOptionalPropertyTypes: true. If the spec types had used bare
    // `signal?: AbortSignal`, this assignment would not typecheck.
    const maybeSignal: AbortSignal | undefined = undefined;
    const opts: ParseMultipartOptions = {
      idleTimeoutMs: 1000,
      totalTimeoutMs: 5000,
      signal: maybeSignal,
    };
    expectTypeOf(opts).toMatchTypeOf<ParseMultipartOptions>();
  });

  it('MultipartHandlerOptions accepts a spread-merged maybe-undefined logger', () => {
    const maybeLogger: Logger | undefined = undefined;
    const parser: PartParser<string> = async () => undefined;
    const opts: MultipartHandlerOptions<string> = {
      parser,
      idleTimeoutMs: 1000,
      totalTimeoutMs: 5000,
      logger: maybeLogger,
    };
    expectTypeOf(opts).toMatchTypeOf<MultipartHandlerOptions<string>>();
  });

  it('every documented optional field accepts undefined explicitly', () => {
    // This is the canonical "I built my options object dynamically and
    // every field is `T | undefined`" ergonomic pattern — it must
    // typecheck without complaint.
    const dynamicSignal: AbortSignal | undefined = undefined;
    const dynamicLogger: Logger | undefined = undefined;
    const dynamicCap: number | undefined = undefined;
    const dynamicProgress:
      | ((snap: ProgressSnapshot) => void)
      | undefined = undefined;

    const opts: ParseMultipartOptions = {
      idleTimeoutMs: 1000,
      totalTimeoutMs: 5000,
      boundary: undefined,
      signal: dynamicSignal,
      onProgress: dynamicProgress,
      logger: dynamicLogger,
      maxPartBytes: dynamicCap,
      maxParts: dynamicCap,
      maxHeadersPerPart: dynamicCap,
      maxHeaderBytesPerPart: dynamicCap,
    };
    expectTypeOf(opts).toMatchTypeOf<ParseMultipartOptions>();
  });
});

describe('Logger event-style signature (T-019, JC-2)', () => {
  it('Logger is a single-argument function over a {level,msg,meta?} event', () => {
    // The contract: `(event: { level: 'warn'; msg: string; meta?: unknown }) => void`.
    // Asserting `parameters` here proves it is event-style (one arg) NOT
    // the legacy `{ warn(msg, meta?) }` method-bag shape.
    expectTypeOf<Logger>().parameters.toEqualTypeOf<
      [event: { level: 'warn'; msg: string; meta?: unknown }]
    >();
    expectTypeOf<Logger>().returns.toBeVoid();
  });
});

describe('StreamingMultipartPart shape (data-model.md §1.1)', () => {
  it('exposes index, headers, body, and the documented convenience fields', () => {
    expectTypeOf<StreamingMultipartPart['index']>().toBeNumber();
    expectTypeOf<StreamingMultipartPart['boundary']>().toBeString();
    expectTypeOf<StreamingMultipartPart['contentType']>().toBeString();
    // contentId / contentLength are explicit `T | undefined` (spec form).
    expectTypeOf<StreamingMultipartPart['contentId']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<StreamingMultipartPart['contentLength']>().toEqualTypeOf<
      number | undefined
    >();
  });
});
