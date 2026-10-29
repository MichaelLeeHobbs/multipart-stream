import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { fetchAndHandleMultipart, MultipartTotalTimeoutError } from '../../src/index.js';

describe('review: totalTimeoutMs covers the fetch (time-to-headers) phase', () => {
  it('rejects with MultipartTotalTimeoutError when the server never sends headers', async () => {
    const server = http.createServer(() => {
      // never respond
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const HANG = Symbol('hang');
    try {
      const p = fetchAndHandleMultipart(`http://127.0.0.1:${port}/`, {
        idleTimeoutMs: 100,
        totalTimeoutMs: 100,
        parser: async () => undefined,
      }).catch((e: unknown) => e);
      const result = await Promise.race([p, new Promise((r) => setTimeout(() => r(HANG), 1_500))]);
      expect(result).toBeInstanceOf(MultipartTotalTimeoutError);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
