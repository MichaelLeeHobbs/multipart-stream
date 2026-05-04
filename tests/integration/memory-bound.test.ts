/**
 * Memory-bound test (T-051, NFR-011).
 *
 * Pushes a 100 MB envelope (10 × 10 MB parts) through fetchAndHandleMultipart
 * with a parser that drains via streaming (NOT streamToBuffer). Asserts peak
 * `process.memoryUsage().heapUsed` stays < 50 MB above the pre-test baseline.
 *
 * The 50 MB threshold is the documented tunable. The test is heavy
 * (100 MB envelope, multi-second runtime) so we gate it on
 * `RUN_MEMORY_TEST=1` — it runs in the local pre-publish gate but is
 * skipped on CI by default. Operators can opt-in via the env var.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  fetchAndHandleMultipart,
  type StreamingMultipartPart,
} from '../../src/index.js';

const BOUNDARY = 'MEMORY-BOUNDARY';
const PART_SIZE = 10 * 1024 * 1024; // 10 MiB
const PART_COUNT = 10; // → 100 MiB envelope
const HEAP_DELTA_LIMIT = 50 * 1024 * 1024; // 50 MiB above baseline

/**
 * Spin up a one-shot HTTP server that streams a 100 MiB multipart/related
 * envelope. The body is generated on-the-fly via res.write() — never
 * materialized in memory all at once on the SERVER side either, so an
 * accidental server-side leak doesn't pollute the test's heap accounting.
 */
async function startStreamingServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': `multipart/related; boundary=${BOUNDARY}`,
    });
    // Re-use one 64 KiB filler buffer; we write it many times.
    const FILLER_SIZE = 64 * 1024;
    const filler = Buffer.alloc(FILLER_SIZE, 0x41); // 'A'
    let partIdx = 0;
    const writePart = (): void => {
      if (partIdx >= PART_COUNT) {
        res.write(`--${BOUNDARY}--\r\n`);
        res.end();
        return;
      }
      // Part header
      res.write(`--${BOUNDARY}\r\n`);
      res.write(`Content-Type: application/octet-stream\r\n`);
      res.write(`Content-ID: <part-${partIdx}>\r\n`);
      res.write(`\r\n`);
      // Body — write FILLER_SIZE chunks until PART_SIZE bytes emitted.
      let written = 0;
      const writeChunk = (): void => {
        while (written < PART_SIZE) {
          const remaining = PART_SIZE - written;
          const chunk =
            remaining >= FILLER_SIZE ? filler : filler.subarray(0, remaining);
          if (!res.write(chunk)) {
            // Backpressure — wait for drain before continuing.
            res.once('drain', writeChunk);
            written += chunk.length;
            return;
          }
          written += chunk.length;
        }
        // Inter-part CRLF.
        res.write(`\r\n`);
        partIdx++;
        // Schedule the next part on a microtask boundary so we don't
        // recurse deeply on the call stack.
        setImmediate(writePart);
      };
      writeChunk();
    };
    writePart();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(addr.port)}/`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}

// Heavy / slow / memory-intensive — gated to the local publish:check run.
const SKIP =
  process.env.RUN_MEMORY_TEST !== '1' && process.env.CI === 'true';

describe.skipIf(SKIP)(
  'memory-bound: 100 MB envelope (T-051, NFR-011) — gated on RUN_MEMORY_TEST=1 in CI',
  () => {
    let server: { url: string; close: () => Promise<void> };

    beforeEach(async () => {
      server = await startStreamingServer();
    });

    afterEach(async () => {
      await server.close();
    });

    it(
      'peak heap delta stays under 50 MiB while draining 100 MiB envelope',
      async () => {
        // Encourage a clean baseline. global.gc is only available with
        // --expose-gc; if it isn't, we accept the noisier baseline.
        const gc = (globalThis as { gc?: () => void }).gc;
        if (gc) gc();
        const baseline = process.memoryUsage().heapUsed;
        let peak = baseline;
        const observePeak = (): void => {
          const cur = process.memoryUsage().heapUsed;
          if (cur > peak) peak = cur;
        };

        const result = await fetchAndHandleMultipart<number>(server.url, {
          idleTimeoutMs: 60_000,
          totalTimeoutMs: 5 * 60_000,
          parser: async (part: StreamingMultipartPart) => {
            // Stream-drain the part body and count bytes — DO NOT use
            // streamToBuffer (would buffer the whole part in memory and
            // defeat the test's purpose).
            let bytes = 0;
            for await (const chunk of part.body as AsyncIterable<Buffer>) {
              bytes += chunk.length;
              // Sample heap every chunk so the peak captures any spikes.
              observePeak();
            }
            return bytes;
          },
        });

        observePeak();
        // Sanity: every part drained to PART_SIZE bytes.
        expect(result.parts.length).toBe(PART_COUNT);
        for (const n of result.parts) {
          expect(n).toBe(PART_SIZE);
        }
        // The envelope total byte count reported by the library is the
        // total source-stream bytes the parser observed (per FR-DR-A-029).
        // The exact value depends on framing accounting and we don't pin
        // it here — heap delta is the contract we care about. We just
        // sanity-check that bytes is in the right order of magnitude
        // (at least ~80% of the body bytes — accounts for any pre-pipe
        // dicer accounting differences without making the test fragile).
        expect(result.bytes).toBeGreaterThan(80 * 1024 * 1024);

        const delta = peak - baseline;
        // The 50 MiB threshold is the documented tunable. If this
        // assertion fails, investigate whether the parser is buffering
        // unexpectedly (the contract is purely streaming).
        expect(delta).toBeLessThan(HEAP_DELTA_LIMIT);
      },
      // Generous timeout: 100 MiB through localhost + parsing on slow
      // machines can take 10-30 s. Keep budget loose.
      120_000,
    );
  },
);
