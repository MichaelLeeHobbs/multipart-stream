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
import { summarizeError } from './format-error-embed.js';

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
 * Resolve a caller-supplied `Logger` to a defined function: {@link
 * defaultLogger} when omitted, otherwise the caller's logger wrapped so that
 * a throwing logger is reported to the default sink instead of escaping from
 * a stream listener or a promise callback. Library code calls the resolved
 * logger uniformly with event-style payloads.
 *
 * @param logger - Caller-supplied logger (or undefined).
 * @returns The resolved logger function.
 *
 * @internal
 */
export function resolveLogger(logger: Logger | undefined): Logger {
  if (logger === undefined) return defaultLogger;
  return (event) => {
    try {
      logger(event);
    } catch (err) {
      defaultLogger({
        level: 'warn',
        msg: 'multipart: logger threw',
        meta: { event: event.msg, errSummary: summarizeError(err) },
      });
    }
  };
}
