# @ubercode/multipart-stream

A focused TypeScript library for consuming `multipart/related` HTTP responses
as a typed async-iterator of streaming parts, with production-grade
timeout / abort / cleanup hygiene.

## Install

```bash
pnpm add @ubercode/multipart-stream
# or
npm install @ubercode/multipart-stream
# or
yarn add @ubercode/multipart-stream
```

Requires Node `>= 20.18.0`. Single runtime dependency: `dicer@0.3.1` (pinned
exact).

## Quickstart

The most common shape — `fetch` a `multipart/related` response and route
each part through your own per-part `parser` callback — is one call:

```ts
import {
  fetchAndHandleMultipart,
  streamToString,
  MultipartIdleTimeoutError,
  MultipartTotalTimeoutError,
  MultipartAbortError,
  MultipartTruncatedError,
} from '@ubercode/multipart-stream';

interface MetaPart { kind: 'meta'; payload: unknown }
interface BlobPart { kind: 'blob'; bytes: number; contentId?: string }
type Part = MetaPart | BlobPart;

const ctrl = new AbortController();

try {
  const result = await fetchAndHandleMultipart<Part>(
    'https://api.example.com/blob',
    {
      idleTimeoutMs: 30_000,
      totalTimeoutMs: 5 * 60_000,
      signal: ctrl.signal,
      onProgress: ({ bytes, elapsedMs, rateBps }) => {
        console.log(`${bytes}B in ${elapsedMs}ms (${Math.round(rateBps)}B/s)`);
      },
      parser: async (part) => {
        if (part.contentType.startsWith('application/json')) {
          // Small JSON metadata part — drain to string and parse.
          const text = await streamToString(part.body, 'utf8', {
            maxBytes: 1_048_576, // 1 MiB cap (NFR-DR-S-002)
          });
          return { kind: 'meta', payload: JSON.parse(text) };
        }
        // Binary blob — stream-drain and count bytes; never buffer.
        let bytes = 0;
        for await (const chunk of part.body) {
          bytes += (chunk as Buffer).length;
        }
        return { kind: 'blob', bytes, contentId: part.contentId };
      },
    },
  );
  console.log(`Got ${result.parts.length} parts in ${result.elapsedMs}ms`);
  console.log(`HTTP status: ${result.status}, total bytes: ${result.bytes}`);
} catch (err) {
  if (err instanceof MultipartIdleTimeoutError) {
    console.error(`Server stalled; idle timeout fired (${err.idleTimeoutMs}ms)`);
  } else if (err instanceof MultipartTotalTimeoutError) {
    console.error(`Took too long overall (${err.totalTimeoutMs}ms)`);
  } else if (err instanceof MultipartAbortError) {
    console.error('Aborted by caller', err.reason);
  } else if (err instanceof MultipartTruncatedError) {
    console.error(`Stream truncated after ${err.bytesReceived}B`);
  } else {
    throw err;
  }
}
```

For raw `Readable` inputs (e.g. parsing a `multipart/related` request body
on the server side) use `parseMultipartRelated` directly:

```ts
import { parseMultipartRelated } from '@ubercode/multipart-stream';

for await (const part of parseMultipartRelated(req as unknown as Readable, {
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 5 * 60_000,
  boundary: 'YOUR-BOUNDARY-FROM-CONTENT-TYPE',
})) {
  // Either drain part.body or destroy it before requesting the next part.
  for await (const chunk of part.body) {
    // process
    void chunk;
  }
}
```

The library never pauses dicer's internal state machine on your behalf —
your parser must drain or destroy each `part.body` before requesting the
next part. If you don't, the iterator's `finally` destroys leftover bodies
for you (FR-010), but that costs latency.

## API

Single entry point. Submodule exports are NOT supported (one entry, one
contract).

