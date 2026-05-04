/**
 * `validatePositiveTimeout` — centralized timeout validation for both public
 * entry points (`parseMultipartRelated` and `fetchAndHandleMultipart`) per
 * `kiln/spec/data-model.md` §2.11.
 *
 * Per FR-006 / JC-3 / NFR-DR-S-009, both `idleTimeoutMs` and `totalTimeoutMs`
 * are REQUIRED on every entry point and MUST be positive finite integers in
 * the inclusive range `[1, 2_147_483_647]` (`2^31 - 1`). Values outside this
 * range are rejected synchronously with `TypeError` whose message names the
 * field and explains Node's internal `setTimeout` clamping behavior — any
 * delay greater than `2^31 - 1` ms is silently clamped down to `1` ms, which
 * would be a silent debugging surprise.
 *
 * The function is a TypeScript assertion function so callers can call it on
 * `opts.idleTimeoutMs` and have the type narrow afterward, even though the
 * input declared type is `number` (no run-time narrowing happens — the assert
 * just tells the type system that any execution past this point has the
 * range invariant).
 *
 * @internal
 */

/** Inclusive upper bound (`2^31 - 1`); Node's `setTimeout` clamps above this. */
const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

/**
 * Validate an `idleTimeoutMs` / `totalTimeoutMs` value. Throws `TypeError`
 * synchronously on `NaN`, non-finite, non-integer, `< 1`, or `> 2^31 - 1`.
 *
 * The error message MUST mention Node's `setTimeout` clamping behavior so
 * callers understand why the bound exists (NFR-DR-S-009).
 *
 * @param name - The option name (`idleTimeoutMs` or `totalTimeoutMs`) — used
 *   verbatim in the error message so the caller knows which field tripped.
 * @param value - The value to validate. Declared `unknown` so callers who
 *   pass an untyped record (e.g. JSON.parse output) get the same validation
 *   without a static `as number` cast.
 *
 * @throws {TypeError} when `value` is not a number, not finite, not an
 *   integer, less than 1, or greater than `2_147_483_647`.
 *
 * @example
 *   validatePositiveTimeout('idleTimeoutMs', opts.idleTimeoutMs);
 *   validatePositiveTimeout('totalTimeoutMs', opts.totalTimeoutMs);
 *   // After both calls, opts.idleTimeoutMs / totalTimeoutMs are guaranteed
 *   // to be valid integers in [1, 2^31 - 1].
 *
 * @internal
 */
export function validatePositiveTimeout(
  name: 'idleTimeoutMs' | 'totalTimeoutMs',
  value: unknown,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_SAFE_TIMEOUT_MS
  ) {
    const observed =
      typeof value === 'number' ? String(value) : typeof value;
    throw new TypeError(
      `multipart: ${name} must be a positive finite integer in [1, 2_147_483_647]; got ${observed}. Note: Node's setTimeout clamps values above 2^31-1 to 1ms, so larger timeouts are silently broken.`,
    );
  }
}
