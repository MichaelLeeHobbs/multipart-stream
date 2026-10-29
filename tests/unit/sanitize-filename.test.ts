/**
 * Unit tests for `sanitizeFileName` (FR-023 + NFR-DR-S-005 / F-S-004).
 *
 * Covers:
 *   - T-038 (FR-023 base pipeline): path-traversal, control chars, leading
 *     dots, length cap, whitespace replacement.
 *   - T-038b (NFR-DR-S-005 Windows reserved): CON / con / AUX / aux.txt /
 *     COM[1-9] / LPT[1-9] / PRN / NUL all → '_'. Counter-examples
 *     (`'CONsole'`, `'auxiliary'`) preserved.
 *   - T-038c (NFR-DR-S-005 dot-only / empty): `.`, `..`, `...`, `''` → '_'.
 *     Contract: NEVER returns `''`.
 */
import { describe, expect, it } from 'vitest';

import { sanitizeFileName } from '../../src/internal/sanitize-filename.js';

describe('sanitizeFileName — T-038 base pipeline (FR-023)', () => {
  it('passes through clean ASCII filenames unchanged', () => {
    expect(sanitizeFileName('report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('archive.tar.gz')).toBe('archive.tar.gz');
    expect(sanitizeFileName('a-b_c.txt')).toBe('a-b_c.txt');
    expect(sanitizeFileName('Image_001.png')).toBe('Image_001.png');
  });

  it('strips path separators (/ and \\)', () => {
    // Per FR-023 text: "strip path separators". Removed entirely (NOT
    // replaced with `_`) — diverges from the spec edge-case row's example
    // output (`_._etc_passwd`) but remains spec-compliant.
    expect(sanitizeFileName('../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeFileName('foo/bar')).toBe('foobar');
    expect(sanitizeFileName('a\\b\\c')).toBe('abc');
    expect(sanitizeFileName('mixed/and\\separators')).toBe('mixedandseparators');
  });

  it('strips control characters (0x00–0x1F + 0x7F)', () => {
    expect(sanitizeFileName('\x00\x07name')).toBe('name');
    expect(sanitizeFileName('a\x01b\x1Fc\x7Fd')).toBe('abcd');
    // CR + LF stripped (the log-injection vector).
    expect(sanitizeFileName('one\r\ntwo')).toBe('onetwo');
  });

  it('strips leading dots (POSIX hidden / dot-traversal)', () => {
    expect(sanitizeFileName('.hidden')).toBe('hidden');
    expect(sanitizeFileName('...config')).toBe('config');
    // Inner dots preserved (those are extension separators).
    expect(sanitizeFileName('archive.tar.gz')).toBe('archive.tar.gz');
  });

  it('replaces non-whitelist chars with `_`', () => {
    // Spaces → `_`.
    expect(sanitizeFileName('hello world.txt')).toBe('hello_world.txt');
    // Shell metacharacters → `_`.
    expect(sanitizeFileName('a;b|c&d')).toBe('a_b_c_d');
    expect(sanitizeFileName("a'b\"c")).toBe('a_b_c');
    // Unicode → `_` (each byte/code-unit individually replaced).
    expect(sanitizeFileName('café.txt')).toBe('caf_.txt');
    // Colon (Windows path separator on volume names) → `_`.
    expect(sanitizeFileName('C:foo')).toBe('C_foo');
  });

  it('caps length at 255 chars', () => {
    expect(sanitizeFileName('a'.repeat(300)).length).toBe(255);
    expect(sanitizeFileName('a'.repeat(255)).length).toBe(255);
    expect(sanitizeFileName('a'.repeat(254)).length).toBe(254);
  });

  it('combines all transformations on a maliciously-crafted input', () => {
    // Path traversal + control chars + leading dot + spaces + length.
    const input =
      '../../\x00etc\x07/passwd' + ' '.repeat(10) + 'a'.repeat(300);
    const result = sanitizeFileName(input);
    expect(result.length).toBe(255);
    // No path separators.
    expect(result).not.toMatch(/[/\\]/);
    // No control chars.
    for (let i = 0; i < 0x20; i++) {
      expect(result).not.toContain(String.fromCharCode(i));
    }
    expect(result).not.toContain('\x7F');
    // Doesn't start with a dot.
    expect(result.startsWith('.')).toBe(false);
    // Whitelist-only.
    expect(result).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('sanitizeFileName — T-038b NFR-DR-S-005 Windows reserved names', () => {
  // Reserved names (case-insensitive, with or without extension) → `_`.
  const reserved: readonly string[] = [
    'CON',
    'con',
    'Con',
    'PRN',
    'prn',
    'AUX',
    'aux',
    'NUL',
    'nul',
    'COM1',
    'com1',
    'COM2',
    'COM5',
    'com9',
    'LPT1',
    'lpt1',
    'LPT5',
    'lpt9',
  ];

  for (const name of reserved) {
    it(`maps '${name}' to '_'`, () => {
      expect(sanitizeFileName(name)).toBe('_');
    });
  }

  const reservedWithExt: readonly string[] = [
    'CON.txt',
    'con.txt',
    'AUX.dat',
    'aux.txt',
    'COM1.dat',
    'com9.bin',
    'LPT1.foo',
    'lpt9.foo',
    'PRN.log',
    'NUL.json',
  ];

  for (const name of reservedWithExt) {
    it(`maps '${name}' (reserved + extension) to '_'`, () => {
      expect(sanitizeFileName(name)).toBe('_');
    });
  }

  // Counter-examples — names that CONTAIN a reserved sequence but are
  // not exactly the reserved name. Must be PRESERVED.
  it('preserves counter-examples that are not exactly reserved names', () => {
    expect(sanitizeFileName('CONsole')).toBe('CONsole');
    expect(sanitizeFileName('auxiliary')).toBe('auxiliary');
    expect(sanitizeFileName('NULabc')).toBe('NULabc');
    expect(sanitizeFileName('PRNs')).toBe('PRNs');
    expect(sanitizeFileName('COM10')).toBe('COM10'); // COM10 is NOT reserved; only COM1..COM9
    expect(sanitizeFileName('LPT0')).toBe('LPT0'); // LPT0 NOT reserved; only LPT1..LPT9
  });
});

describe('sanitizeFileName — T-038c NFR-DR-S-005 dot-only / empty fallback', () => {
  it("never returns the empty string", () => {
    // Contract: NEVER returns `''` regardless of input.
    expect(sanitizeFileName('')).toBe('_');
    expect(sanitizeFileName('.')).toBe('_');
    expect(sanitizeFileName('..')).toBe('_');
    expect(sanitizeFileName('...')).toBe('_');
    expect(sanitizeFileName('....')).toBe('_');
  });

  it('inputs that empty after pipeline → `_`', () => {
    // All-control-chars → '' after stripping → fallback.
    expect(sanitizeFileName('\x00\x01\x02')).toBe('_');
    // All-separators → '' after stripping → fallback.
    expect(sanitizeFileName('////')).toBe('_');
    expect(sanitizeFileName('\\\\\\')).toBe('_');
    // All-leading-dots → '' after stripping → fallback.
    expect(sanitizeFileName('.....')).toBe('_');
  });

  it('handles defensive non-string inputs via String() coercion', () => {
    // The static type is `string`, but callers may launder past via `as`.
    // The function should not crash on non-string inputs.
    expect(sanitizeFileName(undefined as unknown as string)).toBe(
      'undefined',
    );
    expect(sanitizeFileName(null as unknown as string)).toBe('null');
    expect(sanitizeFileName(42 as unknown as string)).toBe('42');
  });
});

describe('sanitizeFileName — invariants', () => {
  // Property-style sanity checks across a small but representative
  // matrix. Always-true invariants for any input.
  const samples: readonly string[] = [
    '',
    '.',
    '..',
    '...',
    'a',
    'CON',
    'aux.txt',
    '../etc/passwd',
    '\x00\x07evil\x1B[31m',
    'Hello, World!.txt',
    'a'.repeat(500),
    'normal-file_name.tar.gz',
    'café.png',
    'COM10', // NOT reserved
    'LPT0', // NOT reserved
  ];

  for (const sample of samples) {
    it(`output for ${JSON.stringify(sample.slice(0, 40))} satisfies invariants`, () => {
      const result = sanitizeFileName(sample);
      // Non-empty.
      expect(result.length).toBeGreaterThan(0);
      // Bounded.
      expect(result.length).toBeLessThanOrEqual(255);
      // Whitelist-only (post-fallback `_` is in the whitelist).
      expect(result).toMatch(/^[A-Za-z0-9._-]+$/);
      // Never starts with a dot UNLESS it's the exact fallback (which
      // is `_`, not a dot).
      if (result !== '_') {
        // After leading-dot strip, output never starts with `.`.
        expect(result.startsWith('.')).toBe(false);
      }
    });
  }
});
