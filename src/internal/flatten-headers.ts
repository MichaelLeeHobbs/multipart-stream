/**
 * Header-bag normalizer (FR-016 internal helper).
 *
 * Dicer's per-part `'header'` event delivers a `Record<string, ...>` whose
 * values vary by dicer version + MIME folding behavior:
 *   - dicer 0.3.1's HeaderParser stores `string[]` (latin1-decoded line
 *     content), one entry per repeated header name.
 *   - The ambient shim at `src/internal/dicer.d.ts` declares
 *     `Buffer | Buffer[] | Buffer[][]` defensively.
 *
 * We collapse every shape to a single string per name (joining repeats with
 * `, ` per RFC 7230 §3.2.2) and lowercase the key.
 *
 * Unit-tested via the integration tests for unusual capitalization
 * (T-057).
 *
 * @internal
 */

/**
 * Coerce one header value (whatever shape dicer chose) to a single string.
 *
 * @param v - The raw header value, in any of the shapes documented above.
 * @returns The flattened string. Returns `''` for nullish input — matches the
 *   reference impl's contract.
 *
 * @internal
 */
export function flattenHeaderValue(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const inner of v) {
      const flat = flattenHeaderValue(inner);
      if (flat !== '') parts.push(flat);
    }
    return parts.join(', ');
  }
  // Fallback for unexpected shapes (e.g. number, boolean) — coerce to a
  // primitive string. Object/null cases are handled above; this branch only
  // catches pure primitives, which `Object.prototype.toString.call` would
  // overwrap, so we use the JSON-stringify of the wrapped primitive value
  // to keep the result log-line-friendly.
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  // Truly unknown shape — return empty string rather than '[object Object]'.
  return '';
}

/**
 * Lowercase keys and run every value through `flattenHeaderValue`.
 *
 * @param raw - Dicer's raw header bag.
 * @returns A flat `Record<string, string | undefined>` with lowercase keys.
 *
 * @internal
 */
export function flattenDicerHeaders(
  raw: Record<string, unknown> | undefined,
): Record<string, string | undefined> {
  if (raw == null) return {};
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(raw)) {
    const lower = key.toLowerCase();
    const value = flattenHeaderValue(raw[key]);
    out[lower] = value;
  }
  return out;
}
