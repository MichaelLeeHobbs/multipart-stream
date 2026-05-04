/**
 * In-process HTTP server fixture, per `kiln/spec/test-plan.md` "Conventions" →
 * "HTTP fixture". Used by the fetch-orchestration integration tests.
 *
 * Listens on a dynamic port (so tests can run in parallel without
 * port-bind collisions). Configurable status, Content-Type, and body.
 * The handler awaits any optional `stallMs` before responding so tests
 * can simulate slow servers without spinning up a real backend.
 *
 * Not part of the published surface — lives under `tests/fixtures/`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** Public handle returned by {@link startMultipartServer}. */
export interface MultipartServerHandle {
  /** Base URL the test should `fetch` against (path defaults to `/`). */
  readonly url: string;
  /** Stop accepting connections and resolve once all sockets are closed. */
  close(): Promise<void>;
}

/** Configuration for {@link startMultipartServer}. */
export interface MultipartServerOptions {
  /** Response status code. Defaults to `200`. */
  readonly status?: number;
  /**
   * Content-Type header value. Defaults to
   * `multipart/related; boundary=BOUNDARY`. Pass empty string to omit
   * (the test server will then NOT set the header, so
   * `res.headers.get('content-type')` will return null on the client).
   */
  readonly contentType?: string;
  /** Response body. Defaults to a zero-byte buffer. */
  readonly body?: Buffer;
  /**
   * Optional callback invoked on every incoming request — exposed so
   * tests can assert call counts, request shape, etc.
   */
  readonly onRequest?: (req: http.IncomingMessage) => void;
  /**
   * Number of ms to wait BEFORE writing the response. Useful for
   * timeout / abort race tests. Defaults to `0`.
   */
  readonly stallMs?: number;
  /**
   * When set, after writing headers + the body, hold the response open
   * for `holdMs` before ending. The body is sent in the writeHead call;
   * `holdMs` only delays the `res.end()` so the connection stays open
   * past body-emit. Useful for testing idle-timeout fired AFTER the
   * envelope has been delivered. Defaults to `0`.
   */
  readonly holdMs?: number;
}

/**
 * Start an in-process HTTP server that responds with a configurable
 * status / Content-Type / body. Returns a handle whose `url` includes
 * the dynamic port and a `close()` for cleanup.
 *
 * Tests should pair this with a `try/finally` (or `await using` once
 * we're on TS 5.2+) to guarantee cleanup even on assertion failure.
 *
 * @example
 *   const server = await startMultipartServer({
 *     contentType: 'multipart/related; boundary=foo',
 *     body: buildMultipartBody({ boundary: 'foo', parts: [...] }),
 *   });
 *   try {
 *     const result = await fetchAndHandleMultipart(server.url, opts);
 *     expect(result.parts.length).toBe(2);
 *   } finally {
 *     await server.close();
 *   }
 */
export async function startMultipartServer(
  opts: MultipartServerOptions = {},
): Promise<MultipartServerHandle> {
  const status = opts.status ?? 200;
  const contentType = opts.contentType ?? 'multipart/related; boundary=BOUNDARY';
  const body = opts.body ?? Buffer.alloc(0);
  const stallMs = opts.stallMs ?? 0;
  const holdMs = opts.holdMs ?? 0;
  const onRequest = opts.onRequest;

  const server = http.createServer((req, res) => {
    onRequest?.(req);
    const writeAndMaybeHold = (): void => {
      // When contentType is the empty string, deliberately OMIT the
      // header so client-side `headers.get('content-type')` returns null.
      const headers: http.OutgoingHttpHeaders = {};
      if (contentType.length > 0) {
        headers['content-type'] = contentType;
      }
      res.writeHead(status, headers);
      res.write(body);
      if (holdMs > 0) {
        setTimeout(() => {
          res.end();
        }, holdMs);
      } else {
        res.end();
      }
    };
    if (stallMs > 0) {
      setTimeout(writeAndMaybeHold, stallMs);
    } else {
      writeAndMaybeHold();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(addr.port)}/`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        // Force-close any lingering sockets so abort/timeout tests don't
        // hang the suite waiting for keep-alive connections to drain.
        server.closeAllConnections();
      }),
  };
}
