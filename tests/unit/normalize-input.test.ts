import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { normalizeInput } from '../../src/internal/normalize-input.js';

describe('normalizeInput — Response branch', () => {
  it('extracts boundary from a valid Response Content-Type', () => {
    const res = new Response('ignored', {
      headers: { 'content-type': 'multipart/related; boundary=foo' },
    });
    const got = normalizeInput(res, {});
    expect(got.kind).toBe('response');
    expect(got.boundary).toBe('foo');
    expect(typeof got.readable.pipe).toBe('function');
  });

  it('throws on null body', () => {
    const res = new Response(null, {
      headers: { 'content-type': 'multipart/related; boundary=foo' },
    });
    expect(() => normalizeInput(res, {})).toThrow(/response body is null/);
  });

  it('throws when Content-Type is missing', () => {
    // We can't use `new Response('x', { headers: {} })` here — the WHATWG
    // fetch implementation auto-stamps `text/plain;charset=UTF-8` onto
    // headerless string-body responses. Construct a minimal Response-shape
    // duck-type whose `headers.get('content-type')` returns null instead.
    const fake = {
      headers: {
        get: (name: string): string | null => {
          void name;
          return null;
        },
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
    };
    expect(() => normalizeInput(fake, {})).toThrow(
      /Content-Type header is required/,
    );
  });

  it('throws when Content-Type lacks a boundary parameter', () => {
    const res = new Response('x', {
      headers: { 'content-type': 'multipart/related' },
    });
    expect(() => normalizeInput(res, {})).toThrow(
      /boundary parameter missing/,
    );
  });
});

describe('normalizeInput — Readable branch', () => {
  it('passes through a Readable when boundary is supplied', () => {
    const readable = Readable.from(Buffer.from('x'));
    const got = normalizeInput(readable, { boundary: 'BAR' });
    expect(got.kind).toBe('readable');
    expect(got.boundary).toBe('BAR');
    expect(got.readable).toBe(readable);
  });

  it('throws when Readable input has no boundary option', () => {
    const readable = Readable.from(Buffer.from('x'));
    expect(() => normalizeInput(readable, {})).toThrow(
      /boundary option is required when input is a Readable/,
    );
  });

  it('throws when Readable input has empty-string boundary', () => {
    const readable = Readable.from(Buffer.from('x'));
    expect(() => normalizeInput(readable, { boundary: '' })).toThrow(
      /boundary option is required when input is a Readable/,
    );
  });
});

describe('normalizeInput — invalid input', () => {
  it('throws on non-Response, non-Readable input', () => {
    expect(() => normalizeInput({}, {})).toThrow(
      /input must be a Response or a Node Readable/,
    );
  });

  it('throws on null/undefined input', () => {
    expect(() => normalizeInput(null, {})).toThrow(
      /input must be a Response or a Node Readable/,
    );
  });
});
