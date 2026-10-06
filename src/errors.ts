import {
  AuthenticationError,
  CapacityError,
  ConflictError,
  GoneError,
  InsufficientCreditsError,
  InvalidRequestError,
  NotFoundError,
  PermissionDeniedError,
  ProviderError,
  RateLimitError,
  RelayAPIError,
  RelayInternalError,
  UpstreamTimeoutError,
  ValidationError,
} from "./errors-base.js";
import { ERROR_CODE_CLASSES } from "./generated/errors.js";

export * from "./errors-base.js";
export * from "./generated/errors.js";

type APIErrorClass = typeof RelayAPIError;

const STATUS_CLASSES: Record<number, APIErrorClass> = {
  400: InvalidRequestError,
  401: AuthenticationError,
  402: InsufficientCreditsError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  410: GoneError,
  422: ValidationError,
  429: RateLimitError,
  500: RelayInternalError,
  502: ProviderError,
  503: CapacityError,
  504: UpstreamTimeoutError,
};

// `error.type` of the OpenAI-shaped body a chat stream answers before its first chunk.
const STREAM_TYPE_CLASSES: Record<string, APIErrorClass> = {
  invalid_request_error: InvalidRequestError,
  authentication_error: AuthenticationError,
  permission_error: PermissionDeniedError,
  not_found_error: NotFoundError,
  rate_limit_exceeded: RateLimitError,
  rate_limit_error: RateLimitError,
  capacity_exhausted: CapacityError,
  worker_timeout: UpstreamTimeoutError,
  timeout_error: UpstreamTimeoutError,
  server_error: RelayInternalError,
};

/** Seconds from a `Retry-After` header (delta-seconds or HTTP date); null when absent or unreadable. */
export function parseRetryAfter(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function classFor(status: number, code: string | null, streamType: string | null): APIErrorClass {
  const base = (streamType && STREAM_TYPE_CLASSES[streamType]) || STATUS_CLASSES[status] || RelayAPIError;
  const refined = code ? (ERROR_CODE_CLASSES as Record<string, APIErrorClass>)[code] : undefined;
  // A code only narrows: it applies when its class sits under the status class (VALIDATION_ERROR at 400 stays InvalidRequestError).
  return refined && (refined === base || refined.prototype instanceof base) ? refined : base;
}

/** Builds the typed error for a non-2xx answer. `body` is the parsed JSON (or text, or null). */
export function errorFromResponse(status: number, body: unknown, headers: Headers): RelayAPIError {
  const err = isObject(body) && isObject(body.error) ? body.error : null;
  const streamShaped = err != null && typeof err.code === "number"; // OpenAI-shaped pre-first-chunk stream error
  const code = err && typeof err.code === "string" ? err.code : null;
  const type = err && typeof err.type === "string" ? err.type : null;
  const requestId = (err && typeof err.request_id === "string" ? err.request_id : null) ?? headers.get("x-request-id");
  const detail = isObject(body) && "detail" in body ? body.detail : err && "detail" in err ? err.detail : undefined;
  const message =
    (err && typeof err.message === "string" && err.message) ||
    (typeof detail === "string" && detail) ||
    (typeof body === "string" && body.slice(0, 500)) ||
    `HTTP ${status}`;
  const Cls = classFor(status, code, streamShaped ? type : null);
  return new Cls({
    message,
    status,
    code,
    type,
    requestId,
    detail,
    retryAfter: parseRetryAfter(headers.get("retry-after")),
    headers,
  });
}

function isObject(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
