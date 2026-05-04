/**
 * Public error classes (FR-019, NFR-DR-S-001, NFR-DR-S-004, NFR-DR-S-012,
 * NFR-DR-D-007).
 *
 * Every class:
 *   - extends `Error`
 *   - sets `this.name` literally to its class-name string in the constructor
 *     (NFR-DR-D-007 — survives minification AND is the documented fallback
 *     when `instanceof` returns false across the ESM/CJS module-format
 *     boundary)
 *   - supports `cause` plumbing via `super(message, options)`
 *   - exposes typed structured property fields for caller-side branching
 *
 * The classes are runtime values (NFR-012); consumers may import them as
 * values for `instanceof` checks AND as types in signatures.
 */

/**
 * Thrown when no source-stream bytes arrive for `idleTimeoutMs` consecutive
 * milliseconds. The source has been destroyed and all listeners removed by
 * the time this surfaces.
 *
 * @example
 *   try {
 *     await fetchAndHandleMultipart(url, { idleTimeoutMs: 5000, totalTimeoutMs: 60_000, parser });
 *   } catch (err) {
 *     if (err instanceof MultipartIdleTimeoutError) {
 *       metrics.increment('multipart.idle_timeout', { ms: err.idleTimeoutMs });
 *     }
 *     throw err;
 *   }
 */
export class MultipartIdleTimeoutError extends Error {
  /** Stable cross-format discriminator (NFR-DR-D-007). */
  override readonly name = 'MultipartIdleTimeoutError';
  /** The configured idle window (ms) that elapsed without source activity. */
  readonly idleTimeoutMs: number;

