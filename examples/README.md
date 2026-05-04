# Examples

Runnable demos for `@ubercode/multipart-stream`. Each file is standalone — copy the relevant pattern into your own code.

| File | Demonstrates |
| --- | --- |
| [`01-basic-fetch.ts`](./01-basic-fetch.ts) | `fetchAndHandleMultipart` happy path with mixed JSON + binary parts |
| [`02-parse-readable.ts`](./02-parse-readable.ts) | `parseMultipartRelated` against a raw Node `Readable` (server-side use, explicit boundary) |
| [`03-soft-fail.ts`](./03-soft-fail.ts) | Per-part error collection via a `try/catch` wrapper around the parser body |
| [`04-abort-and-timeouts.ts`](./04-abort-and-timeouts.ts) | `AbortSignal` + `idleTimeoutMs` + `totalTimeoutMs` composition; error-class discrimination |

## Running locally (inside this repo)

The example imports use a relative path (`../src/index.js`) so they run without any package linking. The header comment in each file shows the import line you would write in your own project.

```bash
pnpm install
pnpm build
pnpm exec tsx examples/01-basic-fetch.ts <optional-url>
```

## In your own project

Once you've installed the package:

```ts
import { fetchAndHandleMultipart } from '@ubercode/multipart-stream';
```

The rest of each example is unchanged.

## Notes

- Examples are documentation; `pnpm pack` excludes this folder (the published artifact is exactly `dist/`, `README.md`, `LICENSE`, `package.json`).
- Examples are typechecked as part of `pnpm typecheck` and linted as part of `pnpm lint`, so they cannot drift out of sync with the public API.
