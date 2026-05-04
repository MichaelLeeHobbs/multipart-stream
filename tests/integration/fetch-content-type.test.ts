/**
 * Integration tests for `fetchAndHandleMultipart` Content-Type
 * validation (FR-021).
 *
 * Covers:
 *   - T-035: Content-Type: application/json → reject with FR-021 message;
 *     dicer NEVER constructed (harness count === 0).
 *   - T-036: case-insensitive — Content-Type: Multipart/Related → success.
 *   - T-067: 404 status + multipart-shaped body → still rejects per FR-021
 *     (status check is post-response; fail-fast still applies because
 *     the 404 returns a JSON body with application/json Content-Type).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fetchAndHandleMultipart, streamToString } from '../../src/index.js';
import {
  captureDicerActivity,
  type DicerActivityTracker,
} from '../fixtures/dicer-activity.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';
import { startMultipartServer } from '../fixtures/start-multipart-server.js';

const BOUNDARY = 'CT-VALIDATION-BOUNDARY';
const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

describe('fetchAndHandleMultipart — Content-Type validation (T-035 / T-036 / T-067)', () => {
  let tracker: DicerActivityTracker;

  beforeEach(() => {
    tracker = captureDicerActivity();
  });

  afterEach(() => {
    tracker.restore();
  });

  it('T-035: server returns application/json → rejects with FR-021 message; Dicer never constructed', async () => {
    const server = await startMultipartServer({
      status: 200,
      contentType: 'application/json',
      body: Buffer.from('{"error":"not multipart"}'),
    });
    try {
      const op = fetchAndHandleMultipart(server.url, {
        ...TIMEOUTS,
        parser: async () => undefined,
      });
      // The embedded value is JSON-stringified per NFR-DR-S-006.
      await expect(op).rejects.toThrow(
        /multipart: response Content-Type is not multipart\/related; got "application\/json"/,
      );
      // Fail-fast: dicer was NEVER constructed on this path.
      expect(tracker.dicerInstances().length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('T-036: case-insensitive — Multipart/Related succeeds', async () => {
    const body = buildMultipartBody({
      boundary: BOUNDARY,
      parts: [{ headers: { 'Content-Type': 'text/plain' }, body: 'ok' }],
    });
    const server = await startMultipartServer({
      // Capitalized — the FR-021 prefix check MUST be case-insensitive.
      contentType: `Multipart/Related; boundary=${BOUNDARY}`,
      body,
    });
    try {
      const result = await fetchAndHandleMultipart<string>(server.url, {
        ...TIMEOUTS,
        parser: async (part) => streamToString(part.body),
      });
      expect(result.parts).toEqual(['ok']);
    } finally {
      await server.close();
    }
  });

  it('T-067: 404 status + multipart-shaped body still rejects per FR-021 (Content-Type is wrong)', async () => {
    // The classic case: server returns a 404 with a JSON error body
    // even though the Accept header asked for multipart/related.
    const server = await startMultipartServer({
      status: 404,
      contentType: 'application/json',
      body: Buffer.from('{"error":"not found"}'),
    });
    try {
      const op = fetchAndHandleMultipart(server.url, {
        ...TIMEOUTS,
        parser: async () => undefined,
      });
      // The embedded value is JSON-stringified per NFR-DR-S-006.
      await expect(op).rejects.toThrow(
        /multipart: response Content-Type is not multipart\/related; got "application\/json"/,
      );
      expect(tracker.dicerInstances().length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('missing Content-Type header is also rejected (got empty string)', async () => {
    // The FR-021 prefix check operates on `headers.get('content-type') ?? ''`.
    // A server that omits the header entirely should produce the
    // FR-021 error with `got ` followed by an empty string (truncate
    // helper accepts ''.). The error message should still read clearly.
    const server = await startMultipartServer({
      status: 200,
      contentType: '', // empty string → server omits the header
      body: Buffer.from('whatever'),
    });
    try {
      const op = fetchAndHandleMultipart(server.url, {
        ...TIMEOUTS,
        parser: async () => undefined,
      });
      await expect(op).rejects.toThrow(
        /multipart: response Content-Type is not multipart\/related/,
      );
      expect(tracker.dicerInstances().length).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('text/plain (close-but-no) is rejected', async () => {
    const server = await startMultipartServer({
      status: 200,
      contentType: 'text/plain',
      body: Buffer.from('not multipart'),
    });
    try {
      const op = fetchAndHandleMultipart(server.url, {
        ...TIMEOUTS,
        parser: async () => undefined,
      });
      // The embedded value is JSON-stringified per NFR-DR-S-006.
      await expect(op).rejects.toThrow(
        /multipart: response Content-Type is not multipart\/related; got "text\/plain"/,
      );
      expect(tracker.dicerInstances().length).toBe(0);
    } finally {
      await server.close();
    }
  });
});
