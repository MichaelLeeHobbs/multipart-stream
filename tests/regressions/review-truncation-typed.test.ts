import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { MultipartTruncatedError, parseMultipartRelated, streamToString } from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const boundary = 'B';

describe('review: truncation always surfaces as MultipartTruncatedError', () => {
  it('a body cut mid-part, read through streamToString, rejects with the typed error', async () => {
    const envelope = buildMultipartBody({
      boundary,
      parts: [
        { headers: { 'Content-Type': 'text/plain' }, body: 'a'.repeat(50) },
        { headers: { 'Content-Type': 'text/plain' }, body: 'b'.repeat(50) },
      ],
    });
    const cut = envelope.subarray(0, envelope.length - 30);
    const run = async (): Promise<void> => {
      for await (const part of parseMultipartRelated(Readable.from([cut]), {
        idleTimeoutMs: 5_000,
        totalTimeoutMs: 10_000,
        boundary,
      })) {
        await streamToString(part.body);
      }
    };
    await expect(run()).rejects.toBeInstanceOf(MultipartTruncatedError);
  });
});
