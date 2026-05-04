/**
 * Listener-leak harness, per `kiln/spec/test-plan.md` "Conventions" → "Listener
 * -leak harness".
 *
 * Patches `Dicer.prototype.emit` to record every Dicer instance that fires
 * any event AND every per-part `Readable` emitted on the `'part'` event.
 * Tests use these references to assert `listenerCount('part') === 0`,
 * `listenerCount('error') >= 1`, and `.destroyed === true` on every
 * termination path (Resource-Leak Hygiene Suite — `kiln/spec/test-plan.md`
 * §"Resource-Leak Hygiene Suite").
 *
 * Patching the prototype is reversible (call `restore()` in `afterEach`)
 * and works regardless of whether the production code resolved the dicer
 * default-export normalization (FR-DR-A-028) to the namespace or to its
 * `.default` property — both shapes share the same prototype object.
 *
 * Not part of the published surface — lives under `tests/fixtures/`.
 */

import type { Readable, Writable } from 'node:stream';

import dicerMod from 'dicer';

type DicerCtor = new (opts: { boundary: string }) => Writable;
type EmitFn = (event: string | symbol, ...args: unknown[]) => boolean;

const RawDicer: DicerCtor = (
  (dicerMod as unknown as { default?: DicerCtor }).default ?? dicerMod
) as unknown as DicerCtor;

/**
 * Tracker shape returned by {@link captureDicerActivity}. The reference
 * arrays are LIVE — they grow as events fire; tests that snapshot them
 * should `[...arr]` at assertion time.
 */
export interface DicerActivityTracker {
  /**
   * Every Dicer instance that has emitted at least one event since
   * `captureDicerActivity()` ran. Note: we capture on first emit rather
   * than at construction so we don't need to subclass the constructor.
   */
  dicerInstances(): readonly Writable[];
  /** Every per-part Readable emitted on a captured Dicer's 'part' event. */
  partStreams(): readonly Readable[];
  /** Reset both arrays without un-patching. */
  resetTracking(): void;
  /** Restore the original prototype (call from `afterEach`). */
  restore(): void;
}

/**
 * Patch `Dicer.prototype.emit` so every event records its emitter (a Dicer
 * instance) and every `'part'` event records the per-part Readable. Call
 * once per test (typically in `beforeEach`); the returned tracker exposes
 * accessors and a `restore()` for `afterEach`.
 *
 * Implementation note: the patch is in-place on the prototype, so it
 * affects every Dicer instance constructed in the test process for the
 * duration of the patch. Calling `restore()` un-patches.
 */
export function captureDicerActivity(): DicerActivityTracker {
  const instances = new Set<Writable>();
  const parts: Readable[] = [];

  const proto = RawDicer.prototype as unknown as { emit: EmitFn };
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
    dicerInstances: () => Array.from(instances),
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
