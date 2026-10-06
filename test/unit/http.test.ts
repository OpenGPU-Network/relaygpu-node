import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/http.js";
import { APIConnectionError, APITimeoutError, CapacityError, ProviderError, RateLimitError } from "../../src/errors.js";
import { json, mockFetch, relayError } from "./helpers.js";

const KEY = "relay_sk_unit_secret_never_logged";
const fast = { maxRetryAfterMs: 60_000 };
const client = (f: typeof fetch, extra = {}) => new HttpClient({ apiKey: KEY, baseUrl: "http://relay.test", fetch: f, retry: fast, ...extra });

describe("headers and auth", () => {
  it("sends X-API-Key for a key, Bearer for a jwt, never both", async () => {
    const m = mockFetch(json(200, {}), json(200, {}));
    await client(m.fetch).request("GET", "/v2/x");
    expect(m.calls[0].headers["x-api-key"]).toBe(KEY);
    expect(m.calls[0].headers.authorization).toBeUndefined();
    await new HttpClient({ jwt: "a.b.c", baseUrl: "http://relay.test", fetch: m.fetch }).request("GET", "/v2/x");
    expect(m.calls[1].headers.authorization).toBe("Bearer a.b.c");
    expect(m.calls[1].headers["x-api-key"]).toBeUndefined();
    expect(() => new HttpClient({ apiKey: KEY, jwt: "a.b.c" })).toThrow(TypeError);
  });

  it("noAuth sends no credential; the default base URL is prod", async () => {
    const m = mockFetch(json(200, {}));
    await new HttpClient({ apiKey: KEY, fetch: m.fetch }).request("GET", "/v2/tasks/direct:1", { noAuth: true });
    expect(m.calls[0].url).toBe("https://relaygpu.com/v2/tasks/direct:1");
    expect(m.calls[0].headers["x-api-key"]).toBeUndefined();
  });

  it("the key never appears in a serialised client or an error", async () => {
    const m = mockFetch(relayError(401, "INVALID_API_KEY"));
    const c = client(m.fetch);
    expect(JSON.stringify(c)).not.toContain(KEY);
    const e = await c.request("GET", "/v2/x").catch((e) => e);
    expect(JSON.stringify(e) + e.message + e.stack).not.toContain(KEY);
  });

  it("surfaces requestId and replayed", async () => {
    const m = mockFetch(json(202, { task_id: "direct:1" }, { "x-request-id": "rid", "idempotency-replayed": "true" }));
    const r = await client(m.fetch).request("POST", "/v2/x", { body: {}, idempotencyKey: "k" });
    expect(r).toMatchObject({ status: 202, requestId: "rid", replayed: true });
  });
});

