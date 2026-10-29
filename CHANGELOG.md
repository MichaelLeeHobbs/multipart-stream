# Changelog

## 2.0.0

A hardening release: four rounds of review, property fuzzing and mutation
testing. Every fix has a regression test in `tests/regressions/` or
`tests/fuzz/regressions.test.ts`.

### Breaking changes

- Truncation (the source ends before the closing delimiter) always rejects
  with `MultipartTruncatedError`, never a plain `Error`.
- A part over `maxPartBytes` errors its body with
  `MultipartPartTooLargeError`, including the last part.
- After any failure, every incomplete part body is destroyed with the same
  error the iterator rejects with. Bodies that were already complete stay
  readable.
- Invalid cap options (`maxPartBytes`, `maxParts`, `maxHeadersPerPart`,
  `maxHeaderBytesPerPart`) throw a `TypeError` instead of being ignored.
- `part.headers` has a `null` prototype, like `IncomingMessage.headers`.
- Header values are trimmed of surrounding spaces and tabs.
- `contentLength` is `undefined` unless the header is a plain decimal
  integer.
- `MultipartHeadersTooLargeError.observed` for `limit: 'bytes'` can be less
  than the whole header block, because the block is rejected while it
  accumulates.

### Fixes

- Idle timeout, total timeout and abort now reach a consumer reading
  `part.body`, so a stalled server can no longer hang `streamToBuffer`.
- `totalTimeoutMs` in `fetchAndHandleMultipart` covers the wait for
  response headers.
- The Response body is cancelled when the Content-Type, the boundary, or an
  option is rejected.
- A slow consumer of the last part no longer gets a false truncation error,
  including when the source closes without `'end'`.
- `maxPartBytes` keeps backpressure, and destroying a body to skip it no
  longer fails the run.
- Caller header caps are no longer overridden by hidden internal limits.
- RFC 2046 transport padding after a delimiter is accepted, as are parts
  with headers and no body.
- A `__proto__` header and empty repeated header values are kept.
- Rare framing cases in malformed bodies no longer drop bytes.
- `result.bytes` counts every received byte, and `onProgress` sends its
  completion tick.
- Parsing and `onProgress` stop after an early `break`.
- `streamToString` and `streamToBuffer` reject on premature close and on a
  bad encoding or `maxBytes`, instead of hanging or throwing uncaught.
- A throwing logger can no longer cause an unhandled rejection or an
  uncaught exception.
- Pre-destroyed and lookalike source streams settle with a proper error.
- Finished part streams are released as soon as they close.

### Removed

- The internal, never-exported `sanitizeFileName` helper.
