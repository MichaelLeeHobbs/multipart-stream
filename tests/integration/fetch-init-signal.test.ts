/**
 * Integration tests for `fetchAndHandleMultipart` FR-024 — `fetchInit.signal`
 * is reserved.
 *
 * Covers T-069: setting `fetchInit.signal` (whether or not `options.signal`
 * is also set) MUST throw synchronously with a clear error message.
 *
 * The static `Omit<RequestInit, 'signal'>` on `MultipartHandlerOptions.fetchInit`
 * enforces FR-024 at compile time; the runtime check catches dynamic spreads
 * or `as` consumers who launder past TypeScript. The type-level test below
 * proves the static side; the runtime tests prove the dynamic side.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  fetchAndHandleMultipart,
  type MultipartHandlerOptions,
} from '../../src/index.js';

const TIMEOUTS = { idleTimeoutMs: 5_000, totalTimeoutMs: 60_000 } as const;

describe('fetchAndHandleMultipart — FR-024: fetchInit.signal is reserved (T-069)', () => {
  it('fetchInit.signal alone throws synchronously with a clear error', async () => {
    const ctrl = new AbortController();
    // Cast to launder past the static `Omit<RequestInit, 'signal'>` —
    // we are testing the RUNTIME check, which must catch consumers who
    // bypass the type system via `as any`.
    const opts = {
      ...TIMEOUTS,
      parser: async () => undefined,
      fetchInit: { signal: ctrl.signal } as unknown as Omit<
        RequestInit,
        'signal'
      >,
    };
    await expect(
      fetchAndHandleMultipart('http://127.0.0.1:1/', opts),
    ).rejects.toThrow(/fetchInit\.signal is reserved/);
  });

  it('fetchInit.signal + options.signal both set still throws (FR-024 unconditional)', async () => {
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();
    const opts = {
      ...TIMEOUTS,
      parser: async () => undefined,
      signal: ctrl1.signal,
      fetchInit: { signal: ctrl2.signal } as unknown as Omit<
        RequestInit,
        'signal'
      >,
    };
    await expect(
      fetchAndHandleMultipart('http://127.0.0.1:1/', opts),
    ).rejects.toThrow(/fetchInit\.signal is reserved/);
  });

  it('error message names options.signal as the correct location', async () => {
    const ctrl = new AbortController();
    const opts = {
      ...TIMEOUTS,
      parser: async () => undefined,
      fetchInit: { signal: ctrl.signal } as unknown as Omit<
        RequestInit,
        'signal'
      >,
    };
    await expect(
      fetchAndHandleMultipart('http://127.0.0.1:1/', opts),
    ).rejects.toThrow(/pass signal via options\.signal/);
  });

  it('fetchInit without signal field does NOT throw (other RequestInit fields are fine)', async () => {
    // We don't call fetch here (the URL is invalid) — we only verify
    // the FR-024 guard does NOT fire when `signal` is absent. The error
    // surface should be the network/Content-Type error, NOT the
    // "fetchInit.signal is reserved" message.
    const opts = {
      ...TIMEOUTS,
      parser: async () => undefined,
      fetchInit: {
        method: 'GET',
        headers: { 'X-Custom': 'value' },
      } satisfies Omit<RequestInit, 'signal'>,
    };
    await expect(
      fetchAndHandleMultipart('http://127.0.0.1:1/', opts),
    ).rejects.toThrow();
    // ...but NOT with the FR-024 message.
    let captured: unknown;
    try {
      await fetchAndHandleMultipart('http://127.0.0.1:1/', opts);
    } catch (err) {
      captured = err;
    }
    expect(String((captured as Error).message)).not.toMatch(
      /fetchInit\.signal is reserved/,
    );
  });

  it('fetchInit with explicit signal: undefined still throws (defensive)', async () => {
    // A laundered cast can deliver an undefined signal slot; the
    // implementation guards against `signal !== undefined`, so this
    // case should NOT throw the FR-024 error. Verify the runtime check
    // is correctly conditioned.
    const opts = {
      ...TIMEOUTS,
      parser: async () => undefined,
      fetchInit: { signal: undefined } as unknown as Omit<
        RequestInit,
        'signal'
      >,
    };
    // `signal: undefined` should NOT trip the FR-024 guard (the runtime
    // check explicitly tests `!== undefined`). The call should fail for
    // the network reason instead.
    let captured: unknown;
    try {
      await fetchAndHandleMultipart('http://127.0.0.1:1/', opts);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(String((captured as Error).message)).not.toMatch(
      /fetchInit\.signal is reserved/,
    );
  });
});

describe('fetchAndHandleMultipart — FR-024 type-level enforcement', () => {
  it('MultipartHandlerOptions.fetchInit excludes signal at the type layer', () => {
    type FetchInit = NonNullable<
      MultipartHandlerOptions<unknown>['fetchInit']
    >;
    // Asserting that `signal` is NOT a key of FetchInit.
    expectTypeOf<'signal' extends keyof FetchInit ? true : false>().toEqualTypeOf<false>();
  });

  it("Omit<RequestInit, 'signal'> permits other RequestInit fields", () => {
    type FetchInit = NonNullable<
      MultipartHandlerOptions<unknown>['fetchInit']
    >;
    expectTypeOf<FetchInit>().toMatchTypeOf<{ method?: string }>();
  });
});
