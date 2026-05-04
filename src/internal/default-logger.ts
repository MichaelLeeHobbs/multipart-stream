/**
 * Default logger fallback (FR-018).
 *
 * The PUBLIC `Logger` injection-point is event-style (JC-2):
 *   `(event: { level: 'warn'; msg: string; meta?: unknown }) => void`
 *
 * — but per FR-018, when the caller omits `logger`, internal warnings MUST
 * fall back to `console.warn(msg, meta)` (POSITIONAL — matches `console`'s
 * signature, NOT the event-style fn). This is the documented contract;
 * tests T-019 (event-style call) and T-020 (positional console.warn) both
 * assert it.
 *
 * The adapter below is therefore intentionally tiny: it accepts an event
 * and re-emits it positionally on `console.warn`. Library code that needs
 * to log MUST go through `defaultLogger` (or a caller-supplied `Logger`)
 * via the `resolveLogger` helper here so the fallback shape is honored
 * uniformly.
 */

import type { Logger } from '../types.js';

/**
 * Default `Logger` used when the caller did not supply one.
 *
 * Per FR-018, the fallback emits to `console.warn` with the POSITIONAL
 * `(msg, meta)` shape — NOT the event-style payload. This matches the
 * console API a Node operator expects and lets a stack-trace-grepping CI
 * pipeline find these warnings.
 *
 * `meta` is omitted from the call when undefined to avoid `console.warn
 * (msg, undefined)` rendering as `<msg> undefined` under some console
 * implementations.
 *
 * @internal
 */
export const defaultLogger: Logger = (event) => {
  if (event.meta === undefined) {
    console.warn(event.msg);
    return;
  }
  console.warn(event.msg, event.meta);
};

/**
 * Resolve a caller-supplied `Logger` to a defined function. When the caller
 * supplies one, return it as-is; when they omit it, return
 * {@link defaultLogger}. Library code calls the resolved logger uniformly
 * with event-style payloads — the internal `defaultLogger` is responsible
 * for re-shaping to the positional `console.warn` form.
 *
 * @param logger - Caller-supplied logger (or undefined).
 * @returns The resolved logger function.
 *
 * @internal
 */
export function resolveLogger(logger: Logger | undefined): Logger {
  return logger ?? defaultLogger;
}
