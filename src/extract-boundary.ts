/**
 * `extractBoundary` — RFC 2046 boundary extractor (FR-016).
 *
 * Public utility. Pure function — no I/O, no allocations beyond the result
 * and a single intermediate buffer for unescaping a quoted string.
 *
 * Implementation note (NFR-DR-S-011, T-080): this is a hand-written,
 * non-backtracking tokenizer. A naive regex with an alternation between the
 * quoted-string and bare-token forms is ReDoS-prone on adversarial input
 * (megabytes of `\\\"` sequences); the deliberate single-pass tokenizer
 * below runs in O(n) time on any input.
 */

import { truncateForErrorEmbed } from './internal/format-error-embed.js';

/**
 * Parse the `boundary=` parameter out of an HTTP `Content-Type` header value.
 *
 * Handles RFC 2046 quoted-string and bare-token forms. The first `boundary=`
 * occurrence wins (parameters are scanned left-to-right). Boundary parameter
 * names are matched case-insensitively. The returned token is unquoted and
 * has its backslash escapes resolved.
 *
 * @param contentTypeHeader - The full `Content-Type` header value, e.g.
 *   `multipart/related; boundary="weird;boundary"`. May be `null` or
 *   `undefined`; both are treated as missing-input errors.
 * @returns The unquoted boundary token.
 * @throws {Error} `multipart: Content-Type header is required to extract
 *   boundary` when the input is null, undefined, or empty.
 * @throws {Error} `multipart: boundary parameter missing from Content-Type:
 *   <header>` when the header has no `boundary=` parameter.
 * @throws {Error} `multipart: boundary parameter is empty in Content-Type:
 *   <header>` when the parameter is present but the value is empty.
 *
 * In every error path that embeds the input header, the embedded value is
 * sanitized via the full sanitizer (truncate to 120 chars, control-char
 * redact, ANSI redact, JSON.stringify per NFR-DR-S-006).
 *
 * @example
 *   extractBoundary('multipart/related; boundary=foo'); // 'foo'
 *
 * @example
 *   // Quoted-string form with embedded special chars (RFC 2046):
 *   extractBoundary('multipart/related; boundary="weird;boundary"');
 *   // 'weird;boundary'
 *
 * @example
 *   // Multiple parameters in any order; case-insensitive parameter name:
 *   extractBoundary('multipart/related; type="application/dicom"; BOUNDARY=BAR; charset=utf-8');
 *   // 'BAR'
 */
export function extractBoundary(
  contentTypeHeader: string | null | undefined,
): string {
  if (contentTypeHeader == null || contentTypeHeader === '') {
    throw new Error(
      'multipart: Content-Type header is required to extract boundary',
    );
  }

  const header = contentTypeHeader;
  const len = header.length;
  let i = 0;

  // Skip the type/subtype prefix up to the first `;` — we don't validate it
  // here (FR-021 in fetchAndHandleMultipart does the multipart/related
  // assertion). We just hunt for `boundary=` in the parameter list.
  while (i < len && header.charCodeAt(i) !== 0x3b /* ; */) i++;

  while (i < len) {
    // Skip the `;` and any whitespace + leading semicolons before the next
    // parameter token.
    while (i < len) {
      const c = header.charCodeAt(i);
      if (c === 0x3b /* ; */ || c === 0x20 /* space */ || c === 0x09 /* tab */) {
        i++;
        continue;
      }
      break;
    }
    if (i >= len) break;

    // Parameter name: token chars up to `=`. Per RFC 7230, tokens are a
    // restricted set; we accept any non-`=` non-`;` non-whitespace as the
    // name and lower-case-compare against `boundary`.
    const nameStart = i;
    while (i < len) {
      const c = header.charCodeAt(i);
      if (c === 0x3d /* = */ || c === 0x3b /* ; */) break;
      if (c === 0x20 /* space */ || c === 0x09 /* tab */) break;
      i++;
    }
    const name = header.slice(nameStart, i).toLowerCase();

    // Skip whitespace between name and `=`.
    while (i < len) {
      const c = header.charCodeAt(i);
      if (c === 0x20 || c === 0x09) {
        i++;
        continue;
      }
      break;
    }

    if (i >= len || header.charCodeAt(i) !== 0x3d /* = */) {
      // Either end-of-string or another `;` — this is a flag-only parameter
      // (not legal per RFC, but tolerated by browsers); skip it.
      // Advance past anything until the next `;`.
      while (i < len && header.charCodeAt(i) !== 0x3b) i++;
      continue;
    }

    // Skip the `=` and any whitespace.
    i++;
    while (i < len) {
      const c = header.charCodeAt(i);
      if (c === 0x20 || c === 0x09) {
        i++;
        continue;
      }
      break;
    }

    // Value: either a quoted-string ("...", with `\` escapes) or a bare token
    // up to the next `;`/whitespace.
    let value = '';
    if (i < len && header.charCodeAt(i) === 0x22 /* " */) {
      // Quoted string. Single-pass scan; never backtracks. The cost on a
      // 64 KiB pathological input (T-080) is O(n) regardless of escape
      // density — that's the whole point of NOT using a regex here.
      i++; // consume opening quote
      const buf: string[] = [];
      let closed = false;
      while (i < len) {
        const c = header.charCodeAt(i);
        if (c === 0x5c /* \ */ && i + 1 < len) {
          // Escaped char — accept the next char verbatim.
          buf.push(header.charAt(i + 1));
          i += 2;
          continue;
        }
        if (c === 0x22 /* " */) {
          closed = true;
          i++;
          break;
        }
        buf.push(header.charAt(i));
        i++;
      }
      // Per RFC, an unterminated quoted string is malformed. We accept what
      // we got rather than throwing — extractBoundary's failure modes are
      // about missing/empty boundary, not malformed framing. The downstream
      // dicer call will raise on a bad boundary anyway.
      void closed;
      value = buf.join('');
    } else {
      // Bare token — read until `;` / whitespace / EOL.
      const valStart = i;
      while (i < len) {
        const c = header.charCodeAt(i);
        if (c === 0x3b /* ; */ || c === 0x20 || c === 0x09) break;
        i++;
      }
      value = header.slice(valStart, i);
    }

    if (name === 'boundary') {
      if (value === '') {
        throw new Error(
          `multipart: boundary parameter is empty in Content-Type: ${truncateForErrorEmbed(
            header,
          )}`,
        );
      }
      return value;
    }

    // Not the parameter we're looking for — skip to the next `;`.
    while (i < len && header.charCodeAt(i) !== 0x3b) i++;
  }

  throw new Error(
    `multipart: boundary parameter missing from Content-Type: ${truncateForErrorEmbed(
      header,
    )}`,
  );
}
