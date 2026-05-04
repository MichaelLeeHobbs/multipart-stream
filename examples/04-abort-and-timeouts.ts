/**
 * Example 04 — Composing `AbortSignal` with idle and total timeouts.
 *
 * Demonstrates the four discriminable error classes a streaming parse can
 * raise, and how the library surfaces caller-controlled vs. server-controlled
 * failures distinctly.
 *
 * Run:
 *   pnpm build
 *   pnpm exec tsx examples/04-abort-and-timeouts.ts
 *
 * In your own project:
 *   import {
 *     parseMultipartRelated,
 *     MultipartAbortError,
 *     MultipartIdleTimeoutError,
 *     MultipartTotalTimeoutError,
 *     MultipartTruncatedError,
 *   } from '@ubercode/multipart-stream';
 */
import { Readable } from 'node:stream';

import {
  MultipartAbortError,
  MultipartIdleTimeoutError,
  MultipartTotalTimeoutError,
  MultipartTruncatedError,
  parseMultipartRelated,
} from '../src/index.js';

const controller = new AbortController();

// A source that never emits any data — simulates a hung connection.
const stalledSource = new Readable({
  read() {
    // intentionally never push anything
  },
});

// Trigger a caller-side abort after 100ms so this example terminates promptly.
setTimeout(() => controller.abort('user-cancelled'), 100);

try {
  for await (const part of parseMultipartRelated(stalledSource, {
    boundary: 'B',
    idleTimeoutMs: 30_000,
    totalTimeoutMs: 60_000,
    signal: controller.signal,
  })) {
    // Unreached — the source never produces anything. Referenced so the
    // example reads naturally without tripping the unused-vars lint.
    console.warn('unexpected part:', part.index);
  }
} catch (err) {
  if (err instanceof MultipartAbortError) {
    console.warn('caller aborted; reason:', err.reason);
  } else if (err instanceof MultipartIdleTimeoutError) {
    console.warn(`idle timeout fired (cap ${err.idleTimeoutMs}ms)`);
  } else if (err instanceof MultipartTotalTimeoutError) {
    console.warn(`total timeout fired (cap ${err.totalTimeoutMs}ms)`);
  } else if (err instanceof MultipartTruncatedError) {
    console.warn(
      `source ended without a closing boundary; ${err.bytesReceived} bytes received`,
    );
  } else {
    throw err;
  }
}
