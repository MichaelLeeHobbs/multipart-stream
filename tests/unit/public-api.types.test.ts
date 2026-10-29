/**
 * Type-level tests for the public entry (`src/index.ts`) as callers see it.
 *
 * Assertions are static: a regression fails `pnpm typecheck` (tests/ is in
 * the tsconfig `include`), which CI runs on every push. The runtime bodies
 * are never executed past the `if (false)` guards.
 */

import type { Readable } from 'node:stream';

import { describe, expectTypeOf, it } from 'vitest';

import {
  extractBoundary,
  fetchAndHandleMultipart,
  type MultipartFetchResult,
  type MultipartHandlerOptions,
  parseMultipartRelated,
  type PartParser,
  type StreamingMultipartPart,
  streamToBuffer,
  streamToString,
} from '../../src/index.js';
import * as api from '../../src/index.js';

const NEVER = false as boolean;

describe('public function signatures', () => {
  it('fetchAndHandleMultipart infers T from the parser', () => {
    if (NEVER) {
      const p = fetchAndHandleMultipart('https://x', {
        idleTimeoutMs: 1,
        totalTimeoutMs: 1,
        parser: async (part) => part.contentType.length,
      });
      expectTypeOf(p).toEqualTypeOf<Promise<MultipartFetchResult<number>>>();
    }
    expectTypeOf(fetchAndHandleMultipart).parameter(0).toEqualTypeOf<string | URL>();
  });

  it('fetchAndHandleMultipart rejects a parser that is not async', () => {
    if (NEVER) {
      void fetchAndHandleMultipart('https://x', {
        idleTimeoutMs: 1,
        totalTimeoutMs: 1,
        // @ts-expect-error -- PartParser must return a Promise
        parser: (part: StreamingMultipartPart) => part.index,
      });
    }
  });

  it('fetchInit cannot carry a signal', () => {
    if (NEVER) {
      void fetchAndHandleMultipart('https://x', {
        idleTimeoutMs: 1,
        totalTimeoutMs: 1,
        parser: async () => undefined,
        // @ts-expect-error -- signal belongs on options.signal (FR-024)
        fetchInit: { signal: new AbortController().signal },
      });
    }
  });

  it('timeouts are required on both entry points', () => {
    if (NEVER) {
      // @ts-expect-error -- idleTimeoutMs / totalTimeoutMs are required
      const bad: MultipartHandlerOptions<string> = {
        parser: async () => 'x',
      };
      void bad;
      // @ts-expect-error -- totalTimeoutMs is required
      void parseMultipartRelated(new Response(''), { idleTimeoutMs: 1 });
    }
  });

  it('parseMultipartRelated on a Readable requires boundary', () => {
    if (NEVER) {
      const r = null as unknown as Readable;
      // @ts-expect-error -- boundary is required for raw Readable input
      void parseMultipartRelated(r, { idleTimeoutMs: 1, totalTimeoutMs: 1 });
      const gen = parseMultipartRelated(r, {
        idleTimeoutMs: 1,
        totalTimeoutMs: 1,
        boundary: 'b',
      });
      expectTypeOf(gen).toEqualTypeOf<AsyncGenerator<StreamingMultipartPart, void, void>>();
    }
  });

  it('helpers return the documented shapes', () => {
    expectTypeOf(streamToString).returns.toEqualTypeOf<Promise<string>>();
    expectTypeOf(streamToBuffer).returns.toEqualTypeOf<Promise<Buffer>>();
    expectTypeOf(extractBoundary).returns.toEqualTypeOf<string>();
    expectTypeOf(extractBoundary).parameter(0).toEqualTypeOf<string | null | undefined>();
  });

  it('PartParser<T> is a part-to-promise callback', () => {
    expectTypeOf<PartParser<string>>().toEqualTypeOf<
      (part: StreamingMultipartPart) => Promise<string | undefined>
    >();
  });
});

describe('public result and part shapes are read-only', () => {
  it('MultipartFetchResult fields are readonly', () => {
    if (NEVER) {
      const r = null as unknown as MultipartFetchResult<string>;
      // @ts-expect-error -- readonly
      r.bytes = 1;
      expectTypeOf(r.parts).toEqualTypeOf<readonly string[]>();
    }
  });

  it('StreamingMultipartPart fields are readonly', () => {
    if (NEVER) {
      const p = null as unknown as StreamingMultipartPart;
      // @ts-expect-error -- readonly
      p.index = 2;
      expectTypeOf(p.headers.x).toEqualTypeOf<string | undefined>();
    }
  });
});

describe('error classes', () => {
  it('every exported error is an Error subclass with typed fields', () => {
    expectTypeOf(new api.MultipartAbortError()).toMatchTypeOf<Error>();
    expectTypeOf(new api.MultipartIdleTimeoutError(1).idleTimeoutMs).toEqualTypeOf<number>();
    expectTypeOf(new api.MultipartTotalTimeoutError(1).totalTimeoutMs).toEqualTypeOf<number>();
    expectTypeOf(new api.MultipartTruncatedError(1).bytesReceived).toEqualTypeOf<number>();
    expectTypeOf(
      new api.MultipartHeadersTooLargeError({
        limit: 'count',
        partIndex: 0,
        cap: 1,
        observed: 2,
      }).limit,
    ).toEqualTypeOf<'count' | 'bytes'>();
  });
});
