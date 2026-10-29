import { PassThrough, Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MultipartIdleTimeoutError,
  MultipartTruncatedError,
  type ParseMultipartOptions,
  parseMultipartRelated,
  type ProgressSnapshot,
  type StreamingMultipartPart,
  streamToString,
} from '../../src/index.js';
import { buildMultipartBody } from '../fixtures/multipart-builders.js';

const timeouts = { idleTimeoutMs: 5_000, totalTimeoutMs: 10_000 } as const;

function envelope(parts: { headers: Record<string, string>; body: string }[]): Buffer {
  return buildMultipartBody({ boundary: 'B', parts });
}

async function collect(
  input: Readable,
  opts: Partial<Omit<ParseMultipartOptions, 'boundary'>> = {},
): Promise<{ part: StreamingMultipartPart; body: string }[]> {
  const out: { part: StreamingMultipartPart; body: string }[] = [];
  for await (const part of parseMultipartRelated(input, { ...timeouts, boundary: 'B', ...opts })) {
    out.push({ part, body: await streamToString(part.body) });
  }
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseMultipartRelated: option validation', () => {
  it.each(['maxPartBytes', 'maxParts', 'maxHeadersPerPart', 'maxHeaderBytesPerPart'])(
    'names %s when it is invalid',
    async (name) => {
      await expect(collect(Readable.from([]), { [name]: 0 })).rejects.toThrow(
        new RegExp(`^multipart: ${name} must be a positive safe integer`),
      );
    },
  );
});

describe('parseMultipartRelated: logger safety', () => {
  it('reports a throwing caller logger to the default sink', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = vi.fn(() => {
      throw new Error('logger broke');
    });
    const result = await collect(Readable.from([envelope([{ headers: {}, body: 'x' }])]), {
      logger,
      onProgress: () => {
        throw new Error('progress broke');
      },
    });
    expect(result.map((r) => r.body)).toEqual(['x']);
    expect(logger).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('multipart: logger threw', {
      event: 'multipart: onProgress threw',
      errSummary: { name: 'Error', message: '"logger broke"' },
    });
  });

  it('logs a failed cancel of an unusable Response body', async () => {
    const logger = vi.fn();
    const body = new ReadableStream({
      cancel() {
        throw new Error('cancel failed');
      },
    });
    const response = { headers: { get: (): null => null }, body };
    const iterator = parseMultipartRelated(response as unknown as Response, {
      ...timeouts,
      logger,
    });
    await expect(iterator.next()).rejects.toThrow(/Content-Type header is required/);
    await vi.waitFor(() => {
      expect(logger).toHaveBeenCalledWith({
        level: 'warn',
        msg: 'multipart: cancelling the response body failed',
        meta: { errSummary: { name: 'Error', message: '"cancel failed"' } },
      });
    });
  });
});

describe('parseMultipartRelated: part fields', () => {
  it.each([
    [' 12 ', 12],
    ['12abc', undefined],
    ['abc12', undefined],
  ])('parses Content-Length %j as %j', async (value, expected) => {
    const [first] = await collect(
      Readable.from([envelope([{ headers: { 'Content-Length': value }, body: 'x' }])]),
    );
    expect(first?.part.contentLength).toBe(expected);
  });
});

describe('parseMultipartRelated: progress', () => {
  it('reports elapsed time from the call and the byte rate', async () => {
    const start = 1_000_000;
    let now = start;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const data = envelope([{ headers: {}, body: 'x'.repeat(100) }]);
    const snapshots: ProgressSnapshot[] = [];
    const iterator = parseMultipartRelated(Readable.from([data]), {
      ...timeouts,
      boundary: 'B',
      onProgress: (snap) => snapshots.push(snap),
    });
    const first = await iterator.next();
    now = start + 2_000;
    if (!first.done) await streamToString(first.value.body);
    await iterator.next();
    const last = snapshots.at(-1);
    expect(last).toEqual({
      bytes: data.length,
      elapsedMs: 2_000,
      rateBps: Math.round((data.length * 1000) / 2_000),
    });
  });

  it('reports a zero rate when no time has elapsed', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const snapshots: ProgressSnapshot[] = [];
    await collect(Readable.from([envelope([{ headers: {}, body: 'x' }])]), {
      onProgress: (snap) => snapshots.push(snap),
    });
    expect(snapshots.at(-1)).toMatchObject({ elapsedMs: 0, rateBps: 0 });
  });
});

