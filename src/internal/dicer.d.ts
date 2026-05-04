/**
 * Ambient declaration shim for the `dicer` runtime dependency (FR-DR-A-027).
 *
 * `dicer@0.3.1` ships no `.d.ts` files and there is no `@types/dicer` on
 * DefinitelyTyped (and there has not been one for years). To keep the library
 * compiling under `strict` + `noImplicitAny` + `verbatimModuleSyntax` (NFR-001
 * / NFR-DR-A-013) without leaking `any` into consumer code, we hand-roll the
 * declarations here.
 *
 * Constraints (FR-DR-A-027 + T-071):
 *   - This file MUST type only the surface the library actually uses.
 *   - It MUST NOT depend on `@types/dicer`.
 *   - It MUST NOT leak any symbol or `from 'dicer'` import into the
 *     published `dist/index.d.ts`. The build-smoke grep gate (T-071)
 *     asserts this.
 *
 * The CJS/ESM dual-import normalization shape required by FR-DR-A-028 lives
 * at the call sites; the shim exposes both `export default` and `export =`
 * so the normalizer (`dicerMod.default ?? dicerMod`) typechecks under both
 * module formats.
 */
declare module 'dicer' {
  import type { Readable, Writable } from 'node:stream';

  /**
   * Per-part header bag emitted by dicer's per-part `'header'` event AND
   * exposed (when populated) on the per-part `Readable` itself. Values may
   * be `Buffer`, `Buffer[]`, or `Buffer[][]` depending on dicer's framing
   * heuristics; the library collapses every variant via
   * `flattenHeaderValue`.
   */
  export type DicerHeaderBag = Record<
    string,
    Buffer | Buffer[] | Buffer[][] | undefined
  >;

  /**
   * Per-part `Readable` emitted by dicer on its `'part'` event. `headers` is
   * either populated synchronously when `'part'` fires, or is delivered via
   * the per-part `'header'` event (dicer's behavior is version-dependent).
   * Consumers read whichever surfaces first.
   */
  export interface DicerPartStream extends Readable {
    headers?: DicerHeaderBag;
    on(event: 'header', listener: (h: DicerHeaderBag) => void): this;
    on(event: 'data', listener: (chunk: Buffer) => void): this;
    on(event: 'end' | 'close', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
  }

  export interface DicerOptions {
    boundary: string;
    headerFirst?: boolean;
    maxHeaderPairs?: number;
  }

  /**
   * The dicer constructor (default export under CJS module.exports).
   * Extends Node's `Writable` so the source `Readable` can `pipe()` to it.
   */
  class Dicer extends Writable {
    constructor(opts: DicerOptions);
    on(event: 'part', listener: (part: DicerPartStream) => void): this;
    on(event: 'finish', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'header', listener: (h: DicerHeaderBag) => void): this;
    on(event: 'preamble', listener: (part: DicerPartStream) => void): this;
  }

  // Both export forms are needed because `dicer` is a CJS module whose
  // `module.exports` is the constructor itself. Under ESM, Node wraps it as
  // `{ default: Dicer }`; under CJS it is the raw constructor. The
  // FR-DR-A-028 normalization at the call site (`dicerMod.default ?? dicerMod`)
  // works correctly against both shapes, and these declarations let it
  // typecheck without `as any`.
  export default Dicer;
  export = Dicer;
}
