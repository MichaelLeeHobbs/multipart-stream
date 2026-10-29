import { describe, expect, it } from 'vitest';

import { validateOptionalCap } from '../../src/internal/validate-timeout.js';

describe('validateOptionalCap', () => {
  it.each([
    [0, 'got 0'],
    [-3, 'got -3'],
    [1.5, 'got 1.5'],
    ['5', 'got string'],
    [null, 'got object'],
  ])('rejects %j and reports it as %s', (value, observed) => {
    expect(() => validateOptionalCap('maxParts', value)).toThrow(
      new TypeError(`multipart: maxParts must be a positive safe integer when set; ${observed}`),
    );
  });

  it('accepts 1 and leaves undefined unset', () => {
    expect(validateOptionalCap('maxParts', 1)).toBe(1);
    expect(validateOptionalCap('maxParts', undefined)).toBeUndefined();
  });
});