describe('parseMultipartRelated: source lifecycle', () => {
  const head = '--B\r\n\r\nfirst';

  it('reports a source destroyed without end as truncation', async () => {
    const source = new PassThrough();
    source.write(head);
    setTimeout(() => source.destroy(), 10);
    await expect(
      collect(source, { idleTimeoutMs: 1_000, totalTimeoutMs: 5_000 }),
    ).rejects.toBeInstanceOf(MultipartTruncatedError);
  });

  it('destroys the source as soon as the operation fails', async () => {
    const source = new PassThrough();
    const iterator = parseMultipartRelated(source, {
      idleTimeoutMs: 30,
      totalTimeoutMs: 5_000,
      boundary: 'B',
    });
    source.write(head);
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(source.destroyed).toBe(true);
    await expect(iterator.next()).rejects.toBeInstanceOf(MultipartIdleTimeoutError);
  });

  it('destroys the source and logs nothing when the consumer stops early', async () => {
    const logger = vi.fn();
    const source = new PassThrough();
    source.write(head);
    for await (const part of parseMultipartRelated(source, {
      ...timeouts,
      boundary: 'B',
      logger,
    })) {
      void part;
      break;
    }
    expect(source.destroyed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logger).not.toHaveBeenCalled();
  });

  it('logs nothing when the consumer stops early on a capped body', async () => {
    const logger = vi.fn();
    const source = new PassThrough();
    source.write(head);
    for await (const part of parseMultipartRelated(source, {
      ...timeouts,
      boundary: 'B',
      logger,
      maxPartBytes: 1_000,
    })) {
      void part;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(logger).not.toHaveBeenCalled();
  });

  it('does not log a late error that follows an earlier failure', async () => {
    const logger = vi.fn();
    const source = new PassThrough();
    source.write(head);
    const iterator = parseMultipartRelated(source, { ...timeouts, boundary: 'B', logger });
    await iterator.next();
    source.destroy(new Error('first'));
    await expect(iterator.next()).rejects.toThrow('first');
    source.emit('error', new Error('late'));
    expect(logger).not.toHaveBeenCalled();
  });

  it('stops the idle timer once the source has ended', async () => {
    const data = envelope([{ headers: {}, body: 'x' }]);
    const iterator = parseMultipartRelated(Readable.from([data]), {
      idleTimeoutMs: 30,
      totalTimeoutMs: 5_000,
      boundary: 'B',
    });
    const first = await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (!first.done) expect(await streamToString(first.value.body)).toBe('x');
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});

describe('parseMultipartRelated: part bodies', () => {
  const twoParts = (): Readable =>
    Readable.from([
      envelope([
        { headers: {}, body: 'one' },
        { headers: {}, body: 'two' },
      ]),
    ]);

  it('fails the operation with the error a consumer destroys a body with', async () => {
    const failure = new Error('consumer gave up');
    const run = async (): Promise<void> => {
      for await (const part of parseMultipartRelated(twoParts(), { ...timeouts, boundary: 'B' })) {
        part.body.destroy(failure);
      }
    };
    await expect(run()).rejects.toBe(failure);
  });

  it('continues past a capped body the consumer skips', async () => {
    const source = new PassThrough();
    const data = envelope([
      { headers: {}, body: 'one' },
      { headers: {}, body: 'two' },
    ]);
    const split = data.indexOf('two');
    source.write(data.subarray(0, split));
    const seen: string[] = [];
    for await (const part of parseMultipartRelated(source, {
      ...timeouts,
      boundary: 'B',
      maxPartBytes: 1_000,
    })) {
      if (part.index === 0) {
        part.body.destroy();
        setTimeout(() => source.end(data.subarray(split)), 20);
      } else {
        seen.push(await streamToString(part.body));
      }
    }
    expect(seen).toEqual(['two']);
  });

  it('keeps a complete body readable after a later failure', async () => {
    const source = new PassThrough();
    source.end(`--B\r\n\r\none\r\n--B\r\n\r\ntruncated`);
    const iterator = parseMultipartRelated(source, { ...timeouts, boundary: 'B' });
    const first = await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!first.done) expect(await streamToString(first.value.body)).toBe('one');
    const second = await iterator.next();
    if (!second.done) {
      await expect(streamToString(second.value.body)).rejects.toBeInstanceOf(
        MultipartTruncatedError,
      );
    }
    await iterator.return();
  });
});
