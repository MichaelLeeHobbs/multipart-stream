import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  HeaderLimitError,
  type HeaderLimits,
  MultipartParser,
  type MultipartPartStream,
  type PartHeaders,
  UnexpectedEndError,
} from '../../src/internal/multipart-parser.js';

const LIMITS: HeaderLimits = { maxHeaderPairs: 100, maxHeaderBytes: 16_384 };

interface ParsedPart {
  headers: PartHeaders | undefined;
  rawHeaders: Buffer | undefined;
  body: Buffer;
}

interface ParseResult {
  parts: ParsedPart[];
  error: Error | undefined;
}

/** Feeds `chunks` to a parser and drains every part body as it arrives. */
function parse(
  chunks: readonly (Buffer | string)[],
  limits: HeaderLimits = LIMITS,
  boundary = 'B',
): Promise<ParseResult> {
  const parser = new MultipartParser(boundary, limits);
  const parts: ParsedPart[] = [];
  parser.on('part', (part: MultipartPartStream) => {
    const entry: ParsedPart = { headers: undefined, rawHeaders: undefined, body: Buffer.alloc(0) };
    parts.push(entry);
    part.once('header', (headers: PartHeaders, raw: Buffer) => {
      entry.headers = headers;
      entry.rawHeaders = raw;
    });
    part.on('data', (chunk: Buffer) => {
      entry.body = Buffer.concat([entry.body, chunk]);
    });
  });
  return new Promise((resolve) => {
    parser.on('finish', () => resolve({ parts, error: undefined }));
    parser.on('error', (error: Error) => resolve({ parts, error }));
    Readable.from(chunks.map((c) => Buffer.from(c))).pipe(parser);
  });
}

