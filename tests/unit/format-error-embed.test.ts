/**
 * Unit tests for `formatErrorEmbed` (NFR-DR-S-006 / F-S-005).
 *
 * Covers T-077: the full sanitizer (truncate + control-char redact + ANSI
 * redact + JSON.stringify) plus `summarizeError` for structured logging.
 *
 * Output of `truncateForErrorEmbed` is JSON-stringified (so a plain ASCII
 * input `"hello"` becomes the 7-char string `'"hello"'`).
 */
import { describe, expect, it } from 'vitest';

import {
  summarizeError,
  truncateForErrorEmbed,
} from '../../src/internal/format-error-embed.js';

describe('truncateForErrorEmbed (full sanitizer)', () => {
  describe('JSON.stringify wrapping', () => {
    it('wraps plain ASCII in double-quotes', () => {
      expect(truncateForErrorEmbed('short')).toBe('"short"');
    });

    it('escapes embedded double-quotes (NFR-DR-S-006c)', () => {
      // Embedded `"` becomes `\"` in the JSON-stringified form so an
      // operator reading the log can see exactly where the embed starts /
      // ends and where the original input had quotes.
      expect(truncateForErrorEmbed('a"b"c')).toBe('"a\\"b\\"c"');
    });

    it('coerces non-string inputs via String(value)', () => {
      expect(truncateForErrorEmbed(42)).toBe('"42"');
      expect(truncateForErrorEmbed(null)).toBe('"null"');
      expect(truncateForErrorEmbed(undefined)).toBe('"undefined"');
    });
  });

  describe('control-character redaction (NFR-DR-S-006b)', () => {
    it('replaces NUL (\\x00) with [redacted-control]', () => {
      const result = truncateForErrorEmbed('a\x00b');
      expect(result).toBe('"a[redacted-control]b"');
    });

    it('replaces BEL (\\x07) with [redacted-control]', () => {
      const result = truncateForErrorEmbed('a\x07b');
      expect(result).toBe('"a[redacted-control]b"');
    });

    it('replaces DEL (\\x7F) with [redacted-control]', () => {
      const result = truncateForErrorEmbed('a\x7Fb');
      expect(result).toBe('"a[redacted-control]b"');
    });

    it('replaces multiple control chars with multiple tokens', () => {
      const result = truncateForErrorEmbed('a\x00b\x07c');
      expect(result).toBe(
        '"a[redacted-control]b[redacted-control]c"',
      );
    });

    it('contains zero raw 0x00–0x1F bytes after redaction', () => {
      const input = Array.from({ length: 32 }, (_, i) =>
        String.fromCharCode(i),
      ).join('');
      const result = truncateForErrorEmbed(input);
      // Every byte 0x00..0x1F should be gone from the output.
      for (let i = 0; i < 0x20; i++) {
        expect(result).not.toContain(String.fromCharCode(i));
      }
      expect(result).not.toContain('\x7F');
    });
  });

  describe('ANSI / CSI escape redaction (NFR-DR-S-006b)', () => {
    it('replaces ANSI red color sequence with [redacted-control]', () => {
      // \x1B[31m is the ANSI SGR sequence for red text. The 0x1B (ESC)
      // would also match the C0 regex; the ANSI regex runs FIRST so the
      // entire CSI sequence is consumed as a unit.
      const result = truncateForErrorEmbed('\x1B[31mred\x1B[0m');
      expect(result).toBe(
        '"[redacted-control]red[redacted-control]"',
      );
    });

    it('replaces ANSI cursor-up sequence with [redacted-control]', () => {
      // \x1B[A is the CUU (CUrsor Up) sequence — a CSI with no parameters.
      const result = truncateForErrorEmbed('a\x1B[Ab');
      expect(result).toBe('"a[redacted-control]b"');
    });

    it('replaces ANSI sequence with multi-digit parameters', () => {
      // \x1B[31;1m is the SGR for "red bold".
      const result = truncateForErrorEmbed('\x1B[31;1mtext');
      expect(result).toBe('"[redacted-control]text"');
    });
  });

  describe('truncation (NFR-DR-S-006a)', () => {
    it('returns short input unchanged (after JSON-stringify wrapping)', () => {
      // 'short' becomes '"short"' (7 chars), well below the 120 limit.
      const result = truncateForErrorEmbed('short');
      expect(result).toBe('"short"');
      expect(result.length).toBe(7);
    });

    it('T-077a: 5 KB ASCII input truncated to 120 chars + ellipsis', () => {
      // Per NFR-DR-S-006a: 5 KB ASCII input truncated to 120 chars + `…`
      // suffix (length 121).
      const input = 'a'.repeat(5_000);
      const result = truncateForErrorEmbed(input);
      expect(result.length).toBe(121);
      expect(result.endsWith('…')).toBe(true);
      // The leading char of the JSON-stringified form is `"`, then 119
      // payload chars, then the `…` suffix.
      expect(result.startsWith('"')).toBe(true);
    });

    it('truncation length is exclusive — 120-char output is unchanged', () => {
      // `"` + 118 chars + `"` = 120 chars total, which equals the limit
      // and is NOT truncated (the comparison is strictly `>`).
      const input = 'a'.repeat(118);
      const result = truncateForErrorEmbed(input);
      expect(result.length).toBe(120);
      expect(result.endsWith('…')).toBe(false);
    });

    it('truncation kicks in at 121 chars (one above limit)', () => {
      const input = 'a'.repeat(119);
      const result = truncateForErrorEmbed(input);
      // Output before truncation: `"` + 119 + `"` = 121 chars > 120 cap.
      expect(result.length).toBe(121);
      expect(result.endsWith('…')).toBe(true);
    });
  });

  describe('combined: control-char + ANSI + truncate (T-077b composite)', () => {
    it('redacts \\x00 + \\x07 + ANSI red, JSON-stringifies, truncates if needed', () => {
      const input = '\x00\x07\x1B[31mhello\x1B[0m';
      const result = truncateForErrorEmbed(input);
      // The two C0 chars become two redactions; the ANSI red + reset are
      // each one redaction. JSON-stringified.
      expect(result).toBe(
        '"[redacted-control][redacted-control][redacted-control]hello[redacted-control]"',
      );
      expect(result).not.toMatch(/\x00|\x07|\x1B/);
    });
  });
});

