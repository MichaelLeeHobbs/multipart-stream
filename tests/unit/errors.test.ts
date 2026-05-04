import { describe, expect, it } from 'vitest';

import {
  MultipartAbortError,
  MultipartHeadersTooLargeError,
  MultipartIdleTimeoutError,
  MultipartPartTooLargeError,
  MultipartTooManyPartsError,
  MultipartTotalTimeoutError,
  MultipartTruncatedError,
} from '../../src/errors.js';

/**
 * T-021 / T-082: error class identity, instanceof, name, cause, structured
 * properties — for all 7 error classes (FR-019, NFR-DR-S-001/004/012,
 * NFR-DR-D-007).
 */
describe('error classes (FR-019, NFR-DR-S-001/004/012, NFR-DR-D-007)', () => {
  describe('MultipartIdleTimeoutError', () => {
    it('is instanceof Error and itself; name is the verbatim class name', () => {
      const err = new MultipartIdleTimeoutError(5000);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MultipartIdleTimeoutError);
      expect(err.name).toBe('MultipartIdleTimeoutError');
    });

    it('roundtrips its structured property', () => {
      const err = new MultipartIdleTimeoutError(5000);
      expect(err.idleTimeoutMs).toBe(5000);
    });

    it('plumbs cause via { cause }', () => {
      const inner = new Error('inner');
      const err = new MultipartIdleTimeoutError(5000, { cause: inner });
      expect(err.cause).toBe(inner);
    });

    it('has a non-empty message that mentions the timeout', () => {
      const err = new MultipartIdleTimeoutError(5000);
      expect(err.message).toMatch(/idle timeout/i);
      expect(err.message).toContain('5000');
    });
  });

  describe('MultipartTotalTimeoutError', () => {
    it('is instanceof Error and itself; name is verbatim', () => {
      const err = new MultipartTotalTimeoutError(60_000);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MultipartTotalTimeoutError);
      expect(err.name).toBe('MultipartTotalTimeoutError');
    });

    it('roundtrips totalTimeoutMs and supports cause', () => {
      const inner = new Error('inner');
      const err = new MultipartTotalTimeoutError(60_000, { cause: inner });
      expect(err.totalTimeoutMs).toBe(60_000);
      expect(err.cause).toBe(inner);
      expect(err.message).toContain('60000');
    });
  });

  describe('MultipartAbortError', () => {
    it('is instanceof Error and itself; name is verbatim', () => {
      const err = new MultipartAbortError();
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MultipartAbortError);
      expect(err.name).toBe('MultipartAbortError');
    });

    it('exposes the caller-supplied reason verbatim, or undefined', () => {
      const reason = { code: 'USER_CANCEL', detail: 'clicked back' };
      const err = new MultipartAbortError(reason);
      expect(err.reason).toBe(reason);

      const errNoReason = new MultipartAbortError();
      expect(errNoReason.reason).toBeUndefined();
    });

    it('does NOT embed reason into the message (NFR-DR-S-006 / F-S-006)', () => {
      const err = new MultipartAbortError(
        'attacker-controlled CRLF here\r\n[redact me]',
      );
      // The message is constant — no caller bytes flow into it.
      expect(err.message).toBe('multipart: operation aborted');
    });

    it('plumbs cause via { cause }', () => {
      const inner = new Error('upstream');
      const err = new MultipartAbortError(undefined, { cause: inner });
      expect(err.cause).toBe(inner);
    });
  });

  describe('MultipartTruncatedError', () => {
    it('is instanceof Error and itself; name is verbatim', () => {
      const err = new MultipartTruncatedError(12_345);
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MultipartTruncatedError);
      expect(err.name).toBe('MultipartTruncatedError');
    });

    it('roundtrips bytesReceived and supports cause', () => {
      const inner = new Error('socket cut');
      const err = new MultipartTruncatedError(12_345, { cause: inner });
      expect(err.bytesReceived).toBe(12_345);
      expect(err.cause).toBe(inner);
      expect(err.message).toContain('12345');
    });
  });

  describe('MultipartPartTooLargeError', () => {
    it('is instanceof Error and itself; name is verbatim', () => {
      const err = new MultipartPartTooLargeError({
        maxPartBytes: 4096,
        partIndex: 0,
        bytesReceived: 5000,
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MultipartPartTooLargeError);
      expect(err.name).toBe('MultipartPartTooLargeError');
    });

    it('roundtrips structured fields', () => {
      const err = new MultipartPartTooLargeError({
        maxPartBytes: 4096,
        partIndex: 2,
        bytesReceived: 5500,
      });
      expect(err.maxPartBytes).toBe(4096);
      expect(err.partIndex).toBe(2);
      expect(err.bytesReceived).toBe(5500);
    });

    it('plumbs cause', () => {
      const inner = new Error('inner');
      const err = new MultipartPartTooLargeError(
        { maxPartBytes: 1, partIndex: 0, bytesReceived: 2 },
        { cause: inner },
      );
      expect(err.cause).toBe(inner);
    });
  });

  describe('MultipartHeadersTooLargeError', () => {
    it('is instanceof Error and itself; name is verbatim', () => {
      const err = new MultipartHeadersTooLargeError({
        limit: 'count',
        partIndex: 0,
        cap: 100,
        observed: 150,
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MultipartHeadersTooLargeError);
      expect(err.name).toBe('MultipartHeadersTooLargeError');
    });

    it('roundtrips both limit modes', () => {
      const countErr = new MultipartHeadersTooLargeError({
        limit: 'count',
        partIndex: 0,
        cap: 100,
        observed: 150,
      });
      expect(countErr.limit).toBe('count');
      expect(countErr.cap).toBe(100);
      expect(countErr.observed).toBe(150);

      const bytesErr = new MultipartHeadersTooLargeError({
        limit: 'bytes',
        partIndex: 3,
        cap: 16384,
        observed: 32768,
      });
      expect(bytesErr.limit).toBe('bytes');
      expect(bytesErr.partIndex).toBe(3);
      expect(bytesErr.cap).toBe(16384);
      expect(bytesErr.observed).toBe(32768);
    });

    it('plumbs cause', () => {
      const inner = new Error('inner');
      const err = new MultipartHeadersTooLargeError(
        { limit: 'count', partIndex: 0, cap: 1, observed: 2 },
        { cause: inner },
      );
      expect(err.cause).toBe(inner);
    });
  });

  describe('MultipartTooManyPartsError', () => {
    it('is instanceof Error and itself; name is verbatim', () => {
      const err = new MultipartTooManyPartsError({
        maxParts: 10,
        observed: 11,
      });
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(MultipartTooManyPartsError);
      expect(err.name).toBe('MultipartTooManyPartsError');
    });

    it('roundtrips structured fields', () => {
      const err = new MultipartTooManyPartsError({
        maxParts: 10_000,
        observed: 10_001,
      });
      expect(err.maxParts).toBe(10_000);
      expect(err.observed).toBe(10_001);
    });

    it('plumbs cause', () => {
      const inner = new Error('inner');
      const err = new MultipartTooManyPartsError(
        { maxParts: 1, observed: 2 },
        { cause: inner },
      );
      expect(err.cause).toBe(inner);
    });
  });

  describe('cross-format err.name fallback (NFR-DR-D-007)', () => {
    it('every class has a stable readonly name matching its class name verbatim', () => {
      // T-082 unit assertion. The cross-format integration assertion
      // lives in tests/integration/cross-format.test.ts (spawned-child
      // consumer test).
      const cases: Array<[string, Error]> = [
        ['MultipartIdleTimeoutError', new MultipartIdleTimeoutError(1)],
        ['MultipartTotalTimeoutError', new MultipartTotalTimeoutError(1)],
        ['MultipartAbortError', new MultipartAbortError()],
        ['MultipartTruncatedError', new MultipartTruncatedError(0)],
        [
          'MultipartPartTooLargeError',
          new MultipartPartTooLargeError({
            maxPartBytes: 1,
            partIndex: 0,
            bytesReceived: 2,
          }),
        ],
        [
          'MultipartHeadersTooLargeError',
          new MultipartHeadersTooLargeError({
            limit: 'count',
            partIndex: 0,
            cap: 1,
            observed: 2,
          }),
        ],
        [
          'MultipartTooManyPartsError',
          new MultipartTooManyPartsError({ maxParts: 1, observed: 2 }),
        ],
      ];
      for (const [expectedName, err] of cases) {
        expect(err.name).toBe(expectedName);
      }
    });
  });
});
