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
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'),
) as { dependencies: Record<string, string> };
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

  it('built entry points do not load dicer', () => {
    for (const file of ['index.js', 'index.cjs', 'index.d.ts']) {
      const output = readFileSync(resolve(distDir, file), 'utf8');
      expect(output).not.toMatch(/\bdicer\b/i);
    }
  });
});

it('runtime dependencies do not include dicer', () => {
  expect(manifest.dependencies).not.toHaveProperty('dicer');
  expect(manifest.dependencies).toHaveProperty('streamsearch');
});
