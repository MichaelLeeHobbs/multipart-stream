import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  parseMultipartRelated,
  type PartParser,
  streamToString,
} from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const BOUNDARY = 'X-PARSER-HARNESS-BOUNDARY';
const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

/**
 * T-007 (partial). The full FR-014 contract (parser-undefined-skip,
 * parser-throw-rejects-and-cleans-up) is owned by `fetchAndHandleMultipart`
 * and asserted in `tests/integration/fetch-and-handle.test.ts`. This file
 * proves that the `StreamingMultipartPart` shape yielded by
 * `parseMultipartRelated` is sufficient to drive a `PartParser<T>` callback
 * inline — locking the contract that Layer B's wiring depends on.
 *
 * The harness below mimics the Layer B loop:
 *
 *   const parts: T[] = [];
 *   for await (const part of parseMultipartRelated(...)) {
 *     const v = await parser(part);
 *     if (v !== undefined) parts.push(v);
 *   }
 */
describe('parseMultipartRelated drives a PartParser inline (T-007 partial)', () => {
  it('parser returning undefined for some parts contributes nothing for those', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        {
          headers: { 'Content-Type': 'application/json', 'Content-ID': '<meta>' },
          body: '{"k":1}',
        },
        {
          headers: { 'Content-Type': 'text/plain', 'Content-ID': '<skip>' },
          body: 'this part is skipped',
        },
        {
          headers: { 'Content-Type': 'application/json', 'Content-ID': '<also>' },
          body: '{"k":2}',
        },
      ],
    });

    const parser: PartParser<unknown> = async (part) => {
      if (part.contentType !== 'application/json') {
        // For skip semantics, `fetchAndHandleMultipart` drains the body
        // automatically when the parser returns undefined. In this
        // harness we drain manually to keep the generator advancing.
        for await (const _chunk of part.body) void _chunk;
        return undefined;
      }
      return JSON.parse(await streamToString(part.body)) as unknown;
    };

    const collected: unknown[] = [];
    for await (const part of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      const v = await parser(part);
      if (v !== undefined) collected.push(v);
    }

    expect(collected).toEqual([{ k: 1 }, { k: 2 }]);
  });

  it('parser returning a value for every part yields one entry per part', async () => {
    const buf = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        { headers: { 'Content-Type': 'text/plain' }, body: 'a' },
        { headers: { 'Content-Type': 'text/plain' }, body: 'b' },
      ],
    });

    const parser: PartParser<string> = async (part) => streamToString(part.body);
    const collected: string[] = [];
    for await (const part of parseMultipartRelated(Readable.from(buf), {
      ...TIMEOUTS,
      boundary: BOUNDARY,
    })) {
      const v = await parser(part);
      if (v !== undefined) collected.push(v);
    }
    expect(collected).toEqual(['a', 'b']);
  });
});
