import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { fetchAndHandleMultipart } from '../../src/index.js';

describe('review: rejected Content-Type releases the response body', () => {
  it('cancels the body so the server sees the connection close', async () => {
    let closed = false;
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"streaming": "forever"');
      res.on('close', () => {
        closed = true;
      });
      void req;
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(
        fetchAndHandleMultipart(`http://127.0.0.1:${port}/`, {
          idleTimeoutMs: 1_000,
          totalTimeoutMs: 1_000,
          parser: async () => undefined,
        }),
      ).rejects.toThrow(/not multipart\/related/);
      await new Promise((r) => setTimeout(r, 300));
      expect(closed).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
