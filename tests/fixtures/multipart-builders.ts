/**
 * Multipart envelope builder for tests, per `kiln/spec/test-plan.md`
 * "Conventions" → "Multipart envelope builder".
 *
 * Produces a `Buffer` encoding a `multipart/related` envelope with proper
 * CRLF framing, dashes, boundary placement, and (optionally) the closing
 * `--boundary--`. Parameterized for malformed cases so callers can request
 * "missing closing boundary" or "embedded CRLF in part body" without
 * rewriting the helper.
 *
 * Not part of the published surface — lives under `tests/fixtures/` and is
 * never imported from `src/`.
 */

const CRLF = '\r\n';

export interface PartInput {
  readonly headers: Record<string, string>;
  readonly body: string | Buffer;
}

export interface BuildMultipartBodyOptions {
  readonly boundary: string;
  readonly parts: readonly PartInput[];
  /**
   * When `false`, the closing `--boundary--` line is omitted, simulating a
   * truncated stream. Defaults to `true`.
   */
  readonly closingBoundary?: boolean;
  /**
   * Optional preamble text to prepend before the first boundary delimiter
   * (the multipart preamble per RFC 2046 §5.1.1). Defaults to empty.
   */
  readonly preamble?: string;
  /**
   * Optional epilogue text appended after the closing boundary. Defaults to
   * empty.
   */
  readonly epilogue?: string;
}

/**
 * Construct a `multipart/related` envelope as a `Buffer`.
 *
 * Each part is rendered as:
 *
 *   --boundary<CRLF>
 *   Header-Name: value<CRLF>
 *   ...<CRLF>
 *   <CRLF>
 *   <body><CRLF>
 *
 * The final closing line (when `closingBoundary` is true) is:
 *
 *   --boundary--<CRLF>
 */
export function buildMultipartBody(
  options: BuildMultipartBodyOptions,
): Buffer {
  const {
    boundary,
    parts,
    closingBoundary = true,
    preamble = '',
    epilogue = '',
  } = options;

  const chunks: Buffer[] = [];

  if (preamble.length > 0) {
    chunks.push(Buffer.from(preamble + CRLF, 'utf8'));
  }

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}`, 'utf8'));
    for (const [name, value] of Object.entries(part.headers)) {
      chunks.push(Buffer.from(`${name}: ${value}${CRLF}`, 'utf8'));
    }
    chunks.push(Buffer.from(CRLF, 'utf8'));
    chunks.push(
      typeof part.body === 'string'
        ? Buffer.from(part.body, 'utf8')
        : part.body,
    );
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }

  if (closingBoundary) {
    chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  }

  if (epilogue.length > 0) {
    chunks.push(Buffer.from(epilogue, 'utf8'));
  }

  return Buffer.concat(chunks);
}