| Symbol                               | Kind   | Description |
| ------------------------------------ | ------ | ----------- |
| `fetchAndHandleMultipart(url, opts)` | fn     | `fetch` wrapper with idle/total timeout, AbortSignal, progress, and per-part `parser` callback. Resolves `{ parts, bytes, elapsedMs, status, headers }`. |
| `parseMultipartRelated(input, opts)` | fn     | Async-generator yielding `StreamingMultipartPart` per envelope sub-part. Accepts a `Response` (boundary auto-extracted) or a Node `Readable` + explicit `boundary`. |
| `streamToString(readable, encoding?, opts?)` | fn | Drain a Node `Readable` to a string. Supports `{ maxBytes }` cap. |
| `streamToBuffer(readable, opts?)`    | fn     | Drain a Node `Readable` to a `Buffer`. Supports `{ maxBytes }` cap. |
| `extractBoundary(contentTypeHeader)` | fn     | RFC 2046 boundary extractor (ReDoS-resistant). |
| `MultipartIdleTimeoutError`          | class  | Thrown when no source bytes arrive for `idleTimeoutMs`. |
| `MultipartTotalTimeoutError`         | class  | Thrown when total wallclock exceeds `totalTimeoutMs`. |
| `MultipartAbortError`                | class  | Thrown when the caller's `AbortSignal` fires. `reason` carries the signal's reason verbatim. |
| `MultipartTruncatedError`            | class  | Thrown when source ends without the closing boundary. `bytesReceived` is the cumulative source byte count. |
| `MultipartPartTooLargeError`         | class  | Thrown when a part body exceeds `maxPartBytes`. Carries `{ maxPartBytes, partIndex, bytesReceived }`. |
| `MultipartHeadersTooLargeError`      | class  | Thrown when a part exceeds `maxHeadersPerPart` (default 100) or `maxHeaderBytesPerPart` (default 16 KiB). Carries `{ limit, partIndex, cap, observed }`. |
| `MultipartTooManyPartsError`         | class  | Thrown when an envelope exceeds `maxParts` (default 10 000). Carries `{ maxParts, observed }`. |
| `StreamingMultipartPart`             | type   | Yielded shape: `{ index, headers, body, contentType, contentId?, contentLength?, rawHeaders, boundary }`. |
| `PartParser<T>`                      | type   | `(part: StreamingMultipartPart) => Promise<T \| undefined>`. |
| `MultipartFetchResult<T>`            | type   | `{ parts, bytes, elapsedMs, status, headers }` (no `response` field — body is consumed by the time the result resolves). |
| `ParseMultipartOptions`              | type   | Options for `parseMultipartRelated`. |
| `MultipartHandlerOptions<T>`         | type   | Options for `fetchAndHandleMultipart`. |
| `ProgressSnapshot`                   | type   | `{ bytes, elapsedMs, rateBps }`. |
| `Logger`                             | type   | `(event: { level: 'warn'; msg: string; meta?: unknown }) => void`. |

For full JSDoc on every symbol see the `.d.ts` file or each symbol's
hover-doc in your editor.

## Error handling

The library throws seven typed `Error` subclasses. Branch on `instanceof`
in single-format consumers:

```ts
import {
  MultipartIdleTimeoutError,
  MultipartTotalTimeoutError,
  MultipartAbortError,
  MultipartTruncatedError,
  MultipartPartTooLargeError,
  MultipartHeadersTooLargeError,
  MultipartTooManyPartsError,
} from '@ubercode/multipart-stream';

function classify(err: unknown): string {
  if (err instanceof MultipartIdleTimeoutError) return 'idle';
  if (err instanceof MultipartTotalTimeoutError) return 'total';
  if (err instanceof MultipartAbortError) return 'abort';
  if (err instanceof MultipartTruncatedError) return 'truncated';
  if (err instanceof MultipartPartTooLargeError) return 'part-too-large';
  if (err instanceof MultipartHeadersTooLargeError) return 'headers-too-large';
  if (err instanceof MultipartTooManyPartsError) return 'too-many-parts';
  return 'other';
}
```

Each error class carries structured fields for telemetry and recovery:

| Error class                          | Structured fields |
| ------------------------------------ | ----------------- |
| `MultipartIdleTimeoutError`          | `idleTimeoutMs: number` |
| `MultipartTotalTimeoutError`         | `totalTimeoutMs: number` |
| `MultipartAbortError`                | `reason?: unknown` (caller-supplied verbatim per F-S-006 — never synthesized from server bytes) |
| `MultipartTruncatedError`            | `bytesReceived: number` |
| `MultipartPartTooLargeError`         | `maxPartBytes: number`, `partIndex: number`, `bytesReceived: number` |
| `MultipartHeadersTooLargeError`      | `limit: 'count' \| 'bytes'`, `partIndex: number`, `cap: number`, `observed: number` |
| `MultipartTooManyPartsError`         | `maxParts: number`, `observed: number` |

