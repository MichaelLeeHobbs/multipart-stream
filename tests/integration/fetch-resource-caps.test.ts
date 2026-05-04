/**
 * Layer B → Layer A cap-forwarding end-to-end tests.
 *
 * `MultipartHandlerOptions<T>` is forwarded to `ParseMultipartOptions`.
 * These tests assert the typed errors surface from `fetchAndHandleMultipart`
 * with the same shape they surface from a direct `parseMultipartRelated`
 * call (proving the forwarding is byte-exact, not lossy or wrapped).
 *
 * Each cap gets a dedicated server-driven test:
 *  - maxPartBytes (NFR-DR-S-001) → MultipartPartTooLargeError
 *  - maxParts (NFR-DR-S-012) → MultipartTooManyPartsError
 *  - maxHeadersPerPart (NFR-DR-S-004 count) → MultipartHeadersTooLargeError
 *  - maxHeaderBytesPerPart (NFR-DR-S-004 bytes) → MultipartHeadersTooLargeError
 */

import { describe, expect, it } from 'vitest';

import {
  fetchAndHandleMultipart,
  MultipartHeadersTooLargeError,
  MultipartPartTooLargeError,
  MultipartTooManyPartsError,
  streamToString,
} from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';
import { startMultipartServer } from '../fixtures/start-multipart-server.js';

const BOUNDARY = 'CAPS-FETCH-37bd';
const TIMEOUTS = { idleTimeoutMs: 10_000, totalTimeoutMs: 60_000 } as const;

describe('fetchAndHandleMultipart — cap forwarding trip-time', () => {
  it('forwards maxPartBytes — overflow surfaces as MultipartPartTooLargeError from Layer B', async () => {
    const partBody = Buffer.alloc(8 * 1024, 0x43); // 8 KiB
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        {
          headers: { 'Content-Type': 'application/octet-stream' },
          body: partBody,
        },
      ],
    });
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      let caught: unknown;
      try {
        await fetchAndHandleMultipart<Buffer>(server.url, {
          ...TIMEOUTS,
          maxPartBytes: 1024,
          parser: async (part) => {
            // Drain — needed to exercise the per-part body counter so the
            // cap can trip. The library's drain (FR-014) also handles this
            // when the parser returns undefined, but a deliberate drain
            // here keeps the test intent obvious.
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            for await (const _chunk of part.body) {
              // discard
            }
            return undefined;
          },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MultipartPartTooLargeError);
      const err = caught as MultipartPartTooLargeError;
      expect(err.maxPartBytes).toBe(1024);
      expect(err.partIndex).toBe(0);
      expect(err.bytesReceived).toBeGreaterThan(1024);
    } finally {
      await server.close();
    }
  });

  it('forwards maxParts — overflow surfaces as MultipartTooManyPartsError from Layer B', async () => {
    const parts = Array.from({ length: 20 }, (_, i) => ({
      headers: {
        'Content-Type': 'text/plain',
        'Content-ID': `<p-${String(i)}>`,
      },
      body: `b-${String(i)}`,
    }));
    const body = buildMultipartBody({ boundary: BOUNDARY, parts });
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      let caught: unknown;
      try {
        await fetchAndHandleMultipart<string>(server.url, {
          ...TIMEOUTS,
          maxParts: 5,
          parser: async (part) => streamToString(part.body),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MultipartTooManyPartsError);
      const err = caught as MultipartTooManyPartsError;
      expect(err.maxParts).toBe(5);
      expect(err.observed).toBe(6);
    } finally {
      await server.close();
    }
  });

  it('forwards maxHeadersPerPart — overflow surfaces as MultipartHeadersTooLargeError {limit:"count"} from Layer B', async () => {
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain',
    };
    for (let i = 0; i < 200; i++) {
      headers[`x-bomb-${String(i)}`] = `v-${String(i)}`;
    }
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [{ headers, body: 'tiny' }],
    });
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      let caught: unknown;
      try {
        await fetchAndHandleMultipart<string>(server.url, {
          ...TIMEOUTS,
          maxHeadersPerPart: 100,
          parser: async (part) => streamToString(part.body),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MultipartHeadersTooLargeError);
      const err = caught as MultipartHeadersTooLargeError;
      expect(err.limit).toBe('count');
      expect(err.cap).toBe(100);
      expect(err.observed).toBeGreaterThan(100);
      expect(err.partIndex).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('forwards maxHeaderBytesPerPart — overflow surfaces as MultipartHeadersTooLargeError {limit:"bytes"} from Layer B', async () => {
    const bigValue = 'x'.repeat(32 * 1024);
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [
        {
          headers: {
            'Content-Type': 'text/plain',
            'X-Big': bigValue,
          },
          body: 'tiny',
        },
      ],
    });
    const server = await startMultipartServer({
      contentType: `multipart/related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      let caught: unknown;
      try {
        await fetchAndHandleMultipart<string>(server.url, {
          ...TIMEOUTS,
          maxHeaderBytesPerPart: 16_384,
          parser: async (part) => streamToString(part.body),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MultipartHeadersTooLargeError);
      const err = caught as MultipartHeadersTooLargeError;
      expect(err.limit).toBe('bytes');
      expect(err.cap).toBe(16_384);
      expect(err.observed).toBeGreaterThan(16_384);
    } finally {
      await server.close();
    }
  });
});
