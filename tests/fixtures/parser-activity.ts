/** Captures parser and part streams so cleanup tests can inspect listeners and destruction. */

import type { Readable, Writable } from 'node:stream';

import { MultipartParser } from '../../src/internal/multipart-parser.js';

type EmitFn = (event: string | symbol, ...args: unknown[]) => boolean;

/**
 * Tracker shape returned by {@link captureParserActivity}. The reference
 * arrays are LIVE — they grow as events fire; tests that snapshot them
 * should `[...arr]` at assertion time.
 */
export interface ParserActivityTracker {
  /**
   * Every Parser instance that has emitted at least one event since
   * `captureParserActivity()` ran. Note: we capture on first emit rather
   * than at construction so we don't need to subclass the constructor.
   */
  parserInstances(): readonly Writable[];
  /** Every per-part Readable emitted on a captured Parser's 'part' event. */
  partStreams(): readonly Readable[];
  /** Reset both arrays without un-patching. */
  resetTracking(): void;
  /** Restore the original prototype (call from `afterEach`). */
  restore(): void;
}

/**
 * Patch `Parser.prototype.emit` so every event records its emitter (a Parser
 * instance) and every `'part'` event records the per-part Readable. Call
 * once per test (typically in `beforeEach`); the returned tracker exposes
 * accessors and a `restore()` for `afterEach`.
 *
 * Implementation note: the patch is in-place on the prototype, so it
 * affects every Parser instance constructed in the test process for the
 * duration of the patch. Calling `restore()` un-patches.
 */
export function captureParserActivity(): ParserActivityTracker {
  const instances = new Set<Writable>();
  const parts: Readable[] = [];

  const proto = MultipartParser.prototype as unknown as { emit: EmitFn };
  const originalEmit = proto.emit;

  const patchedEmit = function (
    this: Writable,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    instances.add(this);
    if (event === 'part' && args.length > 0) {
      parts.push(args[0] as Readable);
    }
    return originalEmit.apply(this, [event, ...args]);
  };

  proto.emit = patchedEmit;

  return {
    parserInstances: () => Array.from(instances),
    partStreams: () => parts,
    resetTracking: () => {
      instances.clear();
      parts.length = 0;
    },
    restore: () => {
      proto.emit = originalEmit;
    },
  };
}
