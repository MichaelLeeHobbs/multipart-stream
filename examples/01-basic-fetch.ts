/**
 * Example 01 — `fetchAndHandleMultipart` against an in-process server.
 *
 * Spins up a tiny `node:http` server that serves a real `multipart/related`
 * response (JSON metadata + a small binary blob), runs `fetchAndHandleMultipart`
 * against it, prints the parsed parts, then shuts the server down. Fully
 * self-contained — no external URL required.
 *
 * Run:
 *   pnpm exec tsx examples/01-basic-fetch.ts
 *
 * In your own project:
 *   import {
 *     fetchAndHandleMultipart,
 *     streamToBuffer,
 *     streamToString,
 *   } from '@ubercode/multipart-stream';
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  fetchAndHandleMultipart,
  MultipartIdleTimeoutError,
  MultipartTotalTimeoutError,
  streamToBuffer,
  streamToString,
} from '../src';

interface MetaPart {
  kind: 'meta';
  payload: Record<string, unknown>;
}
interface BlobPart {
  kind: 'blob';
  contentId: string | undefined;
  bytes: number;
}
type Part = MetaPart | BlobPart;

// Synthetic envelope: a JSON metadata part + a 256-byte binary blob.
const blob = Buffer.alloc(256, 0xab);
const envelope = Buffer.concat([
  Buffer.from(
    '--BOUNDARY\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-ID: <meta>\r\n' +
      '\r\n' +
      '{"id":"sample-001","kind":"image","width":640,"height":480}\r\n' +
      '--BOUNDARY\r\n' +
      'Content-Type: image/octet-stream\r\n' +
      'Content-ID: <blob>\r\n' +
      '\r\n',
  ),
  blob,
  Buffer.from('\r\n--BOUNDARY--\r\n'),
]);

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }
  res.writeHead(200, {
    'content-type': 'multipart/related; boundary=BOUNDARY',
    'content-length': String(envelope.length),
  });
  res.end(envelope);
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;
const url = `http://127.0.0.1:${port}/`;

try {
  const result = await fetchAndHandleMultipart<Part>(url, {
    idleTimeoutMs: 30_000,
    totalTimeoutMs: 5 * 60_000,
    onProgress: ({ bytes, rateBps }) => {
      console.warn(`progress: ${bytes} bytes (${Math.round(rateBps)}/s)`);
    },
    parser: async (part) => {
      if (part.contentType?.startsWith('application/json') === true) {
        const text = await streamToString(part.body);
        return { kind: 'meta', payload: JSON.parse(text) as Record<string, unknown> };
      }
      // Cap binary parts at 50 MiB to defend against attacker-controlled sizes.
      const buffer = await streamToBuffer(part.body, { maxBytes: 50 * 1024 * 1024 });
      return { kind: 'blob', contentId: part.contentId, bytes: buffer.length };
    },
  });

  console.warn(
    `received ${result.parts.length} parts in ${result.elapsedMs}ms ` +
      `(${result.bytes} bytes, status ${result.status})`,
  );
  for (const p of result.parts) {
    if (p.kind === 'meta') console.warn('  meta:', p.payload);
    else console.warn(`  blob[${p.contentId ?? '?'}]: ${p.bytes} bytes`);
  }
} catch (err) {
  if (err instanceof MultipartIdleTimeoutError) {
    console.error(`server stalled (idle ${err.idleTimeoutMs}ms exceeded)`);
    process.exitCode = 2;
  } else if (err instanceof MultipartTotalTimeoutError) {
    console.error(`overall budget exceeded (${err.totalTimeoutMs}ms)`);
    process.exitCode = 2;
  } else {
    throw err;
  }
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((closeErr) => (closeErr !== undefined ? reject(closeErr) : resolve()));
  });
}
