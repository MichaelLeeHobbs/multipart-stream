/**
 * Header-bag normalizer (FR-016 internal helper).
 *
 * The internal parser emits lowercase names with `string[]` values, one
 * entry per repeated header. Repeated values are joined with `, ` (empty
 * values included, as Node's `http` does).
 *
 * @internal
 */

import type { PartHeaders } from './multipart-parser.js';

/**
 * Flatten the parser's header bag to one string per name.
 *
 * The result has a `null` prototype (like Node's `IncomingMessage.headers`)
 * so a `__proto__` header is stored as data and inherited names such as
 * `constructor` read as `undefined`.
 *
 * @param raw - Parser's raw header bag (lowercase names).
 * @returns A flat `Record<string, string | undefined>` with lowercase keys.
 *
 * @internal
 */
export function flattenPartHeaders(raw: PartHeaders): Record<string, string | undefined> {
  const out = Object.create(null) as Record<string, string | undefined>;
  for (const key of Object.keys(raw)) {
    out[key.toLowerCase()] = raw[key]?.join(', ');
  }
  return out;
}
