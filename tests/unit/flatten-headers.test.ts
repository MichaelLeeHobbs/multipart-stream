import { describe, expect, it } from 'vitest';

import { flattenPartHeaders } from '../../src/internal/flatten-headers.js';

describe('flattenPartHeaders', () => {
  it('returns an empty bag for no headers', () => {
    expect(Object.keys(flattenPartHeaders({}))).toEqual([]);
  });

  it('lowercases keys and joins repeated values with ", "', () => {
    const got = flattenPartHeaders({
      'CONTENT-TYPE': ['application/json'],
      'x-multi': ['a', 'b', 'c'],
    });
    expect({ ...got }).toEqual({
      'content-type': 'application/json',
      'x-multi': 'a, b, c',
    });
  });

  it('keeps empty repeated values', () => {
    expect(flattenPartHeaders({ x: ['a', ''] }).x).toBe('a, ');
    expect(flattenPartHeaders({ x: [''] }).x).toBe('');
  });

  // Bracket access on purpose: on an ordinary object `.__proto__` is the
  // prototype accessor, which is exactly what this test must not touch.
  /* eslint-disable @typescript-eslint/dot-notation */
  it('stores __proto__ as data and inherits nothing', () => {
    const raw = Object.create(null) as Record<string, string[]>;
    raw['__proto__'] = ['x'];
    const got = flattenPartHeaders(raw);
    expect(Object.getPrototypeOf(got)).toBeNull();
    expect(Object.keys(got)).toEqual(['__proto__']);
    expect(got['__proto__']).toBe('x');
    expect(got['constructor']).toBeUndefined();
  });
  /* eslint-enable @typescript-eslint/dot-notation */
});
