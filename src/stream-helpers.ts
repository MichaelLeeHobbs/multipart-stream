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

import type { Readable } from 'node:stream';

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
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cap = options.maxBytes;
    const onData = (chunk: Buffer | string): void => {
      const buf =
        typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
      total += buf.length;
      // NFR-DR-S-002 cap check. We compare AFTER accumulating the current
      // chunk's bytes — a cap of N rejects on the chunk that takes the
      // total over N (i.e. strict `>`). The source is destroyed before
      // we reject so any further 'data' events are suppressed.
      if (cap !== undefined && total > cap) {
        cleanup();
        readable.destroy();
        reject(
          new Error(`streamToString: input exceeded maxBytes (${String(cap)})`),
        );
        return;
      }
      chunks.push(buf);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString(encoding));
    };
    const cleanup = (): void => {
      readable.off('data', onData);
      readable.off('error', onError);
      readable.off('end', onEnd);
    };
    readable.on('data', onData);
    readable.once('error', onError);
    readable.once('end', onEnd);
  });
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
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const cap = options.maxBytes;
    const onData = (chunk: Buffer | string): void => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += buf.length;
      if (cap !== undefined && total > cap) {
        cleanup();
        readable.destroy();
        reject(
          new Error(`streamToBuffer: input exceeded maxBytes (${String(cap)})`),
        );
        return;
      }
      chunks.push(buf);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks));
    };
    const cleanup = (): void => {
      readable.off('data', onData);
      readable.off('error', onError);
      readable.off('end', onEnd);
    };
    readable.on('data', onData);
    readable.once('error', onError);
    readable.once('end', onEnd);
  });
}
