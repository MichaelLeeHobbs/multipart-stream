/**
 * Example 03 — Soft-fail recipe: collect successes and per-part failures separately.
 *
 * The library is fail-fast by default — any uncaught throw inside the parser
 * rejects the whole operation and runs full cleanup. To collect per-part
 * errors instead, wrap the parser body in `try/catch` and return a tagged
 * outcome.
 *
 * Run:
 *   pnpm build
 *   pnpm exec tsx examples/03-soft-fail.ts
 *
 * In your own project:
 *   import { parseMultipartRelated, streamToString } from '@ubercode/multipart-stream';
 */
import { Readable } from 'node:stream';

import { parseMultipartRelated, streamToString } from '../src/index.js';

type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: Error; partIndex: number; contentId: string | undefined };

interface ParsedMeta {
  id: string;
}

// Three parts — middle one is malformed JSON to exercise the failure path.
const envelope = Buffer.from(
  '--B\r\nContent-Type: application/json\r\nContent-ID: <a>\r\n\r\n{"id":"valid"}\r\n' +
    '--B\r\nContent-Type: application/json\r\nContent-ID: <b>\r\n\r\nNOT JSON\r\n' +
    '--B\r\nContent-Type: application/json\r\nContent-ID: <c>\r\n\r\n{"id":"another"}\r\n' +
    '--B--\r\n',
);

const outcomes: Outcome<ParsedMeta>[] = [];

for await (const part of parseMultipartRelated(Readable.from(envelope), {
  boundary: 'B',
  idleTimeoutMs: 5_000,
  totalTimeoutMs: 30_000,
})) {
  try {
    const text = await streamToString(part.body);
    outcomes.push({ ok: true, value: JSON.parse(text) as ParsedMeta });
  } catch (err) {
    outcomes.push({
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
      partIndex: part.index,
      contentId: part.contentId,
    });
  }
}

const successes = outcomes.filter(
  (o): o is Extract<Outcome<ParsedMeta>, { ok: true }> => o.ok,
);
const failures = outcomes.filter(
  (o): o is Extract<Outcome<ParsedMeta>, { ok: false }> => !o.ok,
);

// eslint-disable-next-line no-console
console.log(`Successes: ${successes.length}`);
for (const s of successes) {
  // eslint-disable-next-line no-console
  console.log('  ', s.value);
}
// eslint-disable-next-line no-console
console.log(`Failures: ${failures.length}`);
for (const f of failures) {
  // eslint-disable-next-line no-console
  console.log(`  part ${f.partIndex} (${f.contentId ?? '?'}): ${f.error.message}`);
}
