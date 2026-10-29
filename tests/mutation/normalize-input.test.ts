import { describe, expect, it } from 'vitest';

import { normalizeInput } from '../../src/internal/normalize-input.js';

describe('normalizeInput: shape checks', () => {
  const methods = ['pipe', 'unpipe', 'on', 'off', 'destroy'] as const;
  const readableLike = (omit?: string): Record<string, unknown> =>
    Object.fromEntries(methods.filter((m) => m !== omit).map((m) => [m, () => undefined]));

  it.each(methods)('rejects a Readable lookalike without %s', (omit) => {
    expect(() => normalizeInput(readableLike(omit), { boundary: 'B' })).toThrow(
      'multipart: input must be a Response or a Node Readable',
    );
  });

  it('accepts a Readable lookalike with every method', () => {
    expect(normalizeInput(readableLike(), { boundary: 'B' }).kind).toBe('readable');
  });

  it.each([
    ['headers missing', { body: null }],
    ['headers null', { headers: null, body: null }],
    ['headers.get not a function', { headers: { get: 'x' }, body: null }],
    [
      'headers a function',
      { headers: Object.assign(() => null, { get: (): null => null }), body: null },
    ],
    ['body missing', { headers: { get: (): null => null } }],
  ])('does not treat an object with %s as a Response', (_name, input) => {
    expect(() => normalizeInput(input, {})).toThrow(
      'multipart: input must be a Response or a Node Readable',
    );
  });

  it('rejects callable inputs even when they carry the right members', () => {
    const response = Object.assign(() => undefined, { headers: { get: () => null }, body: null });
    const readable = Object.assign(() => undefined, readableLike());
    expect(() => normalizeInput(response, {})).toThrow(/must be a Response or a Node Readable/);
    expect(() => normalizeInput(readable, { boundary: 'B' })).toThrow(
      /must be a Response or a Node Readable/,
    );
  });
});
