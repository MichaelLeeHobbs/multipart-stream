import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { fetchAndHandleMultipart, streamToBuffer } from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

describe('review: MultipartFetchResult.bytes is the total envelope size', () => {
  it('counts bytes that arrive after the last part header', async () => {
    const envelope = buildMultipartBody({
      boundary: 'B',
      parts: [
        { headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(200_000, 7) },
      ],
    });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'multipart/related; boundary=B' });
      // Send headers first, then the body later, so the header event fires early.
      res.write(envelope.subarray(0, 100));
      setTimeout(() => res.end(envelope.subarray(100)), 30);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const result = await fetchAndHandleMultipart(`http://127.0.0.1:${port}/`, {
        idleTimeoutMs: 5_000,
        totalTimeoutMs: 10_000,
        parser: async (part) => (await streamToBuffer(part.body)).length,
      });
      expect(result.parts).toEqual([200_000]);
      expect(result.bytes).toBe(envelope.length);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
