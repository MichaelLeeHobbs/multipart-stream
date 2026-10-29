import { Readable, Writable } from 'node:stream';

import StreamSearch from 'streamsearch';

export type PartHeaders = Record<string, string[]>;

const HEADER_END = Buffer.from('\r\n\r\n');
const INITIAL_CRLF = Buffer.from('\r\n');
// RFC 2046 transport-padding (LWSP after a delimiter) is bounded so a run of
// whitespace cannot grow the held suffix without limit; past this it is body.
const MAX_PADDING = 1024;
const MAX_SUFFIX = 2 + MAX_PADDING + 2;

/** Caps the parser enforces while accumulating a part's header block. */
export interface HeaderLimits {
  /** Maximum header lines, counting repeated names. */
  readonly maxHeaderPairs: number;
  /** Maximum raw header-block bytes, including the terminating CRLF pair. */
  readonly maxHeaderBytes: number;
}

/** The source ended before the closing delimiter. */
export class UnexpectedEndError extends Error {
  constructor() {
    super('Unexpected end of multipart data');
  }
}

/** A part's header block exceeded one of the {@link HeaderLimits}. */
export class HeaderLimitError extends Error {
  constructor(
    readonly limit: 'count' | 'bytes',
    readonly observed: number,
  ) {
    super(limit === 'count' ? 'Too many part headers' : 'Part headers too large');
  }
}

type Delimiter =
  | { readonly kind: 'pending' | 'data' }
  | { readonly kind: 'next' | 'close'; readonly length: number };

const PENDING: Delimiter = { kind: 'pending' };
const DATA: Delimiter = { kind: 'data' };

/**
 * Classifies the bytes after a matched `CRLF--boundary`: `--`? LWSP* CRLF
 * makes it a delimiter (`close` with the dashes, else `next`); anything else
 * means the match was body data. At EOF a close delimiter needs no CRLF.
 */
function classifyDelimiter(s: Buffer, eof: boolean): Delimiter {
  const close = s[0] === 45 && s[1] === 45;
  if (!close && s[0] === 45 && s.length === 1) return eof ? DATA : PENDING;
  let i = close ? 2 : 0;
  while (i < s.length && (s[i] === 32 || s[i] === 9)) i++;
  if (i < s.length && s[i] !== 13) return DATA;
  if (i + 1 < s.length) {
    return s[i + 1] === 10 ? { kind: close ? 'close' : 'next', length: i + 2 } : DATA;
  }
  if (eof) return close ? { kind: 'close', length: s.length } : DATA;
  return s.length < MAX_SUFFIX ? PENDING : DATA;
}

export class MultipartPartStream extends Readable {
  /** True once the parser has pushed the whole body (its delimiter arrived). */
  complete = false;

  constructor(private readonly onRead: () => void) {
    super();
  }

  override _read(): void {
    this.onRead();
  }
}

function parseHeaders(block: Buffer, maxPairs: number): PartHeaders {
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
    count++;
  }
  // The block is already bounded by maxHeaderBytes, so count it in full and
  // report the exact number of lines.
  if (count > maxPairs) throw new HeaderLimitError('count', count);

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
  // streamsearch holds back trailing input that could start another needle,
  // which includes a delimiter's own CRLF. `pushed - reported` is the size of
  // that held-back run, and it is always the end of the input, so a copy of
  // the last `needle.length` input bytes lets peekDelimiter() see it.
  private pushed = 0;
  private reported = 0;
  private tail = Buffer.alloc(0);

  constructor(
    boundary: string,
    private readonly limits: HeaderLimits,
  ) {
    super();
    if (boundary.length === 0) throw new TypeError('Boundary required');
    this.needle = Buffer.from(`\r\n--${boundary}`);
    this.search = new StreamSearch(this.needle, (matched, data, start, end, safe) => {
      if (data) this.reported += end - start;
      if (matched) this.reported += this.needle.length;
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
    this.pushInput(INITIAL_CRLF);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      this.pushInput(chunk);
      this.peekDelimiter();
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
    if (this.candidate && classifyDelimiter(this.suffix, true).kind === 'close') {
      this.candidate = false;
      this.endPart();
      this.state = 'done';
    }
    if (this.state !== 'done') {
      // The open part is left unended: the caller fails it with this error,
      // so a reader never mistakes a cut body for a complete one.
      callback(new UnexpectedEndError());
      return;
    }
    if (this.openParts === 0) callback();
    else this.finalCallback = callback;
  }

  private pushInput(chunk: Buffer): void {
    const keep = this.needle.length;
    this.tail =
      chunk.length >= keep
        ? Buffer.from(chunk.subarray(chunk.length - keep))
        : Buffer.concat([this.tail, chunk]).subarray(-keep);
    this.pushed += chunk.length;
    this.search.push(chunk);
  }

  /**
   * Ends the current part as soon as its delimiter is confirmed (`CRLF` for
   * the next part, `--CRLF` for the close), even if those bytes are still held
   * by streamsearch. State transitions still happen when the bytes are
   * reported; endPart() is idempotent. A bare `--` stays ambiguous (it may be
   * `--junk` body data) until CRLF or EOF arrives.
   */
  private peekDelimiter(): void {
    if (!this.candidate || this.state !== 'body' || this.part === undefined) return;
    const held = this.pushed - this.reported;
    const pending = Buffer.concat([
      this.suffix,
      held > 0 ? this.tail.subarray(this.tail.length - held) : Buffer.alloc(0),
    ]);
    const { kind } = classifyDelimiter(pending, false);
    if (kind === 'next' || kind === 'close') this.endPart();
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
    part.complete = true;
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
      const prior = this.suffix;
      const combined = Buffer.concat([prior, data.subarray(0, MAX_SUFFIX - prior.length)]);
      const delimiter = classifyDelimiter(combined, false);
      if (delimiter.kind === 'pending') {
        this.suffix = combined;
        return;
      }
      this.suffix = Buffer.alloc(0);
      this.candidate = false;
      if (delimiter.kind === 'close') {
        this.endPart();
        this.state = 'done';
        return;
      }
      if (delimiter.kind === 'next') {
        data = data.subarray(delimiter.length - prior.length);
        this.endPart();
        this.beginPart();
      } else if (this.state === 'body') {
        // Not a delimiter: the matched bytes belong to the body. In the
        // preamble they are discarded like any other preamble text.
        this.consumeBody(this.needle);
        this.consumeBody(prior);
      }
    }

    if (this.state === 'headers') {
      const { maxHeaderBytes, maxHeaderPairs } = this.limits;
      const pending = this.headerBytes.length;
      const scan = data.subarray(0, maxHeaderBytes + HEADER_END.length - pending);
      const combined = Buffer.concat([this.headerBytes, scan]);
      const empty = combined.length >= 2 && combined.subarray(0, 2).equals(INITIAL_CRLF);
      const end = empty ? 0 : combined.indexOf(HEADER_END);
      if (end < 0) {
        if (combined.length > maxHeaderBytes) {
          throw new HeaderLimitError('bytes', combined.length);
        }
        this.headerBytes = combined;
        return;
      }
      const rawLength = end + (empty ? 2 : HEADER_END.length);
      if (rawLength > maxHeaderBytes) throw new HeaderLimitError('bytes', rawLength);
      const headers = parseHeaders(combined.subarray(0, end), maxHeaderPairs);
      const rawHeaders = Buffer.from(combined.subarray(0, rawLength));
      this.headerBytes = Buffer.alloc(0);
      this.state = 'body';
      this.part?.emit('header', headers, rawHeaders);
      this.consumeBody(data.subarray(rawLength - pending));
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
