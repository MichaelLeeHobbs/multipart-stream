/**
 * Round 4: a delimiter-looking match whose suffix is still pending (a lone
 * "-", which might become the "--" of a close delimiter) loses one copy of
 * the matched needle when a SECOND needle match arrives before the pending
 * suffix is resolved. MultipartParser's streamsearch callback sets
 * `candidate = true` on the second match without first resolving the
 * pending suffix of the first, so the first match's "\r\n--<boundary>"
 * bytes are dropped (body corruption) and, when the second match is a real
 * delimiter, that delimiter is swallowed as body data (parts merge or the
 * close delimiter is missed).
 */
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToString } from '../../src/index.js';

const B = 'BOUNDARY';

async function collect(envelope: string): Promise<string[]> {
  const bodies: string[] = [];
  for await (const part of parseMultipartRelated(Readable.from([Buffer.from(envelope, 'latin1')]), {
    boundary: B,
    idleTimeoutMs: 1000,
    totalTimeoutMs: 2000,
  })) {
    bodies.push(await streamToString(part.body, 'latin1'));
  }
  return bodies;
}

describe('pending "-" suffix followed by another needle match', () => {
  it('keeps both non-delimiter matches as body bytes', async () => {
    // Both "\r\n--BOUNDARY-" and "\r\n--BOUNDARYZ" are NOT delimiters, so
    // the parser's tolerant mode should keep them verbatim as body data.
    const body = `a\r\n--${B}-\r\n--${B}Z`;
    const env = `--${B}\r\n\r\n${body}\r\n--${B}--\r\n`;
    expect(await collect(env)).toEqual([body]);
  });

  it('still recognises the real delimiter that follows a body ending in "\\r\\n--BOUNDARY-"', async () => {
    const first = `a\r\n--${B}-`;
    const env = `--${B}\r\n\r\n${first}\r\n--${B}\r\n\r\nsecond\r\n--${B}--\r\n`;
    expect(await collect(env)).toEqual([first, 'second']);
  });
});
