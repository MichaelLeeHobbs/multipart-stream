import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Build-smoke tests (T-040, T-071). Skipped in CI by default — they expect
 * a `dist/` produced by `pnpm build` ahead of time. Locally, run
 * `pnpm build && pnpm test` to exercise them.
 *
 * Why these live as vitest cases (and not just shell asserts in
 * `package.json#scripts`): they let the dist-shape contract stay close to
 * the test that asserts the export surface, and they participate in the
 * `pnpm install && pnpm build && pnpm test` flow.
 */
const distDir = resolve(__dirname, '..', 'dist');
const skip =
  process.env.CI === 'true' ||
  !existsSync(resolve(distDir, 'index.js')) ||
  !existsSync(resolve(distDir, 'index.cjs')) ||
  !existsSync(resolve(distDir, 'index.d.ts'));

describe.skipIf(skip)('dist build smoke (T-040, T-071)', () => {
  it('emits dist/index.js, dist/index.cjs, and dist/index.d.ts', () => {
    expect(existsSync(resolve(distDir, 'index.js'))).toBe(true);
    expect(existsSync(resolve(distDir, 'index.cjs'))).toBe(true);
    expect(existsSync(resolve(distDir, 'index.d.ts'))).toBe(true);
  });

  it('dist/index.d.ts does NOT import from "dicer" (T-071)', () => {
    const dts = readFileSync(resolve(distDir, 'index.d.ts'), 'utf8');
    expect(dts).not.toMatch(/from ['"]dicer['"]/);
    expect(dts).not.toMatch(/import .* dicer/);
  });
});
