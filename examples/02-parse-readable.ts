/**
 * Example 02 — `parseMultipartRelated` against a raw Node `Readable`.
 *
 * Useful for non-fetch sources: server-side request bodies, file streams,
 * piped subprocess stdout, etc. The boundary is explicit (no `Content-Type`
 * header to extract from), and the source is consumed lazily — no buffering.
 *
 * Run:
 *   pnpm build
 *   pnpm exec tsx examples/02-parse-readable.ts
 *
 * In your own project:
 *   import { parseMultipartRelated, streamToString } from '@ubercode/multipart-stream';
 */
import { Readable } from 'node:stream';

import { parseMultipartRelated, streamToString } from '../src';

// Synthesize a 2-part envelope. In real code, this would be `req` from an
// http server, or a stream from elsewhere.
const envelope = Buffer.from(
  '--BOUNDARY\r\n' +
    'Content-Type: application/json\r\n' +
    'Content-ID: <meta>\r\n' +
    '\r\n' +
    '{"kind":"sample","version":1}\r\n' +
    '--BOUNDARY\r\n' +
    'Content-Type: text/plain\r\n' +
    'Content-ID: <body>\r\n' +
    '\r\n' +
    'hello world\r\n' +
    '--BOUNDARY--\r\n',
);

const source = Readable.from(envelope);

for await (const part of parseMultipartRelated(source, {
  boundary: 'BOUNDARY',
  idleTimeoutMs: 5_000,
  totalTimeoutMs: 30_000,
})) {
  const body = await streamToString(part.body);
  // eslint-disable-next-line no-console
  console.log(
    `part ${part.index} (${part.contentId ?? '?'}, ${part.contentType ?? '?'}): ${body}`,
  );
}
