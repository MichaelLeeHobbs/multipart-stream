import { Readable, Writable } from 'node:stream';

import StreamSearch from 'streamsearch';

export type PartHeaders = Record<string, string[]>;

const HEADER_END = Buffer.from('\r\n\r\n');
const INITIAL_CRLF = Buffer.from('\r\n');
const CLOSING_DASHES = Buffer.from('--');
const CLOSING_CR = Buffer.from('--\r');
// Keep header accumulation bounded before the caller's configured cap can run.
const MAX_HEADER_BYTES = 80 * 1024;
const MAX_HEADER_PAIRS = 2_000;

export class MultipartPartStream extends Readable {
  constructor(private readonly onRead: () => void) {
    super();
  }

  override _read(): void {
    this.onRead();
  }
}

function parseHeaders(block: Buffer): PartHeaders {
  const headers: PartHeaders = Object.create(null) as PartHeaders;
  if (block.length === 0) return headers;
  const lines = block.toString('latin1').split('\r\n');
  let previousName: string | undefined;
  let count = 0;

  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (previousName === undefined) {
        throw new Error('Unexpected folded header value');
      }
      const values = headers[previousName];
      if (values === undefined) throw new Error('Malformed part header');
      values[values.length - 1] += line;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('Malformed part header');
    const name = line.slice(0, colon);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error('Malformed part header');
    }
    const value = line.slice(colon + 1).replace(/^[ \t]/, '');
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      throw new Error('Malformed part header');
    }
    const key = name.toLowerCase();
    (headers[key] ??= []).push(value);
    previousName = key;
    if (++count > MAX_HEADER_PAIRS) throw new Error('Too many part headers');
  }

  return headers;
}

/** Parses multipart framing while leaving policy, timeouts, and cleanup to the caller. */
export class MultipartParser extends Writable {
  private readonly needle: Buffer;
  private readonly search: StreamSearch;
  private state: 'preamble' | 'headers' | 'body' | 'done' = 'preamble';
  private part: MultipartPartStream | undefined;
  private headerBytes = Buffer.alloc(0);
  private suffix = Buffer.alloc(0);
  private candidate = false;
  private pausedPart: MultipartPartStream | undefined;
  private pendingWrite: (() => void) | undefined;
  private openParts = 0;
  private finalCallback: ((error?: Error) => void) | undefined;

  constructor(boundary: string) {
    super();
    if (boundary.length === 0) throw new TypeError('Boundary required');
    this.needle = Buffer.from(`\r\n--${boundary}`);
    this.search = new StreamSearch(this.needle, (matched, data, start, end, safe) => {
      if (this.state !== 'done' && data && start < end) {
        const chunk = data.subarray(start, end);
        this.consume(safe ? chunk : Buffer.from(chunk));
      }
      if (this.state === 'done') return;
      if (matched) {
        if (this.state === 'headers') throw new Error('Malformed part header');
        this.candidate = true;
      }
    });
    // The first boundary may begin at byte zero; later boundaries require CRLF.
    this.search.push(INITIAL_CRLF);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      this.search.push(chunk);
      if (this.pausedPart) this.pendingWrite = callback;
      else callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    try {
      this.search.destroy();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (this.candidate && this.suffix.equals(CLOSING_DASHES)) {
      this.candidate = false;
      this.endPart();
      this.state = 'done';
    }
    if (this.state !== 'done') {
      const error = new Error('Unexpected end of multipart data');
      this.endPart();
      callback(error);
      return;
    }
    if (this.openParts === 0) callback();
    else this.finalCallback = callback;
  }

  private resumeWrite(part: MultipartPartStream): void {
    if (this.pausedPart !== part) return;
    this.pausedPart = undefined;
    const callback = this.pendingWrite;
    this.pendingWrite = undefined;
    callback?.();
  }

  private endPart(): void {
    const part = this.part;
    if (part === undefined) return;
    this.part = undefined;
    part.push(null);
  }

  private beginPart(): void {
    this.headerBytes = Buffer.alloc(0);
    this.state = 'headers';
    const part = new MultipartPartStream(() => this.resumeWrite(part));
    this.part = part;
    this.openParts++;
    let settled = false;
    const onPartDone = (): void => {
      if (settled) return;
      settled = true;
      this.openParts--;
      this.resumeWrite(part);
      if (this.openParts === 0 && this.finalCallback) {
        const callback = this.finalCallback;
        this.finalCallback = undefined;
        callback();
      }
    };
    part.once('end', onPartDone);
    part.once('close', onPartDone);
    this.emit('part', part);
  }

  private consume(data: Buffer): void {
    if (this.candidate) {
      if (this.suffix.length < 2) {
        const taken = Math.min(2 - this.suffix.length, data.length);
        this.suffix = Buffer.concat([this.suffix, data.subarray(0, taken)]);
        data = data.subarray(taken);
      }
      if (this.suffix.length < 2) return;

      if (this.suffix.equals(CLOSING_DASHES)) {
        if (data.length === 0) return;
        if (data[0] === 13) {
          this.suffix = CLOSING_CR;
          data = data.subarray(1);
          if (data.length === 0) return;
        }
      }
      if (this.suffix.equals(CLOSING_CR) && data.length === 0) return;

      const suffix = this.suffix;
      this.suffix = Buffer.alloc(0);
      this.candidate = false;
      if (suffix.equals(INITIAL_CRLF)) {
        this.endPart();
        this.beginPart();
      } else if (suffix.equals(CLOSING_CR) && data[0] === 10) {
        data = data.subarray(1);
        this.endPart();
        this.state = 'done';
        return;
      } else if (this.state === 'headers') {
        data = Buffer.concat([this.needle, suffix, data]);
      } else if (this.state === 'body') {
        this.consumeBody(this.needle);
        this.consumeBody(suffix);
      }
    }

    if (this.state === 'headers') {
      const pending = this.headerBytes.length;
      const scan = data.subarray(0, MAX_HEADER_BYTES + HEADER_END.length - pending);
      const combined = Buffer.concat([this.headerBytes, scan]);
      const empty = combined.length >= 2 && combined.subarray(0, 2).equals(INITIAL_CRLF);
      const end = empty ? 0 : combined.indexOf(HEADER_END);
      if (end < 0) {
        if (combined.length > MAX_HEADER_BYTES) throw new Error('Part headers too large');
        this.headerBytes = combined;
        return;
      }
      if (end > MAX_HEADER_BYTES) throw new Error('Part headers too large');
      const headers = parseHeaders(combined.subarray(0, end));
      const rawHeaders = Buffer.from(combined.subarray(0, end + (empty ? 2 : HEADER_END.length)));
      this.headerBytes = Buffer.alloc(0);
      this.state = 'body';
      this.part?.emit('header', headers, rawHeaders);
      this.consumeBody(data.subarray(end + (empty ? 2 : HEADER_END.length) - pending));
    } else if (this.state === 'body') {
      this.consumeBody(data);
    }
  }

  private consumeBody(data: Buffer): void {
    if (data.length > 0 && this.part && !this.part.destroyed && !this.part.push(data)) {
      this.pausedPart = this.part;
    }
  }
}