  /**
   * @param idleTimeoutMs - The configured idle window in ms.
   * @param options - Optional `{ cause }` for wrapping a lower-level error.
   */
  constructor(idleTimeoutMs: number, options?: ErrorOptions) {
    super(`multipart: idle timeout (${String(idleTimeoutMs)}ms)`, options);
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

/**
 * Thrown when the total wallclock budget (`totalTimeoutMs`) elapses,
 * regardless of source activity.
 *
 * @example
 *   if (err instanceof MultipartTotalTimeoutError) {
 *     metrics.increment('multipart.total_timeout');
 *   }
 */
export class MultipartTotalTimeoutError extends Error {
  override readonly name = 'MultipartTotalTimeoutError';
  /** The configured total window (ms) that elapsed. */
  readonly totalTimeoutMs: number;

  /**
   * @param totalTimeoutMs - The configured total budget in ms.
   * @param options - Optional `{ cause }`.
   */
  constructor(totalTimeoutMs: number, options?: ErrorOptions) {
    super(`multipart: total timeout (${String(totalTimeoutMs)}ms)`, options);
    this.totalTimeoutMs = totalTimeoutMs;
  }
}

/**
 * Thrown when the caller-provided `AbortSignal` fires (FR-009), or is already
 * aborted at call time. `reason` carries the signal's `reason` verbatim, or
 * is `undefined` if the signal had no reason. The library NEVER synthesizes
 * a server-derived reason (F-S-006).
 *
 * @example
 *   const ctrl = new AbortController();
 *   setTimeout(() => ctrl.abort(new Error('user cancelled')), 5000);
 *   try {
 *     await fetchAndHandleMultipart(url, { signal: ctrl.signal, idleTimeoutMs: 5000, totalTimeoutMs: 30000, parser });
 *   } catch (err) {
 *     if (err instanceof MultipartAbortError) console.warn('aborted because:', err.reason);
 *   }
 */
export class MultipartAbortError extends Error {
  override readonly name = 'MultipartAbortError';
  /**
   * The signal's `reason` if the caller supplied one, else `undefined`. Per
   * F-S-006 the library never synthesizes a reason that embeds server bytes.
   */
  readonly reason?: unknown;

  /**
   * @param reason - Optional caller-supplied abort reason.
   * @param options - Optional `{ cause }`.
   */
  constructor(reason?: unknown, options?: ErrorOptions) {
    // We deliberately do NOT embed `reason` into the message (NFR-DR-S-006:
    // attacker-controlled bytes do not flow into log lines via this path).
    super('multipart: operation aborted', options);
    if (reason !== undefined) this.reason = reason;
  }
}

/**
 * Thrown when the source stream ends without dicer observing the closing
 * multipart boundary (FR-022) — typically a mid-flight server hangup or
 * transport-layer cut. Cleanup per FR-010 still runs.
 *
 * @example
 *   if (err instanceof MultipartTruncatedError) {
 *     retryQueue.enqueue({ url, bytesReceived: err.bytesReceived });
 *   }
 */
export class MultipartTruncatedError extends Error {
  override readonly name = 'MultipartTruncatedError';
  /** Total bytes pulled from the source before it ended prematurely. */
  readonly bytesReceived: number;

  /**
   * @param bytesReceived - Cumulative bytes received before the source ended.
   * @param options - Optional `{ cause }`.
   */
  constructor(bytesReceived: number, options?: ErrorOptions) {
    super(
      `multipart: stream ended before closing boundary (${String(
        bytesReceived,
      )}B received)`,
      options,
    );
    this.bytesReceived = bytesReceived;
  }
}

/**
 * Info-bag for {@link MultipartPartTooLargeError}.
 */
export interface MultipartPartTooLargeInfo {
  /** The configured `maxPartBytes` cap that was exceeded. */
  readonly maxPartBytes: number;
  /** Zero-based ordinal of the offending part. */
  readonly partIndex: number;
  /** Bytes observed at the moment the cap tripped. */
  readonly bytesReceived: number;
}

/**
 * Thrown when a part body's accumulated bytes exceed `maxPartBytes`
 * (NFR-DR-S-001). The offending part body is destroyed and full FR-010
 * cleanup runs before this surfaces.
 *
 * @example
 *   if (err instanceof MultipartPartTooLargeError) {
 *     metrics.increment('multipart.part_too_large', { partIndex: err.partIndex });
 *   }
 */
export class MultipartPartTooLargeError extends Error {
  override readonly name = 'MultipartPartTooLargeError';
  readonly maxPartBytes: number;
  readonly partIndex: number;
  readonly bytesReceived: number;

  /**
   * @param info - Structured trip info: `{ maxPartBytes, partIndex, bytesReceived }`.
   * @param options - Optional `{ cause }`.
   */
  constructor(info: MultipartPartTooLargeInfo, options?: ErrorOptions) {
    super(
      `multipart: part ${String(info.partIndex)} exceeded maxPartBytes (${String(
        info.maxPartBytes,
      )}) at ${String(info.bytesReceived)}B`,
      options,
    );
    this.maxPartBytes = info.maxPartBytes;
    this.partIndex = info.partIndex;
    this.bytesReceived = info.bytesReceived;
  }
}

/**
 * Info-bag for {@link MultipartHeadersTooLargeError}.
 */
export interface MultipartHeadersTooLargeInfo {
  /** Discriminator: which limit was hit. */
  readonly limit: 'count' | 'bytes';
  /** Zero-based ordinal of the offending part. */
  readonly partIndex: number;
  /** The configured cap. */
  readonly cap: number;
  /** Observed value at trip-time. */
  readonly observed: number;
}

/**
 * Thrown when a part has more headers than `maxHeadersPerPart` (default 100)
 * OR its header block bytes exceed `maxHeaderBytesPerPart` (default 16 KiB)
 * — NFR-DR-S-004.
 *
 * @example
 *   if (err instanceof MultipartHeadersTooLargeError) {
 *     log.warn({ limit: err.limit, observed: err.observed }, 'oversized part headers');
 *   }
 */
export class MultipartHeadersTooLargeError extends Error {
  override readonly name = 'MultipartHeadersTooLargeError';
  readonly limit: 'count' | 'bytes';
  readonly partIndex: number;
  readonly cap: number;
  readonly observed: number;

  /**
   * @param info - Structured trip info: `{ limit, partIndex, cap, observed }`.
   * @param options - Optional `{ cause }`.
   */
  constructor(info: MultipartHeadersTooLargeInfo, options?: ErrorOptions) {
    super(
      `multipart: part ${String(info.partIndex)} headers exceeded ${info.limit} cap (${String(
        info.cap,
      )}) at ${String(info.observed)}`,
      options,
    );
    this.limit = info.limit;
    this.partIndex = info.partIndex;
    this.cap = info.cap;
    this.observed = info.observed;
  }
}

/**
 * Info-bag for {@link MultipartTooManyPartsError}.
 */
export interface MultipartTooManyPartsInfo {
  /** The configured `maxParts` cap that was exceeded. */
  readonly maxParts: number;
  /** Observed part count when the cap tripped (== `maxParts + 1`). */
  readonly observed: number;
}

/**
 * Thrown when the multipart envelope contains more parts than `maxParts`
 * (default `10_000`) — NFR-DR-S-012.
 *
 * @example
 *   if (err instanceof MultipartTooManyPartsError) {
 *     log.warn({ cap: err.maxParts }, 'too many parts');
 *   }
 */
export class MultipartTooManyPartsError extends Error {
  override readonly name = 'MultipartTooManyPartsError';
  readonly maxParts: number;
  readonly observed: number;

  /**
   * @param info - Structured trip info: `{ maxParts, observed }`.
   * @param options - Optional `{ cause }`.
   */
  constructor(info: MultipartTooManyPartsInfo, options?: ErrorOptions) {
    super(
      `multipart: envelope exceeded maxParts (${String(info.maxParts)}) at part ${String(
        info.observed,
      )}`,
      options,
    );
    this.maxParts = info.maxParts;
    this.observed = info.observed;
  }
}
