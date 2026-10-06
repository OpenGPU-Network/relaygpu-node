// Error base classes. Status picks the class, `error.code` refines it (src/generated/errors.ts);
// an unknown code degrades to the status class and keeps `code`. Never carries the credential.

export interface RelayErrorInit {
  message: string;
  status?: number | null;
  code?: string | null;
  type?: string | null;
  requestId?: string | null;
  detail?: unknown;
  retryAfter?: number | null;
  headers?: Headers | null;
}

/** Root of every error this SDK throws. */
export class RelayError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly type: string | null;
  readonly requestId: string | null;
  readonly detail: unknown;
  /** Seconds, from `Retry-After` (429/503 and `409 IDEMPOTENCY_IN_PROGRESS`). */
  readonly retryAfter: number | null;

  constructor(init: RelayErrorInit) {
    super(init.message);
    this.name = new.target.name;
    this.status = init.status ?? null;
    this.code = init.code ?? null;
    this.type = init.type ?? null;
    this.requestId = init.requestId ?? null;
    this.detail = init.detail;
    this.retryAfter = init.retryAfter ?? null;
  }
}

/** An HTTP error answered by the API. */
export class RelayAPIError extends RelayError {
  /** Response headers (never the request's, so never the credential). */
  readonly headers: Headers | null;
  constructor(init: RelayErrorInit) {
    super(init);
    this.headers = init.headers ?? null;
  }
}

export class InvalidRequestError extends RelayAPIError {}
export class AuthenticationError extends RelayAPIError {}
export class InsufficientCreditsError extends RelayAPIError {}
export class PermissionDeniedError extends RelayAPIError {}
export class NotFoundError extends RelayAPIError {}
export class ConflictError extends RelayAPIError {}
export class GoneError extends RelayAPIError {}
export class ValidationError extends RelayAPIError {}
export class RateLimitError extends RelayAPIError {}
export class RelayInternalError extends RelayAPIError {}
export class ProviderError extends RelayAPIError {}
export class CapacityError extends RelayAPIError {}
export class UpstreamTimeoutError extends RelayAPIError {}

/** The request never got an HTTP answer (DNS, reset, TLS). */
export class APIConnectionError extends RelayError {}

/** The client-side `timeoutMs` elapsed (per attempt, or the `tasks.wait` budget). */
export class APITimeoutError extends RelayError {}

/** A task (or workflow run) reached `failed`; `code` is the task's top-level `error_code`. */
export class TaskFailedError extends RelayError {
  readonly taskId: string;
  readonly task: unknown;
  constructor(init: RelayErrorInit & { taskId: string; task: unknown }) {
    super(init);
    this.taskId = init.taskId;
    this.task = init.task;
  }
}
