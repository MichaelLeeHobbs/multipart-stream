import { describe, expect, it } from 'vitest';

import { extractBoundary } from '../../src/index.js';

describe('extractBoundary: parameter scanning', () => {
  it.each([
    ['ignores a boundary=-looking media type', 'boundary=wrong; boundary=right', 'right'],
    ['ends a parameter name at a tab', 'multipart/related; boundary\t=abc', 'abc'],
    ['skips spaces and tabs after =', 'multipart/related; boundary= \tabc', 'abc'],
    ['ends a bare value at a tab', 'multipart/related; boundary=abc\tdef', 'abc'],
    ['skips a flag-only parameter', 'multipart/related; charset; boundary=abc', 'abc'],
    [
      'skips the rest of a flag parameter up to the next ;',
      'multipart/related; x boundary=wrong; boundary=right',
      'right',
    ],
    [
      'skips trailing junk after another parameter value',
      'multipart/related; type=a boundary=wrong; boundary=right',
      'right',
    ],
    [
      'skips trailing junk after a quoted parameter value',
      'multipart/related; type="a"boundary=wrong; boundary=right',
      'right',
    ],
    [
      'keeps a trailing backslash in an unterminated quote',
      'multipart/related; boundary="ab\\',
      'ab\\',
    ],
  ])('%s', (_name, header, expected) => {
    expect(extractBoundary(header)).toBe(expected);
  });
});
