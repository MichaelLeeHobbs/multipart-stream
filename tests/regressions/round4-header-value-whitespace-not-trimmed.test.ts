/**
 * Round 4: parseHeaders strips at most ONE leading space/tab from a header
 * value and never strips trailing whitespace. Optional whitespace around a
 * field value is not part of the value (RFC 5322 / RFC 9110 OWS; Node's
 * http parser trims both ends), so `contentType` / `contentId` / `headers`
 * carry stray whitespace and the documented checks
 * (`part.contentType.startsWith('application/json')` in the README,
 * `part.contentType === 'application/json'` in kiln/spec/api.md) fail.
 * `contentLength` alone is `.trim()`med, which shows the intent.
 */
import { Readable } from 'node:stream';

import { expect, it } from 'vitest';

import { parseMultipartRelated, type StreamingMultipartPart } from '../../src/index.js';

it('trims optional whitespace around part header values', async () => {
  const env =
    '--b\r\nContent-Type:  application/json \r\nContent-ID:\t<a@b> \r\nContent-Length: 2\r\n\r\n{}\r\n--b--';
  const parts: StreamingMultipartPart[] = [];
  for await (const part of parseMultipartRelated(Readable.from([Buffer.from(env)]), {
    boundary: 'b',
    idleTimeoutMs: 1000,
    totalTimeoutMs: 2000,
  })) {
    parts.push(part);
    part.body.resume();
  }
  expect(parts).toHaveLength(1);
  const part = parts[0]!;
  expect(part.contentLength).toBe(2);
  expect(part.contentType.startsWith('application/json')).toBe(true);
  expect(part.contentType).toBe('application/json');
  expect(part.contentId).toBe('<a@b>');
});
