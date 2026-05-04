import { describe, expect, it } from 'vitest';

import {
  flattenDicerHeaders,
  flattenHeaderValue,
} from '../../src/internal/flatten-headers.js';

describe('flattenHeaderValue', () => {
  it('returns empty string for null/undefined', () => {
    expect(flattenHeaderValue(undefined)).toBe('');
    expect(flattenHeaderValue(null)).toBe('');
  });

  it('passes through plain strings', () => {
    expect(flattenHeaderValue('text/plain')).toBe('text/plain');
  });

  it('decodes a Buffer as utf8', () => {
    expect(flattenHeaderValue(Buffer.from('application/json', 'utf8'))).toBe(
      'application/json',
    );
  });

  it('joins an array of strings with ", "', () => {
    expect(flattenHeaderValue(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('joins an array of Buffers with ", "', () => {
    expect(
      flattenHeaderValue([Buffer.from('a'), Buffer.from('b')]),
    ).toBe('a, b');
  });

  it('handles nested arrays (Buffer[][] / string[][])', () => {
    expect(flattenHeaderValue([['a', 'b'], ['c']])).toBe('a, b, c');
  });

  it('drops empty entries from arrays', () => {
    expect(flattenHeaderValue(['a', '', 'b'])).toBe('a, b');
    expect(flattenHeaderValue([null, 'a', undefined, 'b'])).toBe('a, b');
  });
});

describe('flattenDicerHeaders', () => {
  it('returns {} for undefined input', () => {
    expect(flattenDicerHeaders(undefined)).toEqual({});
  });

  it('lowercases keys and collapses values', () => {
    const got = flattenDicerHeaders({
      'CONTENT-TYPE': ['application/json'],
      'Content-Id': ['<meta>'],
      'X-Custom': 'plain',
    });
    expect(got).toEqual({
      'content-type': 'application/json',
      'content-id': '<meta>',
      'x-custom': 'plain',
    });
  });

  it('handles dicer 0.3.1 native shape (Record<string, string[]>)', () => {
    const got = flattenDicerHeaders({
      'content-type': ['text/plain'],
    });
    expect(got['content-type']).toBe('text/plain');
  });
});
