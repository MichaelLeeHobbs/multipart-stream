/**
 * Stream-collection helpers (FR-015 + NFR-DR-S-002).
 *
 * Both helpers drain a Node `Readable` to a single value. They are
 * convenience for small parts (text / binary metadata, manifests) — for
 * larger payloads callers SHOULD pipe directly to a sink instead of
 * buffering.
 *
 * The optional `options.maxBytes` cap (NFR-DR-S-002): when set and the
 * accumulated bytes exceed the cap, the source `Readable` is destroyed and
 * the promise rejects with a clear `Error`. Existing callers that pass only
 * `(readable)` or `(readable, encoding)` see no behavior change.
 *
 * Per kiln/spec/api.md §3 + §4, `streamToBuffer`'s `options` parameter is the
 * second positional arg; `streamToString`'s `options` parameter is the
 * THIRD positional arg (after the legacy `encoding?`). The cap-overflow
 * error is a generic `Error` (NOT a custom class) because these are
 * utilities — the parsing-domain error classes are reserved for
 * `parseMultipartRelated`.
 */

import { finished, type Readable } from 'node:stream';

/**
 * Options bag accepted by both {@link streamToString} and
 * {@link streamToBuffer}. Currently exposes only `maxBytes` (NFR-DR-S-002);
 * forward-compat-shaped as an interface so additional cap fields can land
 * without breaking callers.
 */
export interface StreamCollectOptions {
  /**
   * Soft cap on accumulated input bytes. When set and the source produces
   * more than this many bytes total, the source `Readable` is destroyed
   * and the promise rejects with a clear `Error`. Omit (default) for no
   * cap. Must be a positive finite integer when set.
   */
  readonly maxBytes?: number | undefined;
}

/**
 * Drain a Node `Readable` to a single string.
 *
 * Calls `Buffer.from(chunk).toString(encoding)` for non-Buffer chunks,
 * defending against object-mode-ish streams that emit strings already.
 *
 * @param readable - Source stream. Must end (rejection on `'error'`).
 * @param encoding - Optional `BufferEncoding` (defaults to `'utf8'`).
 * @param options - Optional {@link StreamCollectOptions}. When
 *   `options.maxBytes` is set and accumulated bytes exceed the cap, the
 *   source is destroyed and the promise rejects (NFR-DR-S-002).
 * @returns A `Promise<string>` resolving to the full decoded contents.
 * @throws Any `'error'` event from `readable` rejects the promise with that
 *   error.
 * @throws {Error} `streamToString: input exceeded maxBytes (<n>)` when
 *   `options.maxBytes` is set and exceeded. The source `readable` is
 *   destroyed before the promise rejects.
 *
 * @example
 *   const text = await streamToString(part.body, 'utf8');
 *   console.log(JSON.parse(text));
 *
 * @example
 *   // With a 1 MiB cap to defend against attacker-controlled part bodies:
 *   const text = await streamToString(part.body, 'utf8', { maxBytes: 1_048_576 });
 */
export function streamToString(
  readable: Readable,
  encoding: BufferEncoding = 'utf8',
  options: StreamCollectOptions = {},
): Promise<string> {
  return Promise.resolve()
    .then(() => {
      if (!Buffer.isEncoding(encoding)) {
        throw new TypeError(`streamToString: unknown encoding ${JSON.stringify(String(encoding))}`);
      }
      return collect(readable, options, 'streamToString', encoding);
    })
    .then((buf) => buf.toString(encoding));
}

/**
 * Drain a Node `Readable` to a single `Buffer`.
 *
 * @param readable - Source stream.
 * @param options - Optional {@link StreamCollectOptions}. When
 *   `options.maxBytes` is set and accumulated bytes exceed the cap, the
 *   source is destroyed and the promise rejects (NFR-DR-S-002).
 * @returns A `Promise<Buffer>`. Zero-byte streams resolve to
 *   `Buffer.alloc(0)`.
 * @throws Any `'error'` event from `readable` rejects the promise.
 * @throws {Error} `streamToBuffer: input exceeded maxBytes (<n>)` when
 *   `options.maxBytes` is set and exceeded. The source `readable` is
 *   destroyed before the promise rejects.
 *
 * @example
 *   const buf = await streamToBuffer(part.body);
 *   await fs.writeFile(`/tmp/${part.contentId ?? 'part'}.bin`, buf);
 *
 * @example
 *   // With a 5 MiB cap to defend against attacker-controlled part bodies:
 *   const buf = await streamToBuffer(part.body, { maxBytes: 5_242_880 });
 */
export function streamToBuffer(
  readable: Readable,
  options: StreamCollectOptions = {},
): Promise<Buffer> {
  return Promise.resolve().then(() => collect(readable, options, 'streamToBuffer', 'utf8'));
}

/**
 * Shared drain loop. Settles exactly once: on `'end'`, on `'error'`, on a
 * destroy without either (premature close), or when a chunk cannot be
 * converted to bytes or breaks the cap — the last two destroy the source.
 */
function collect(
  readable: Readable,
  options: StreamCollectOptions,
  label: string,
  stringEncoding: BufferEncoding,
): Promise<Buffer> {
  const cap = options.maxBytes;
  if (cap !== undefined && (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 1)) {
    throw new TypeError(`${label}: maxBytes must be a positive safe integer when set`);
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      readable.off('data', onData);
      stopWatching();
      if (err !== null) reject(err);
      else resolve(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks));
    };
    const abandon = (err: Error): void => {
      settle(err);
      readable.destroy();
    };
    const onData = (chunk: unknown): void => {
      let buf: Buffer;
      try {
        buf = Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === 'string'
            ? Buffer.from(chunk, stringEncoding)
            : Buffer.from(chunk as Uint8Array);
      } catch {
        abandon(new TypeError(`${label}: stream emitted a non-byte chunk`));
        return;
      }
      total += buf.length;
      // NFR-DR-S-002 cap check, AFTER accumulating the current chunk: a cap
      // of N rejects on the chunk that takes the total over N (strict `>`).
      if (cap !== undefined && total > cap) {
        abandon(new Error(`${label}: input exceeded maxBytes (${String(cap)})`));
        return;
      }
      chunks.push(buf);
    };
    // `finished` also reports a destroy without 'end' as a premature-close
    // error, so a body torn down mid-read rejects instead of hanging.
    const stopWatching = finished(readable, (err) => {
      settle(err ?? null);
    });
    readable.on('data', onData);
  });
}
