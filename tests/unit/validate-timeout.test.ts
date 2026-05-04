/**
 * Unit tests for `validatePositiveTimeout` (FR-006 / NFR-DR-S-009).
 *
 * Covers T-060..T-065 (the 0/NaN/Infinity/-1/1.5/both-names table) PLUS
 * boundary tests: `1` and `2_147_483_647` PASS; `2_147_483_648` and
 * `Number.MAX_SAFE_INTEGER` FAIL. T-079 is the dedicated upper-bound row.
 *
 * Also asserts the error message contains `setTimeout` (NFR-DR-S-009
 * mandates the message explain Node's clamping behavior).
 */

import { describe, expect, it } from 'vitest';

import { validatePositiveTimeout } from '../../src/internal/validate-timeout.js';

const CLAMPING_MESSAGE_PATTERN = /setTimeout/;
const POSITIVE_INTEGER_MESSAGE_PATTERN =
  /must be a positive finite integer/;

describe('validatePositiveTimeout — happy paths (boundary inclusive)', () => {
  it('accepts 1 (lower bound — inclusive)', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', 1),
    ).not.toThrow();
    expect(() =>
      validatePositiveTimeout('totalTimeoutMs', 1),
    ).not.toThrow();
  });

  it('accepts 2_147_483_647 (upper bound — inclusive, 2^31 - 1)', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', 2_147_483_647),
    ).not.toThrow();
    expect(() =>
      validatePositiveTimeout('totalTimeoutMs', 2_147_483_647),
    ).not.toThrow();
  });

  it('accepts a typical mid-range value (5000)', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', 5_000),
    ).not.toThrow();
    expect(() =>
      validatePositiveTimeout('totalTimeoutMs', 60_000),
    ).not.toThrow();
  });
});

describe('validatePositiveTimeout — T-060..T-065 rejection table', () => {
  // Each row is run for BOTH idleTimeoutMs AND totalTimeoutMs (T-065 mirror
  // of T-060..T-064) so we verify the field name is interpolated correctly.
  type Row = {
    readonly id: string;
    readonly value: unknown;
    readonly label: string;
  };
  const rows: readonly Row[] = [
    { id: 'T-060', value: 0, label: 'zero' },
    { id: 'T-061', value: Number.NaN, label: 'NaN' },
    { id: 'T-062a', value: Number.POSITIVE_INFINITY, label: '+Infinity' },
    { id: 'T-062b', value: Number.NEGATIVE_INFINITY, label: '-Infinity' },
    { id: 'T-063', value: -1, label: '-1' },
    { id: 'T-064', value: 1.5, label: '1.5 (non-integer)' },
    { id: 'T-064b', value: 0.999, label: '0.999 (non-integer < 1)' },
  ];

  for (const row of rows) {
    it(`${row.id}: rejects ${row.label} on idleTimeoutMs with TypeError`, () => {
      expect(() =>
        validatePositiveTimeout('idleTimeoutMs', row.value),
      ).toThrow(TypeError);
      expect(() =>
        validatePositiveTimeout('idleTimeoutMs', row.value),
      ).toThrow(POSITIVE_INTEGER_MESSAGE_PATTERN);
      expect(() =>
        validatePositiveTimeout('idleTimeoutMs', row.value),
      ).toThrow(/idleTimeoutMs/);
    });

    it(`${row.id}: rejects ${row.label} on totalTimeoutMs with TypeError`, () => {
      expect(() =>
        validatePositiveTimeout('totalTimeoutMs', row.value),
      ).toThrow(TypeError);
      expect(() =>
        validatePositiveTimeout('totalTimeoutMs', row.value),
      ).toThrow(POSITIVE_INTEGER_MESSAGE_PATTERN);
      expect(() =>
        validatePositiveTimeout('totalTimeoutMs', row.value),
      ).toThrow(/totalTimeoutMs/);
    });
  }
});

describe('validatePositiveTimeout — non-number inputs', () => {
  it('rejects undefined (the missing-required-field case) with TypeError', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', undefined),
    ).toThrow(TypeError);
    expect(() =>
      validatePositiveTimeout('totalTimeoutMs', undefined),
    ).toThrow(/totalTimeoutMs/);
  });

  it('rejects null with TypeError', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', null),
    ).toThrow(TypeError);
  });

  it('rejects string-shaped values ("5000")', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', '5000'),
    ).toThrow(TypeError);
  });

  it('rejects boolean inputs', () => {
    expect(() => validatePositiveTimeout('idleTimeoutMs', true)).toThrow(
      TypeError,
    );
    expect(() => validatePositiveTimeout('idleTimeoutMs', false)).toThrow(
      TypeError,
    );
  });

  it('rejects object inputs', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', { ms: 5000 }),
    ).toThrow(TypeError);
  });
});

