import { describe, expect, it } from 'vitest';

import { extractBoundary } from '../../src/extract-boundary.js';

describe('extractBoundary (FR-016)', () => {
  describe('happy path (T-029, T-054)', () => {
    it('extracts a bare token boundary', () => {
      expect(extractBoundary('multipart/related; boundary=foo')).toBe('foo');
    });

    it('extracts a quoted-string boundary (RFC 2046)', () => {
      // T-054: quoted-string with embedded special chars
      expect(
        extractBoundary('multipart/related; boundary="weird;boundary"'),
      ).toBe('weird;boundary');
    });

    it('handles multiple parameters in any order', () => {
      expect(
        extractBoundary(
          'multipart/related; type="application/dicom"; boundary=BAR; charset=utf-8',
        ),
      ).toBe('BAR');
    });

    it('matches parameter name case-insensitively', () => {
      expect(extractBoundary('multipart/related; BOUNDARY=foo')).toBe('foo');
      expect(extractBoundary('multipart/related; Boundary=bar')).toBe('bar');
    });

    it('handles a quoted boundary with backslash escapes', () => {
      // \" inside the quoted string resolves to a literal "
      expect(extractBoundary('multipart/related; boundary="a\\"b"')).toBe(
        'a"b',
      );
    });

    it('handles whitespace around the equals sign and after the semicolon', () => {
      expect(extractBoundary('multipart/related;   boundary=baz')).toBe('baz');
      // Note: whitespace AROUND `=` is tolerated by browsers; we accept it too.
      expect(extractBoundary('multipart/related;  boundary =qux')).toBe('qux');
    });
  });

  describe('error paths', () => {
    it('throws when input is null', () => {
      expect(() => extractBoundary(null)).toThrow(
        /Content-Type header is required/,
      );
    });

    it('throws when input is undefined', () => {
      expect(() => extractBoundary(undefined)).toThrow(
        /Content-Type header is required/,
      );
    });

    it('throws when input is the empty string', () => {
      expect(() => extractBoundary('')).toThrow(
        /Content-Type header is required/,
      );
    });

    it('throws when boundary parameter is missing', () => {
      expect(() => extractBoundary('multipart/related')).toThrow(
        /boundary parameter missing from Content-Type/,
      );
      expect(() =>
        extractBoundary('multipart/related; type="application/dicom"'),
      ).toThrow(/boundary parameter missing from Content-Type/);
    });

    it('throws when boundary parameter is empty', () => {
      expect(() => extractBoundary('multipart/related; boundary=')).toThrow(
        /boundary parameter is empty/,
      );
      expect(() => extractBoundary('multipart/related; boundary=""')).toThrow(
        /boundary parameter is empty/,
      );
    });

    it('truncates long header values in error messages (NFR-DR-S-006)', () => {
      const longJunk = 'x'.repeat(500);
      try {
        extractBoundary(`multipart/related; type=${longJunk}`);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        // Full sanitizer: embedded value is JSON-stringified + truncated
        // to 120 chars + ellipsis. Total error message length stays well
        // under 300.
        expect(message.length).toBeLessThan(300);
        expect(message).toContain('…');
      }
    });

    it('NFR-DR-S-006: error message embeds JSON-stringified, control-redacted value', () => {
      // The embedded Content-Type value contains control bytes and a CR.
      // The sanitizer must redact them to `[redacted-control]`.
      const malicious = 'x\x00y\rz';
      try {
        extractBoundary(`multipart/related; type=${malicious}`);
        throw new Error('should have thrown');
      } catch (err) {
        const message = (err as Error).message;
        // Zero raw 0x00–0x1F bytes in the rendered error message.
        for (let i = 0; i < 0x20; i++) {
          expect(message).not.toContain(String.fromCharCode(i));
        }
        expect(message).not.toContain('\x7F');
        // The redaction token appears (proves the sanitizer ran).
        expect(message).toContain('[redacted-control]');
      }
    });
  });

  describe('NFR-DR-S-011 ReDoS resistance (T-080)', () => {
    it('parses a 64 KiB pathological input in well under 50 ms', () => {
      // Deliberately adversarial: a quoted-string boundary stuffed with
      // ~32 KiB of backslash-quote escape pairs (≈ 64 KiB total). A
      // backtracking regex would explode here; the hand-written tokenizer
      // is O(n) regardless of escape density.
      const pathological =
        'multipart/related; boundary="' + '\\"'.repeat(32_000) + '"';

      const ITERATIONS = 10;
      const start = performance.now();
      for (let i = 0; i < ITERATIONS; i++) {
        // We don't care about the result; we care about wall time.
        try {
          extractBoundary(pathological);
        } catch {
          // The tokenizer will return a value (possibly empty quoted
          // string content) — but if implementation evolves to throw on
          // unterminated escape, we still measure timing.
        }
      }
      const totalMs = performance.now() - start;
      const meanMs = totalMs / ITERATIONS;

      expect(meanMs).toBeLessThan(50);
    });
  });
});
