/**
 * Integration + type-level tests for `MultipartFetchResult<T>` (T-074 +
 * T-005, FR-DR-A-029).
 *
 * Asserts:
 *   - Object.keys equals ['bytes','elapsedMs','headers','parts','status']
 *   - 'response' in result === false (FR-DR-A-029 — the Response field
 *     is REMOVED at the type level too).
 *   - result.headers instanceof Headers === true.
 *   - result.status matches the underlying fetch response status.
 *   - result.bytes > 0; result.elapsedMs >= 0.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  fetchAndHandleMultipart,
  type MultipartFetchResult,
  streamToString,
} from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';
import { startMultipartServer } from '../fixtures/start-multipart-server.js';

const BOUNDARY = 'RESULT-SHAPE-BOUNDARY';
const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

describe('MultipartFetchResult shape (T-074 / FR-DR-A-029)', () => {
  it('result has exactly { bytes, elapsedMs, headers, parts, status } and NO response field', async () => {
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        { headers: { 'Content-Type': 'text/plain' }, body: 'one' },
        { headers: { 'Content-Type': 'text/plain' }, body: 'two' },
      ],
    });
    const server = await startMultipartServer({
      status: 200,
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const result = await fetchAndHandleMultipart<string>(server.url, {
        ...TIMEOUTS,
        parser: async (part) => streamToString(part.body),
      });

      expect(Object.keys(result).sort()).toEqual([
        'bytes',
        'elapsedMs',
        'headers',
        'parts',
        'status',
      ]);
      expect('response' in result).toBe(false);
      expect(result.headers).toBeInstanceOf(Headers);
      expect(result.status).toBe(200);
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(result.parts).toHaveLength(2);
      expect(result.parts).toEqual(['one', 'two']);
    } finally {
      await server.close();
    }
  });

  it('result.status reflects the underlying fetch response status (verified non-200 is rejected by FR-021 path; here we test 200)', async () => {
    // Note: a non-200 status combined with a multipart-shaped Content-Type
    // is theoretically possible but rare; FR-021 doesn't gate on status,
    // so a 200 + multipart envelope is the primary path here. The 4xx +
    // multipart-CT case is tested in fetch-content-type.test.ts (T-067).
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [{ headers: { 'Content-Type': 'text/plain' }, body: 'x' }],
    });
    const server = await startMultipartServer({
      status: 200,
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const result = await fetchAndHandleMultipart<string>(server.url, {
        ...TIMEOUTS,
        parser: async () => undefined,
      });
      expect(result.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('headers are accessible via the standard Headers API on the result', async () => {
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [{ headers: { 'Content-Type': 'text/plain' }, body: 'x' }],
    });
    const server = await startMultipartServer({
      status: 200,
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const result = await fetchAndHandleMultipart<string>(server.url, {
        ...TIMEOUTS,
        parser: async () => undefined,
      });
      // The Content-Type header survived from the response.
      const ct = result.headers.get('content-type');
      expect(ct).not.toBeNull();
      expect(ct!.toLowerCase()).toContain('multipart/related');
    } finally {
      await server.close();
    }
  });
});

describe('MultipartFetchResult — type-level shape', () => {
  it('MultipartFetchResult<T> has no `response` field at the type layer (FR-DR-A-029)', () => {
    // The presence of `response` in the type would surface as `keyof
    // MultipartFetchResult<T>` containing 'response'. Asserting the
    // literal-union of keys is the cleanest type-level proof.
    type Keys = keyof MultipartFetchResult<unknown>;
    expectTypeOf<Keys>().toEqualTypeOf<
      'parts' | 'bytes' | 'elapsedMs' | 'status' | 'headers'
    >();
  });

  it('result.parts is `readonly T[]` and result.headers is `Headers`', () => {
    type R = MultipartFetchResult<string>;
    expectTypeOf<R['parts']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<R['headers']>().toEqualTypeOf<Headers>();
    expectTypeOf<R['status']>().toBeNumber();
    expectTypeOf<R['bytes']>().toBeNumber();
    expectTypeOf<R['elapsedMs']>().toBeNumber();
  });
});