describe('summarizeError (NFR-DR-S-008 logger meta shape)', () => {
  it('returns { name, message } for a real Error with JSON-stringified message', () => {
    const err = new Error('bang');
    err.name = 'CustomError';
    expect(summarizeError(err)).toEqual({
      name: 'CustomError',
      message: '"bang"',
    });
  });

  it('truncates the message when the Error message is longer than 120 chars', () => {
    const err = new Error('x'.repeat(500));
    const summary = summarizeError(err);
    expect(summary.name).toBe('Error');
    expect(summary.message.length).toBe(121);
    expect(summary.message.endsWith('…')).toBe(true);
  });

  it('redacts control bytes in Error.message (NFR-DR-S-008)', () => {
    const err = new Error('msg\x00with\x07control');
    const summary = summarizeError(err);
    expect(summary.message).toContain('[redacted-control]');
    expect(summary.message).not.toContain('\x00');
    expect(summary.message).not.toContain('\x07');
  });

  it('falls back to { name: "Error", message: <safe> } for non-Error throws', () => {
    expect(summarizeError('plain-string')).toEqual({
      name: 'Error',
      message: '"plain-string"',
    });
    expect(summarizeError(42)).toEqual({
      name: 'Error',
      message: '"42"',
    });
    expect(summarizeError(null)).toEqual({
      name: 'Error',
      message: '"null"',
    });
    expect(summarizeError(undefined)).toEqual({
      name: 'Error',
      message: '"undefined"',
    });
  });

  it('truncates non-Error string throws to 120 chars + ellipsis', () => {
    const summary = summarizeError('y'.repeat(500));
    expect(summary.name).toBe('Error');
    expect(summary.message.length).toBe(121);
  });
});
