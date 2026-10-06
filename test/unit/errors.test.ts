import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CapacityError,
  ERROR_CODE_CLASSES,
  IdempotencyKeyReusedError,
  InvalidRequestError,
  KeyBudgetExhaustedError,
  ModelNotFoundError,
  PermissionDeniedError,
  RateLimitError,
  RelayAPIError,
  ScopeDeniedError,
  UpstreamTimeoutError,
  ValidationError,
  errorFromResponse,
  parseRetryAfter,
} from "../../src/errors.js";

const h = (o: Record<string, string> = {}) => new Headers(o);
const envelope = (code: string | null, extra: Record<string, unknown> = {}) => ({
  detail: "d",
  error: { code, type: "authorization", source: "client", message: "m", request_id: "req_1", ...extra },
});

describe("errorFromResponse", () => {
  it("status picks the class, code refines it", () => {
    const e = errorFromResponse(402, envelope("KEY_BUDGET_EXHAUSTED"), h());
    expect(e).toBeInstanceOf(KeyBudgetExhaustedError);
    expect(e).toMatchObject({ status: 402, code: "KEY_BUDGET_EXHAUSTED", requestId: "req_1", detail: "d", message: "m" });
    expect(errorFromResponse(403, envelope("SCOPE_DENIED"), h())).toBeInstanceOf(ScopeDeniedError);
    expect(errorFromResponse(404, envelope("MODEL_NOT_FOUND"), h())).toBeInstanceOf(ModelNotFoundError);
    expect(errorFromResponse(422, envelope("IDEMPOTENCY_KEY_REUSED"), h())).toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it("an unknown code degrades to the status class and keeps the code", () => {
    const e = errorFromResponse(403, envelope("SOMETHING_INVENTED_2099"), h());
    expect(e.constructor).toBe(PermissionDeniedError);
    expect(e.code).toBe("SOMETHING_INVENTED_2099");
  });

  it("null code → status class", () => {
    const e = errorFromResponse(503, envelope(null), h({ "retry-after": "7" }));
    expect(e.constructor).toBe(CapacityError);
    expect(e.code).toBeNull();
    expect(e.retryAfter).toBe(7);
  });

  it("a code never escapes its status: VALIDATION_ERROR at 400 stays InvalidRequestError", () => {
    const e = errorFromResponse(400, envelope("VALIDATION_ERROR"), h());
    expect(e.constructor).toBe(InvalidRequestError);
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(errorFromResponse(422, envelope("VALIDATION_ERROR"), h()).constructor).toBe(ValidationError);
  });

  it("unmapped status → RelayAPIError; 413 keeps FILE_TOO_LARGE", () => {
    const e = errorFromResponse(413, envelope("FILE_TOO_LARGE"), h());
    expect(e).toBeInstanceOf(RelayAPIError);
    expect(e.code).toBe("FILE_TOO_LARGE");
    expect(errorFromResponse(418, null, h()).constructor).toBe(RelayAPIError);
  });

  it("requestId falls back to X-Request-ID; non-JSON bodies keep a message", () => {
    const e = errorFromResponse(502, "<html>bad gateway</html>", h({ "x-request-id": "hdr_1" }));
    expect(e.requestId).toBe("hdr_1");
    expect(e.message).toContain("bad gateway");
  });

  it("OpenAI-shaped stream pre-first-chunk error maps from error.type", () => {
    const body = { error: { message: "slow", type: "worker_timeout", code: 504 } };
    const e = errorFromResponse(504, body, h({ "x-request-id": "r" }));
    expect(e).toBeInstanceOf(UpstreamTimeoutError);
    expect(e.code).toBeNull();
    expect(e.type).toBe("worker_timeout");
    expect(errorFromResponse(429, { error: { message: "x", type: "rate_limit_exceeded", code: 429 } }, h())).toBeInstanceOf(RateLimitError);
  });

  it("validation field list is carried in detail", () => {
    const detail = [{ loc: ["body", "prompt"], msg: "Field required", type: "missing" }];
    const e = errorFromResponse(422, { detail, error: { code: "VALIDATION_ERROR", type: "validation", source: "client", message: "1 error", request_id: "r" } }, h());
    expect(e.detail).toEqual(detail);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThanOrEqual(3);
  });
});

describe("generated code table", () => {
  it("every catalog code has an HTTP status in src/error-statuses.json", () => {
    const statuses = JSON.parse(readFileSync(new URL("../../src/error-statuses.json", import.meta.url), "utf8"));
    for (const code of Object.keys(ERROR_CODE_CLASSES)) expect(statuses[code], code).toBeTypeOf("number");
  });
});
