/**
 * `@ubercode/multipart-stream` — public entry.
 *
 * The ONLY file callers import from. Per `kiln/spec/api.md` "Module entry" + the
 * "Submodule exports policy: none" — there is no `@ubercode/multipart-stream/utils`
 * or similar; one entry point, one contract.
 */

export {
  MultipartAbortError,
  MultipartHeadersTooLargeError,
  MultipartIdleTimeoutError,
  MultipartPartTooLargeError,
  MultipartTooManyPartsError,
  MultipartTotalTimeoutError,
  MultipartTruncatedError,
} from './errors.js';
export { extractBoundary } from './extract-boundary.js';
export { fetchAndHandleMultipart } from './fetch-and-handle-multipart.js';
export { parseMultipartRelated } from './parse-multipart-related.js';
export { streamToBuffer, streamToString } from './stream-helpers.js';
export type {
  Logger,
  MultipartFetchResult,
  MultipartHandlerOptions,
  ParseMultipartOptions,
  PartParser,
  ProgressSnapshot,
  StreamingMultipartPart,
} from './types.js';
