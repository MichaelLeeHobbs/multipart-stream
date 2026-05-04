/**
 * Cross-format consumer tests (T-052, T-072, T-082).
 *
 * The in-process vitest harness can `import` the source via Vite's ESM
 * loader. These tests instead exercise the BUILT `dist/` bundle through
 * `child_process.spawn` so a real Node.js process ESM/CJS resolver picks
 * the bundle. This is the only place in the suite that exits the vitest
 * sandbox.
 *
 *  - T-052 / T-072: prove `require('./dist/index.cjs')` AND
 *    `await import('./dist/index.js')` BOTH yield a working
 *    `parseMultipartRelated` against a real envelope. Catches FR-DR-A-028
 *    regressions ("TypeError: Dicer is not a constructor") that vitest's
 *    transformer would mask because vitest reaches into the source via
 *    Rollup, not the published exports map.
 *  - T-082: prove the `err.name` cross-format fallback documented in the
 *    README's Error handling section actually works. We construct
 *    `MultipartIdleTimeoutError` from the CJS bundle and assert `err.name`
 *    is the literal class name (NFR-DR-D-007) — even when a hypothetical
 *    cross-bundle `instanceof` would return `false`.
 *
 * Spawn-based tests are slower than in-process tests; we keep them small
 * and rely on the in-process suites for coverage.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const distEsmAbs = path
  .join(repoRoot, 'dist', 'index.js')
  .replace(/\\/g, '/');
const distCjsAbs = path
  .join(repoRoot, 'dist', 'index.cjs')
  .replace(/\\/g, '/');

async function runChild(
  scriptContent: string,
  format: 'cjs' | 'esm',
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'multipart-stream-test-'));
  const ext = format === 'cjs' ? 'cjs' : 'mjs';
  const scriptPath = path.join(dir, `runner.${ext}`);
  await writeFile(scriptPath, scriptContent);
  try {
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], { cwd: repoRoot });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('close', (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
      });
      child.on('error', reject);
    });
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('cross-format consumer (T-052, T-072, T-082)', () => {
  // 30 s budget per spawn — Windows CI is slow to fork node.
  const SPAWN_TIMEOUT_MS = 30_000;

  it(
    'T-052/T-072 CJS consumer: require + parseMultipartRelated yields parts (FR-DR-A-028)',
    async () => {
      // The CRLF body is built inside the spawned process so we never depend
      // on tests/fixtures/* from inside a CJS file at /tmp.
      const script = `
        'use strict';
        const m = require(${JSON.stringify(distCjsAbs)});
        if (typeof m.parseMultipartRelated !== 'function') {
          console.error('FAIL: parseMultipartRelated is not a function');
          process.exit(2);
        }
        (async () => {
          const CRLF = '\\r\\n';
          const body = Buffer.from(
            '--B' + CRLF +
            'Content-Type: text/plain' + CRLF +
            CRLF +
            'hello' + CRLF +
            '--B--' + CRLF,
            'utf8'
          );
          const res = new Response(body, {
            headers: { 'content-type': 'multipart/related; boundary=B' },
          });
          let count = 0;
          for await (const part of m.parseMultipartRelated(res, {
            idleTimeoutMs: 5000,
            totalTimeoutMs: 10000,
          })) {
            // Drain the part body
            for await (const _ of part.body) { /* consume */ }
            count++;
          }
          console.log('count:' + count);
        })().catch((e) => {
          console.error('FAIL:' + (e && e.constructor ? e.constructor.name : 'Unknown') + ':' + (e && e.message ? e.message : String(e)));
          process.exit(1);
        });
      `;
      const result = await runChild(script, 'cjs');
      // Surface diagnostic info on failure so the CI log explains the bug.
      if (result.exitCode !== 0) {
        console.error('CJS child stderr:', result.stderr);
        console.error('CJS child stdout:', result.stdout);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('count:1');
      // Belt-and-suspenders: prove the FR-DR-A-028 normalization didn't
      // regress (would surface as 'Dicer is not a constructor').
      expect(result.stderr).not.toMatch(/Dicer is not a constructor/);
      expect(result.stdout).not.toMatch(/Dicer is not a constructor/);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'T-052/T-072 ESM consumer: import + parseMultipartRelated yields parts (FR-DR-A-028)',
    async () => {
      const script = `
        const m = await import(${JSON.stringify('file://' + distEsmAbs)});
        if (typeof m.parseMultipartRelated !== 'function') {
          console.error('FAIL: parseMultipartRelated is not a function');
          process.exit(2);
        }
        const CRLF = '\\r\\n';
        const body = Buffer.from(
          '--B' + CRLF +
          'Content-Type: text/plain' + CRLF +
          CRLF +
          'hello' + CRLF +
          '--B--' + CRLF,
          'utf8'
        );
        const res = new Response(body, {
          headers: { 'content-type': 'multipart/related; boundary=B' },
        });
        try {
          let count = 0;
          for await (const part of m.parseMultipartRelated(res, {
            idleTimeoutMs: 5000,
            totalTimeoutMs: 10000,
          })) {
            for await (const _ of part.body) { /* consume */ }
            count++;
          }
          console.log('count:' + count);
        } catch (e) {
          console.error('FAIL:' + (e && e.constructor ? e.constructor.name : 'Unknown') + ':' + (e && e.message ? e.message : String(e)));
          process.exit(1);
        }
      `;
      const result = await runChild(script, 'esm');
      if (result.exitCode !== 0) {
        console.error('ESM child stderr:', result.stderr);
        console.error('ESM child stdout:', result.stdout);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('count:1');
      expect(result.stderr).not.toMatch(/Dicer is not a constructor/);
      expect(result.stdout).not.toMatch(/Dicer is not a constructor/);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'T-082 cross-format err.name fallback works (NFR-DR-D-007)',
    async () => {
      // Construct an error from the CJS bundle and assert its `name`
      // discriminator is the literal class name. This is the contract
      // documented in the README's Error handling section: even when
      // cross-bundle `instanceof` returns false (different copies of the
      // class constructor), `err.name === 'MultipartIdleTimeoutError'`
      // remains stable.
      const script = `
        'use strict';
        const m = require(${JSON.stringify(distCjsAbs)});
        const names = [
          'MultipartIdleTimeoutError',
          'MultipartTotalTimeoutError',
          'MultipartAbortError',
          'MultipartTruncatedError',
          'MultipartPartTooLargeError',
          'MultipartHeadersTooLargeError',
          'MultipartTooManyPartsError',
        ];
        for (const n of names) {
          if (typeof m[n] !== 'function') {
            console.error('FAIL: ' + n + ' is not a constructor');
            process.exit(2);
          }
        }
        // Construct one of each and verify err.name is the class-name string
        // (NFR-DR-D-007). The constructor signatures vary per class — we use
        // shapes that satisfy each.
        const idle = new m.MultipartIdleTimeoutError(1000);
        const total = new m.MultipartTotalTimeoutError(60000);
        const abort = new m.MultipartAbortError('user-cancel');
        const trunc = new m.MultipartTruncatedError(123);
        const partTooLarge = new m.MultipartPartTooLargeError({
          maxPartBytes: 4096, partIndex: 0, bytesReceived: 4097,
        });
        const headers = new m.MultipartHeadersTooLargeError({
          limit: 'count', partIndex: 0, cap: 100, observed: 101,
        });
        const tooMany = new m.MultipartTooManyPartsError({
          maxParts: 10, observed: 11,
        });
        const all = [idle, total, abort, trunc, partTooLarge, headers, tooMany];
        for (const e of all) {
          // err.name MUST be the literal class name verbatim.
          console.log('name:' + e.name);
          // err MUST be an Error instance.
          console.log('isError:' + (e instanceof Error));
        }
        // Cross-format same-bundle instanceof MUST work (single-bundle case).
        console.log('inst-idle:' + (idle instanceof m.MultipartIdleTimeoutError));
        console.log('inst-abort:' + (abort instanceof m.MultipartAbortError));
        // err.reason carries the caller-supplied reason verbatim (F-S-006).
        console.log('reason:' + abort.reason);
      `;
      const result = await runChild(script, 'cjs');
      if (result.exitCode !== 0) {
        console.error('T-082 child stderr:', result.stderr);
        console.error('T-082 child stdout:', result.stdout);
      }
      expect(result.exitCode).toBe(0);
      // Verify each err.name (the cross-format discriminator) is the literal
      // class name. This is the contract every consumer relies on per
      // NFR-DR-D-007 when instanceof fails across the ESM/CJS boundary.
      expect(result.stdout).toContain('name:MultipartIdleTimeoutError');
      expect(result.stdout).toContain('name:MultipartTotalTimeoutError');
      expect(result.stdout).toContain('name:MultipartAbortError');
      expect(result.stdout).toContain('name:MultipartTruncatedError');
      expect(result.stdout).toContain('name:MultipartPartTooLargeError');
      expect(result.stdout).toContain('name:MultipartHeadersTooLargeError');
      expect(result.stdout).toContain('name:MultipartTooManyPartsError');
      // All must be Error instances.
      const isErrorMatches = result.stdout.match(/isError:true/g) ?? [];
      expect(isErrorMatches.length).toBe(7);
      // Same-bundle instanceof works (sanity check).
      expect(result.stdout).toContain('inst-idle:true');
      expect(result.stdout).toContain('inst-abort:true');
      // F-S-006: caller-supplied reason flows through verbatim.
      expect(result.stdout).toContain('reason:user-cancel');
    },
    SPAWN_TIMEOUT_MS,
  );
});