function bytewise(input: string | Buffer): Buffer[] {
  const buf = Buffer.from(input);
  return Array.from({ length: buf.length }, (_, i) => buf.subarray(i, i + 1));
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('MultipartParser: delimiter classification', () => {
  // Each body holds a `CRLF--B` match whose suffix is NOT `--`? LWSP* CRLF.
  const falseDelimiters = [
    ['dash after a non-dash', 'x-\r\nafter'],
    ['LF without CR', 'x\nafter'],
    ['CR without LF', '\rXafter'],
  ] as const;

  for (const [name, suffix] of falseDelimiters) {
    const body = `head\r\n--B${suffix}`;
    const envelope = `--B\r\n\r\n${body}\r\n--B--\r\n`;

    it(`keeps a false boundary (${name}) as body data in one chunk`, async () => {
      const result = await parse([envelope]);
      expect(result.error).toBeUndefined();
      expect(result.parts.map((p) => p.body.toString('latin1'))).toEqual([body]);
    });

    it(`keeps a false boundary (${name}) as body data byte by byte`, async () => {
      const result = await parse(bytewise(envelope));
      expect(result.error).toBeUndefined();
      expect(result.parts.map((p) => p.body.toString('latin1'))).toEqual([body]);
    });
  }

  it('does not treat a lone `-` after the boundary as a close at EOF', async () => {
    const result = await parse(['--B\r\n\r\nbody\r\n--B-']);
    expect(result.error).toBeInstanceOf(UnexpectedEndError);
  });

  it('does not accept a close delimiter followed by junk at EOF', async () => {
    const result = await parse(['--B\r\n\r\nbody\r\n--B--x']);
    expect(result.error).toBeInstanceOf(UnexpectedEndError);
  });

  it('releases false-match bytes to the body without waiting for more input', async () => {
    const parser = new MultipartParser('B', LIMITS);
    const received: Buffer[] = [];
    parser.on('part', (part: MultipartPartStream) => {
      part.on('data', (chunk: Buffer) => received.push(chunk));
    });
    parser.write(Buffer.from('--B\r\n\r\nab\r\n--Bx'));
    await tick();
    expect(Buffer.concat(received).toString()).toBe('ab\r\n--Bx');
    parser.destroy();
  });

  it('treats whitespace that fills the whole padding window as body data', async () => {
    // `CRLF--B` + MAX_SUFFIX (1028) spaces cannot be a delimiter.
    const body = `a\r\n--B${' '.repeat(1028)}X`;
    const result = await parse([`--B\r\n\r\n${body}\r\n--B--\r\n`]);
    expect(result.error).toBeUndefined();
    expect(result.parts.map((p) => p.body.toString())).toEqual([body]);
  });

  it('bounds the padding window when it spans two chunks', async () => {
    // One space arrives with the boundary; the rest of the run (1027 more
    // spaces) exceeds the window, so the CRLF after it is body data.
    const first = '--B\r\n\r\na\r\n--B ';
    const second = `${' '.repeat(1027)}\r\nX\r\n--B--\r\n`;
    const result = await parse([first, second]);
    expect(result.error).toBeUndefined();
    expect(result.parts.map((p) => p.body.toString())).toEqual([
      `a\r\n--B${' '.repeat(1028)}\r\nX`,
    ]);
  });
});

describe('MultipartParser: header parsing', () => {
  const envelopeWith = (headerBlock: string): string =>
    `--B\r\n${headerBlock}\r\n\r\nbody\r\n--B--\r\n`;

  it('lowercases header names and keeps repeated values in order', async () => {
    const result = await parse([envelopeWith('X-Foo: one\r\nx-FOO: two\r\nContent-Type: a/b')]);
    expect(result.error).toBeUndefined();
    expect({ ...result.parts[0]?.headers }).toEqual({
      'x-foo': ['one', 'two'],
      'content-type': ['a/b'],
    });
  });

  it('appends a folded line to the previous value', async () => {
    const result = await parse([envelopeWith('X-A: one\r\n two\r\n\tthree\r\nX-B: b')]);
    expect(result.error).toBeUndefined();
    expect({ ...result.parts[0]?.headers }).toEqual({
      'x-a': ['one two\tthree'],
      'x-b': ['b'],
    });
  });

  it('strips exactly one leading space or tab and keeps inner whitespace', async () => {
    const result = await parse([envelopeWith('X-A:a b\r\nX-B:  c\r\nX-C:\td e')]);
    expect({ ...result.parts[0]?.headers }).toEqual({
      'x-a': ['a b'],
      'x-b': [' c'],
      'x-c': ['d e'],
    });
  });

  it.each([
    ['a line without a colon', 'NoColonHere'],
    ['an empty name', ': value'],
    ['a name with a space', 'Bad Name: x'],
    ['a name with a separator before valid chars', '(X-A: x'],
    ['a name with a separator after valid chars', 'X-A): x'],
    ['a control character in the value', 'X-A: a\x01b'],
    ['a bare LF in the value', 'X-A: a\nb'],
  ])('rejects %s', async (_name, block) => {
    const result = await parse([envelopeWith(block)]);
    expect(result.error?.message).toBe('Malformed part header');
  });

  it('rejects a boundary that arrives inside a header block', async () => {
    const result = await parse(['--B\r\nX-A: a\r\n--B--\r\n']);
    expect(result.error?.message).toBe('Malformed part header');
  });

  it('rejects a block whose terminator lands just past maxHeaderBytes', async () => {
    // 'X-A: abc' + CRLFCRLF is 12 bytes; the scan window reaches 10 + 4.
    const result = await parse([envelopeWith('X-A: abc')], {
      maxHeaderPairs: 100,
      maxHeaderBytes: 10,
    });
    expect(result.error).toBeInstanceOf(HeaderLimitError);
    expect(result.error).toMatchObject({ limit: 'bytes', observed: 12 });
  });

  it('accepts a block of exactly maxHeaderBytes', async () => {
    const result = await parse([envelopeWith('X-A: abc')], {
      maxHeaderPairs: 100,
      maxHeaderBytes: 12,
    });
    expect(result.error).toBeUndefined();
    expect(result.parts[0]?.rawHeaders?.toString()).toBe('X-A: abc\r\n\r\n');
  });

  it('never buffers more than maxHeaderBytes plus the terminator across chunks', async () => {
    const result = await parse(['--B\r\nX-A: 012345', 'a'.repeat(1000)], {
      maxHeaderPairs: 100,
      maxHeaderBytes: 64,
    });
    expect(result.error).toBeInstanceOf(HeaderLimitError);
    const observed = (result.error as HeaderLimitError).observed;
    expect(observed).toBeGreaterThan(64);
    expect(observed).toBeLessThanOrEqual(64 + 4);
  });

  it('applies the byte cap to header bytes still held at EOF', async () => {
    // 'X:a' is reported; the trailing CRLF is held back until end of input.
    const result = await parse(['--B\r\nX:a\r\n'], { maxHeaderPairs: 100, maxHeaderBytes: 4 });
    expect(result.error).toBeInstanceOf(HeaderLimitError);
    expect(result.error).toMatchObject({ limit: 'bytes' });
  });

  it('emits the headers of a part whose block completed right before EOF', async () => {
    const result = await parse(['--B\r\nX-A: a\r\n\r\n']);
    expect(result.error).toBeInstanceOf(UnexpectedEndError);
    expect(result.parts).toHaveLength(1);
    expect({ ...result.parts[0]?.headers }).toEqual({ 'x-a': ['a'] });
  });

  it('requires a non-empty boundary', () => {
    expect(() => new MultipartParser('', LIMITS)).toThrow(TypeError);
  });
});

describe('MultipartParser: backpressure', () => {
  const big = Buffer.alloc(64 * 1024, 0x61);

  it('withholds the write callback until a full part body is read', async () => {
    const parser = new MultipartParser('B', LIMITS);
    let part: MultipartPartStream | undefined;
    parser.on('part', (p: MultipartPartStream) => {
      part = p;
    });
    let written = false;
    parser.write(Buffer.concat([Buffer.from('--B\r\n\r\n'), big]), () => {
      written = true;
    });
    await tick();
    expect(written).toBe(false);
    part?.resume();
    await tick();
    expect(written).toBe(true);
    parser.destroy();
  });

  it('is not resumed by reading an earlier, already complete part', async () => {
    const parser = new MultipartParser('B', LIMITS);
    const parts: MultipartPartStream[] = [];
    parser.on('part', (p: MultipartPartStream) => parts.push(p));
    let written = false;
    const chunk = Buffer.concat([Buffer.from('--B\r\n\r\nsmall\r\n--B\r\n\r\n'), big]);
    parser.write(chunk, () => {
      written = true;
    });
    await tick();
    expect(parts).toHaveLength(2);
    const [first, second] = parts;
    first?.resume();
    await new Promise((resolve) => first?.once('end', resolve));
    await tick();
    expect(written).toBe(false);
    second?.resume();
    await tick();
    expect(written).toBe(true);
    parser.destroy();
  });
});