describe('validatePositiveTimeout — upper-bound enforcement (NFR-DR-S-009)', () => {
  // The upper-bound reject is enforced by the implementation; the
  // dedicated T-079 test below locks the behavior in.
  it('T-064b: rejects 2_147_483_648 (one above 2^31 - 1)', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', 2_147_483_648),
    ).toThrow(TypeError);
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', 2_147_483_648),
    ).toThrow(CLAMPING_MESSAGE_PATTERN);
  });

  it('rejects 2 ** 31 (== 2_147_483_648)', () => {
    expect(() =>
      validatePositiveTimeout('totalTimeoutMs', 2 ** 31),
    ).toThrow(TypeError);
  });

  it('rejects Number.MAX_SAFE_INTEGER', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', Number.MAX_SAFE_INTEGER),
    ).toThrow(TypeError);
  });

  it('error message mentions setTimeout clamping (NFR-DR-S-009)', () => {
    let captured: unknown;
    try {
      validatePositiveTimeout('idleTimeoutMs', 2_147_483_648);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(TypeError);
    expect((captured as Error).message).toMatch(/setTimeout/);
    expect((captured as Error).message).toMatch(/2\^31/);
  });
});

describe('validatePositiveTimeout — T-079 dedicated upper-bound assertion (NFR-DR-S-009)', () => {
  // T-079 row from kiln/spec/test-plan.md: "input 2_147_483_647 PASSES
  // (boundary-inclusive); inputs 2_147_483_648, 2^31, Number.MAX_SAFE_INTEGER
  // all throw TypeError whose message mentions setTimeout clamping."
  // T-079 is the dedicated row that asserts the contract end-to-end.
  it('T-079: 2_147_483_647 (boundary-inclusive upper bound) PASSES', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', 2_147_483_647),
    ).not.toThrow();
    expect(() =>
      validatePositiveTimeout('totalTimeoutMs', 2_147_483_647),
    ).not.toThrow();
  });

  it('T-079: 2_147_483_648 throws TypeError mentioning setTimeout clamping', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', 2_147_483_648),
    ).toThrow(TypeError);
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', 2_147_483_648),
    ).toThrow(/setTimeout/);
  });

  it('T-079: 2 ** 31 throws TypeError mentioning setTimeout clamping', () => {
    expect(() => validatePositiveTimeout('idleTimeoutMs', 2 ** 31)).toThrow(
      TypeError,
    );
    expect(() => validatePositiveTimeout('totalTimeoutMs', 2 ** 31)).toThrow(
      /setTimeout/,
    );
  });

  it('T-079: Number.MAX_SAFE_INTEGER throws TypeError mentioning setTimeout clamping', () => {
    expect(() =>
      validatePositiveTimeout('idleTimeoutMs', Number.MAX_SAFE_INTEGER),
    ).toThrow(TypeError);
    expect(() =>
      validatePositiveTimeout('totalTimeoutMs', Number.MAX_SAFE_INTEGER),
    ).toThrow(/setTimeout/);
  });

  it('T-079: each rejection message names the field and mentions 2^31', () => {
    let captured: unknown;
    try {
      validatePositiveTimeout('idleTimeoutMs', 2_147_483_648);
    } catch (err) {
      captured = err;
    }
    const msg = (captured as Error).message;
    expect(msg).toMatch(/idleTimeoutMs/);
    expect(msg).toMatch(/2\^31/);
    expect(msg).toMatch(/setTimeout/);

    let captured2: unknown;
    try {
      validatePositiveTimeout('totalTimeoutMs', Number.MAX_SAFE_INTEGER);
    } catch (err) {
      captured2 = err;
    }
    const msg2 = (captured2 as Error).message;
    expect(msg2).toMatch(/totalTimeoutMs/);
    expect(msg2).toMatch(/setTimeout/);
  });
});

describe('validatePositiveTimeout — error message shape', () => {
  it('includes the field name verbatim and the observed value', () => {
    let captured: unknown;
    try {
      validatePositiveTimeout('idleTimeoutMs', -5);
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).message).toMatch(/idleTimeoutMs/);
    expect((captured as Error).message).toMatch(/-5/);
  });

  it('reports the observed type name when value is not a number', () => {
    let captured: unknown;
    try {
      validatePositiveTimeout('totalTimeoutMs', 'not-a-number');
    } catch (err) {
      captured = err;
    }
    expect((captured as Error).message).toMatch(/string/);
  });
});
