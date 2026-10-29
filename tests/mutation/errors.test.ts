import { describe, expect, it } from 'vitest';

import {
  MultipartHeadersTooLargeError,
  MultipartPartTooLargeError,
  MultipartTooManyPartsError,
} from '../../src/index.js';

describe('error messages (kiln/spec/api.md)', () => {
  it('formats MultipartPartTooLargeError', () => {
    const err = new MultipartPartTooLargeError({
      maxPartBytes: 10,
      partIndex: 2,
      bytesReceived: 11,
    });
    expect(err.message).toBe('multipart: part 2 exceeded maxPartBytes (10) at 11B');
  });

  it('formats MultipartHeadersTooLargeError', () => {
    const err = new MultipartHeadersTooLargeError({
      limit: 'bytes',
      partIndex: 1,
      cap: 64,
      observed: 70,
    });
    expect(err.message).toBe('multipart: part 1 headers exceeded bytes cap (64) at 70');
  });

  it('formats MultipartTooManyPartsError', () => {
    const err = new MultipartTooManyPartsError({ maxParts: 3, observed: 4 });
    expect(err.message).toBe('multipart: envelope exceeded maxParts (3) at part 4');
  });
});