### Cross-format `err.name` fallback (NFR-DR-D-007)

If your project mixes ESM and CJS imports of `@ubercode/multipart-stream` —
for example, a CJS application loads a CJS dependency that itself
`require`s this library while another transitive dependency `import`s it —
`err instanceof MultipartIdleTimeoutError` may return `false` across the
module-format boundary, because each bundle has its own copy of the class
constructor.

Every error class sets `err.name` to its class name verbatim
(`'MultipartIdleTimeoutError'`, `'MultipartTotalTimeoutError'`, …). Use the
name as a stable fallback that survives both minification and the
ESM/CJS boundary:

```ts
function classifyByName(err: unknown): string {
  if (!(err instanceof Error)) return 'other';
  switch (err.name) {
    case 'MultipartIdleTimeoutError':       return 'idle';
    case 'MultipartTotalTimeoutError':      return 'total';
    case 'MultipartAbortError':             return 'abort';
    case 'MultipartTruncatedError':         return 'truncated';
    case 'MultipartPartTooLargeError':      return 'part-too-large';
    case 'MultipartHeadersTooLargeError':   return 'headers-too-large';
    case 'MultipartTooManyPartsError':      return 'too-many-parts';
    default:                                 return 'other';
  }
}
```

Single-format consumers (pure ESM or pure CJS) can rely on `instanceof`
exclusively. The `err.name` fallback is verified end-to-end against the
published `dist/` bundle by the cross-format consumer test
(`tests/integration/cross-format.test.ts`).

## Compatibility

- **Node:** `>= 20.18.0` (last Node 20 LTS, with the stabilized
  `Readable.fromWeb` backpressure fixes the library relies on).
- **Module formats:** dual ESM (`dist/index.js`) + CJS (`dist/index.cjs`)
  + per-format types (`dist/index.d.ts` + `dist/index.d.cts`). One entry;
  no submodule exports.
- **Type-resolution:** Audited under
  [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io)
  with all four moduleResolution scenarios passing
  (`node10`, `node16-cjs`, `node16-esm`, `bundler`). Per-format
  `types` conditions are wired in `package.json#exports`.
- **Tree-shaking:** `package.json#sideEffects` is `false`.
- **No browser support claim.** The library uses `node:stream`. Bundlers
  that emulate Node streams may work but are not on the support matrix.
- **Concurrency contract (F-A-005):** the async-generator from
  `parseMultipartRelated` does NOT promise serialization of concurrent
  `iter.next()` calls. The library MAY but is not required to detect the
  race. The contract is that the process does not crash via
  `uncaughtException` — first-fire wins; subsequent settles are accepted.
  Single-threaded `for await (...)` consumers (the documented usage)
  never hit this race.

### Resource caps and security defaults

The library applies conservative caps on every operation, all opt-out via
the corresponding option:

| Option                       | Default     | Spec ref         |
| ---------------------------- | ----------- | ---------------- |
| `maxParts`                   | `10_000`    | NFR-DR-S-012     |
| `maxHeadersPerPart`          | `100`       | NFR-DR-S-004     |
| `maxHeaderBytesPerPart`      | `16_384`    | NFR-DR-S-004     |
| `maxPartBytes`               | unset (no cap unless caller sets it) | NFR-DR-S-001 |

Setting `maxPartBytes` is recommended whenever the response is
attacker-influenced. The error paths (`MultipartPartTooLargeError`,
`MultipartHeadersTooLargeError`, `MultipartTooManyPartsError`) destroy
the source stream and run full FR-010 cleanup before surfacing.

Per F-S-006, `MultipartAbortError.reason` carries the caller-supplied
`AbortSignal.reason` verbatim or is `undefined`. The library never
synthesizes a reason that embeds server-derived bytes, so the field is
safe to log without sanitization.

## License

[MIT](LICENSE) — Copyright (c) 2026 Michael Hobbs.
