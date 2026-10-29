import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultLogger } from '../../src/internal/default-logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('defaultLogger', () => {
  it('calls console.warn with the message alone when meta is absent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    defaultLogger({ level: 'warn', msg: 'hello' });
    expect(warn.mock.calls).toEqual([['hello']]);
  });

  it('passes meta as the second argument when present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    defaultLogger({ level: 'warn', msg: 'hello', meta: { a: 1 } });
    expect(warn.mock.calls).toEqual([['hello', { a: 1 }]]);
  });
});