describe("retry policy (F7)", () => {
  it("GET retries 429 honouring Retry-After, max 3", async () => {
    const m = mockFetch(relayError(429, "RATE_LIMITED", {}, { "retry-after": "0" }), relayError(429, "RATE_LIMITED", {}, { "retry-after": "0" }), json(200, { ok: 1 }));
    const r = await client(m.fetch).request("GET", "/v2/x");
    expect(r.data).toEqual({ ok: 1 });
    expect(m.calls).toHaveLength(3);
    const m2 = mockFetch(...Array.from({ length: 4 }, () => relayError(503, "CAPACITY_EXHAUSTED", {}, { "retry-after": "0" })));
    await expect(client(m2.fetch).request("GET", "/v2/x")).rejects.toBeInstanceOf(CapacityError);
    expect(m2.calls).toHaveLength(4);
  });

  it("a Retry-After longer than the cap is surfaced, not slept through", async () => {
    const m = mockFetch(relayError(429, "RATE_LIMITED", {}, { "retry-after": "3600" }));
    const e = await client(m.fetch).request("GET", "/v2/x").catch((e) => e);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.retryAfter).toBe(3600);
    expect(m.calls).toHaveLength(1);
  });

  it("GET retries 5xx max 2", async () => {
    const m = mockFetch(relayError(502, "UPSTREAM_ERROR"), relayError(502, "UPSTREAM_ERROR"), relayError(502, "UPSTREAM_ERROR"));
    await expect(client(m.fetch).request("GET", "/v2/x")).rejects.toBeInstanceOf(ProviderError);
    expect(m.calls).toHaveLength(3);
  });

  it("a POST without a key is never retried (5xx, 429, network)", async () => {
    for (const reply of [relayError(502, "UPSTREAM_ERROR"), relayError(429, "RATE_LIMITED", {}, { "retry-after": "0" }), new TypeError("fetch failed")]) {
      const m = mockFetch(reply, json(200, {}));
      await expect(client(m.fetch).request("POST", "/v2/image/qwen/generate", { body: { prompt: "x" } })).rejects.toBeTruthy();
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0].headers["idempotency-key"]).toBeUndefined();
    }
  });

  it("a keyed POST retries 5xx with the SAME key", async () => {
    const m = mockFetch(relayError(500, "INTERNAL_ERROR"), json(202, { task_id: "direct:1" }));
    const r = await client(m.fetch).request("POST", "/v2/video/x", { body: { async: true }, idempotencyKey: "same-key" });
    expect(r.status).toBe(202);
    expect(m.calls.map((c) => c.headers["idempotency-key"])).toEqual(["same-key", "same-key"]);
  });

  it("a keyed POST retries a network error and a 409 IDEMPOTENCY_IN_PROGRESS once", async () => {
    const m = mockFetch(new TypeError("fetch failed"), relayError(409, "IDEMPOTENCY_IN_PROGRESS", {}, { "retry-after": "0" }), json(202, { task_id: "direct:1" }));
    const r = await client(m.fetch).request("POST", "/v2/video/x", { body: {}, idempotencyKey: "k" });
    expect(r.status).toBe(202);
    expect(m.calls).toHaveLength(3);
    const m2 = mockFetch(relayError(409, "IDEMPOTENCY_IN_PROGRESS", {}, { "retry-after": "0" }), relayError(409, "IDEMPOTENCY_IN_PROGRESS", {}, { "retry-after": "0" }));
    await expect(client(m2.fetch).request("POST", "/v2/video/x", { body: {}, idempotencyKey: "k" })).rejects.toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS" });
    expect(m2.calls).toHaveLength(2);
  });

  it("a keyed POST never retries a 4xx such as WORKFLOW_RUN_LIMIT_REACHED (429, no Retry-After)", async () => {
    const m = mockFetch(relayError(429, "WORKFLOW_RUN_LIMIT_REACHED"), json(202, {}));
    await expect(client(m.fetch).request("POST", "/v2/workflows/w/run", { body: {}, idempotencyKey: "k" })).rejects.toMatchObject({ code: "WORKFLOW_RUN_LIMIT_REACHED", retryAfter: null });
    expect(m.calls).toHaveLength(1);
  });

  it("retry:false disables everything", async () => {
    const m = mockFetch(relayError(503, "CAPACITY_EXHAUSTED", {}, { "retry-after": "0" }));
    await expect(client(m.fetch, { retry: false }).request("GET", "/v2/x")).rejects.toBeInstanceOf(CapacityError);
    expect(m.calls).toHaveLength(1);
  });

  it("network failure → APIConnectionError; per-attempt timeout → APITimeoutError", async () => {
    const m = mockFetch(new TypeError("fetch failed"));
    await expect(client(m.fetch, { retry: false }).request("GET", "/v2/x")).rejects.toBeInstanceOf(APIConnectionError);
    const hang = ((_: unknown, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(new HttpClient({ fetch: hang, timeoutMs: 20, retry: false }).request("GET", "/v2/x")).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("a caller abort is rethrown as-is and never retried", async () => {
    const ctrl = new AbortController();
    const hang = ((_: unknown, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch;
    const p = new HttpClient({ fetch: hang }).request("GET", "/v2/x", { signal: ctrl.signal });
    ctrl.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});
