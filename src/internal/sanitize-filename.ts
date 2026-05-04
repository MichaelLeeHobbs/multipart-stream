/**
 * `sanitizeFileName` — internal-only utility per FR-016 + FR-023 + NFR-DR-S-005.
 *
 * Internal: NOT re-exported from `src/index.ts`. Lives under `src/internal/`
 * per FR-016 (the spec keeps `extractBoundary` public and `sanitizeFileName`,
 * `flattenDicerHeaders`, `flattenHeaderValue`, `deriveNameFromContentId`
 * internal so the publish surface stays tiny).
 *
 * The function turns an arbitrary attacker-controllable string (e.g. the
 * `name=` parameter of a `Content-Disposition` header on a part) into a
 * filename that is safe to write to a filesystem. Pipeline:
 *
 *   1. Strip path separators (`/` and `\`) entirely. Per FR-023 text:
 *      "strip path separators" — separators are removed, NOT replaced
 *      with `_`. The spec edge-case row gives `'../etc/passwd'` →
 *      `'_._etc_passwd'` "or similar"; the pure-strip implementation
 *      lands on a different but spec-compliant answer (`'etcpasswd'`
 *      after leading-dot strip).
 *   2. Strip control characters (0x00–0x1F + 0x7F) entirely. Bytes are
 *      stripped (not replaced) so `'\x00\x07name'` → `'name'`.
 *   3. Strip leading dots — defends against POSIX hidden-file conventions
 *      and Windows `..` traversal.
 *   4. Replace anything not in `[A-Za-z0-9._-]` with `_` — covers spaces,
 *      shell metacharacters, Unicode, and the leftover oddballs.
 *   5. Post-pipeline fallback (NFR-DR-S-005 / F-S-004): if the result is
 *      empty, a pure-dot string (`.` / `..`), or a Windows reserved
 *      device name (`CON`/`PRN`/`AUX`/`NUL`/`COM[1-9]`/`LPT[1-9]`,
 *      case-insensitive, with or without extension), return the literal
 *      `'_'` — never an empty string.
 *   6. Cap the result at 255 chars. The cap runs LAST so the truncation
 *      never produces a Windows-reserved leftover.
 *
 * The function never returns `''` — NFR-DR-S-005's MUST-NOT-BE-EMPTY
 * contract on top of FR-023.
 *
 * @internal
 */

/**
 * Windows DOS reserved device names (case-insensitive). Opening any of
 * these by name on Windows returns a handle to the named device:
 *   - `CON` → console driver,
 *   - `PRN` / `AUX` / `NUL` → legacy parallel/auxiliary/null devices,
 *   - `COM1`..`COM9` → serial port handles,
 *   - `LPT1`..`LPT9` → parallel port handles.
 *
 * The check is case-insensitive AND extension-tolerant — `'AUX.txt'`,
 * `'aux.txt'`, `'COM1.dat'` all resolve to the device on Windows.
 *
 * @internal
 */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/** Cap on returned filename length (filesystem limit on most platforms). */
const FILENAME_MAX_LEN = 255;

/** Path separator pattern — `/` and `\`. Linear scan; no backtracking. */
const PATH_SEPARATOR_RE = /[/\\]/g;

/** C0 + DEL control characters. Linear scan. */
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/g;

/** Anything outside the conservative whitelist `[A-Za-z0-9._-]`. */
const NON_WHITELIST_RE = /[^A-Za-z0-9._-]/g;

/** Leading-dots pattern — anchored at start; linear scan. */
const LEADING_DOTS_RE = /^\.+/;

/**
 * Sanitize a filename per FR-023 + NFR-DR-S-005.
 *
 * @param input - Any attacker-controllable filename string. Non-strings
 *   are coerced via `String(input)` (defensive — callers should pass
 *   strings, but the function is total).
 * @returns A safe filename. Always non-empty (`'_'` is the fallback for
 *   inputs that would otherwise be empty / pure-dot / Windows-reserved).
 *   Always at most 255 chars. Always restricted to `[A-Za-z0-9._-]` (the
 *   conservative cross-platform whitelist).
 *
 * @example
 *   sanitizeFileName('report.pdf');         // 'report.pdf'
 *   sanitizeFileName('hello world.txt');    // 'hello_world.txt'
 *   sanitizeFileName('../etc/passwd');      // 'etcpasswd' (separators stripped)
 *   sanitizeFileName('.hidden');            // 'hidden'
 *   sanitizeFileName('CON');                // '_'
 *   sanitizeFileName('aux.txt');            // '_'
 *   sanitizeFileName('..');                 // '_'
 *   sanitizeFileName('');                   // '_'
 *
 * @internal
 */
export function sanitizeFileName(input: string): string {
  // Coerce to string so non-string inputs (defensive — type system says
  // string, but callers may launder past via `as`) don't crash with a
  // .replace on undefined.
  const raw = typeof input === 'string' ? input : String(input);

  // Step 1: strip path separators.
  let s = raw.replace(PATH_SEPARATOR_RE, '');

  // Step 2: strip control chars (0x00–0x1F + 0x7F).
  s = s.replace(CONTROL_CHARS_RE, '');

  // Step 3: strip leading dots.
  s = s.replace(LEADING_DOTS_RE, '');

  // Step 4: replace anything not in [A-Za-z0-9._-] with `_`.
  s = s.replace(NON_WHITELIST_RE, '_');

  // Step 5a: empty after pipeline → fallback.
  if (s.length === 0) return '_';

  // Step 5b: pure-dot result (`.` or `..`). The leading-dot strip above
  // catches `.` and `..` — they collapse to ''. But '...' followed by a
  // single trailing dot is impossible after Step 3 (all leading dots
  // stripped). Belt-and-suspenders here so future pipeline edits don't
  // regress the contract.
  if (s === '.' || s === '..') return '_';

  // Step 5c: Windows reserved device name (case-insensitive, with or
  // without extension). `aux.txt` and `aux` and `AUX` and `Aux.dat` all
  // map to the device. Split on the first `.` and check the stem.
  const dotIdx = s.indexOf('.');
  const stem = dotIdx >= 0 ? s.slice(0, dotIdx) : s;
  if (stem.length > 0 && WINDOWS_RESERVED_NAMES.has(stem.toUpperCase())) {
    return '_';
  }

  // Step 6: cap at 255 chars. Runs LAST so truncation can't produce a
  // pure-dot or Windows-reserved leftover.
  if (s.length > FILENAME_MAX_LEN) {
    return s.slice(0, FILENAME_MAX_LEN);
  }

  return s;
}
