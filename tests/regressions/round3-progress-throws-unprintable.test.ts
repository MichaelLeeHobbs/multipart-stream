import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseMultipartRelated, streamToString } from '../../src/index.js';
import { resolveLogger } from '../../src/internal/default-logger.js';

// FR-017: a throwing onProgress is routed to the logger and never breaks the
// operation. summarizeError() claims to be total, but String(value) throws
// for a value with no usable toString (a null-prototype object), so the
// catch block itself throws and the parse fails.
describe('round3: onProgress throwing a value String() cannot convert', () => {
  it('logs the throw and still delivers every part', async () => {
    const body = Buffer.from('--b\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b--\r\n');
    const warnings: string[] = [];
    const bodies: string[] = [];
    for await (const part of parseMultipartRelated(Readable.from([body]), {
      boundary: 'b',
      idleTimeoutMs: 1000,
      totalTimeoutMs: 2000,
      logger: (e) => warnings.push(e.msg),
      onProgress: () => {
        throw Object.create(null);
      },
    })) {
      bodies.push(await streamToString(part.body));
    }
    expect(bodies).toEqual(['hello']);
    expect(warnings.length).toBeGreaterThan(0);
  });

  // resolveLogger promises a throwing logger never escapes (it is called from
  // stream listeners, e.g. the retained late-error path, where an escape is
  // an uncaughtException).
  it('resolveLogger contains a logger that throws a null-prototype object', () => {
    const log = resolveLogger(() => {
      throw Object.create(null);
    });
    expect(() => log({ level: 'warn', msg: 'x' })).not.toThrow();
  });
});
