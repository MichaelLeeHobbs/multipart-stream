/**
 * Input normalizer for `parseMultipartRelated`.
 *
 * Per `kiln/spec/data-model.md` §2.4 (`ParseInput` discriminated union), the
 * public `parseMultipartRelated` accepts either a Web `Response` or a Node
 * `Readable`. Internally we always work in a `{ readable, boundary }` shape;
 * this module is the single conversion site.
 *
 * Synchronous validation paths required by FR-004:
 *   - Response with `body === null` → throws.
 *   - Response missing `Content-Type` → throws (via `extractBoundary`).
 *   - Response with Content-Type but no `boundary=` → throws (via
 *     `extractBoundary`).
 *   - Readable input without explicit `opts.boundary` → throws.
 *
 * For Web `ReadableStream` bodies we call `Readable.fromWeb(body as
 * ReadableStream<Uint8Array>)` per FR-003 — the typed cast is documented
 * inline and is NOT `as never` (per NFR-001 / T-039).
 *
 * @internal
 */

import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import { extractBoundary } from '../extract-boundary.js';

/** Discriminated union per `kiln/spec/data-model.md` §2.4. @internal */
export type NormalizedInput =
  | {
      readonly kind: 'response';
      readonly readable: Readable;
      readonly boundary: string;
    }
  | {
      readonly kind: 'readable';
      readonly readable: Readable;
      readonly boundary: string;
    };

/** @internal */
export interface NormalizeOptions {
  readonly boundary?: string | undefined;
}

/**
 * Detect a Web `Response` without depending on the global `Response`
 * constructor for `instanceof` checks (Node 20.18+ has it, but defensive
 * duck-typing covers test fixtures that emulate the shape).
 *
 * @internal
 */
function looksLikeResponse(input: unknown): input is Response {
  if (typeof Response !== 'undefined' && input instanceof Response) {
    return true;
  }
  if (input == null || typeof input !== 'object') return false;
  const candidate = input as { headers?: { get?: unknown }; body?: unknown };
  return (
    typeof candidate.headers === 'object' &&
    candidate.headers !== null &&
    typeof (candidate.headers).get === 'function' &&
    'body' in candidate
  );
}

/**
 * Detect a Node `Readable` without requiring `instanceof Readable` (which is
 * fragile across re-bundled streams modules in mixed ESM+CJS environments).
 *
 * @internal
 */
function looksLikeReadable(input: unknown): input is Readable {
  if (input == null || typeof input !== 'object') return false;
  const candidate = input as {
    pipe?: unknown;
    on?: unknown;
    readable?: unknown;
  };
  return (
    typeof candidate.pipe === 'function' &&
    typeof candidate.on === 'function'
  );
}

/**
 * Normalize a public `Response | Readable` input plus its options into a
 * `{ readable, boundary }` pair the parser core can consume.
 *
 * Throws synchronously on every FR-004 violation. The thrown errors are
 * intentionally plain `Error` (not the `Multipart*Error` classes) — the
 * spec calls these out as "fundamentally invalid input" pre-conditions,
 * not multipart-protocol failures.
 *
 * @internal
 */
export function normalizeInput(
  input: unknown,
  opts: NormalizeOptions,
): NormalizedInput {
  if (looksLikeResponse(input)) {
    if (input.body == null) {
      throw new Error('multipart: response body is null');
    }
    const contentType = input.headers.get('content-type');
    // `extractBoundary` throws with the precise FR-004 / NFR-DR-S-006
    // sanitized error messages on missing/empty/missing-boundary input.
    const boundary = extractBoundary(contentType);

    // FR-003: convert the Web ReadableStream to a Node Readable. The cast
    // `body as ReadableStream<Uint8Array>` matches the runtime shape (fetch
    // bodies are byte streams) and satisfies `Readable.fromWeb`'s typings;
    // critically, this is NOT `as never` (per NFR-001 / T-039).
    const webBody = input.body as unknown as WebReadableStream<Uint8Array>;
    const readable = Readable.fromWeb(webBody);
    return { kind: 'response', readable, boundary };
  }

  if (looksLikeReadable(input)) {
    if (typeof opts.boundary !== 'string' || opts.boundary === '') {
      throw new Error(
        'multipart: boundary option is required when input is a Readable',
      );
    }
    return { kind: 'readable', readable: input, boundary: opts.boundary };
  }

  throw new Error(
    'multipart: input must be a Response or a Node Readable',
  );
}
