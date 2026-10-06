import { describe, expect, it } from "vitest";
import { Account } from "../../src/account.js";
import type { Relay } from "../../src/client.js";
import { AuthenticationError, PermissionDeniedError } from "../../src/errors.js";
import { HttpClient } from "../../src/http.js";
import { json, mockFetch, relayError } from "./helpers.js";

function make(...replies: Parameters<typeof mockFetch>) {
  const m = mockFetch(...replies);
  const account = new Account({ _http: new HttpClient({ apiKey: "relay_sk_unit", baseUrl: "http://relay.test", fetch: m.fetch, retry: false }) } as unknown as Relay);
  const req = (i: number) => {
    const u = new URL(m.calls[i].url);
    return { method: m.calls[i].method, path: u.pathname, query: [...u.searchParams.entries()], body: m.calls[i].body };
  };
  return { m, account, req };
}

describe("account routes", () => {
  it("reads hit the documented paths", async () => {
    const { account, req } = make(...Array.from({ length: 6 }, () => json(200, {})));
    await account.credits();
    await account.pricing();
    await account.profile();
    await account.modelAllowlist();
    await account.usage();
    await account.creditsHistory();
    expect([0, 1, 2, 3, 4, 5].map((i) => `${req(i).method} ${req(i).path}`)).toEqual([
      "GET /v2/customer/credits",
      "GET /v2/customer/pricing",
      "GET /v2/customer/profile",
      "GET /v2/customer/model-allowlist",
      "GET /v2/customer/usage",
      "GET /v2/customer/credits/history",
    ]);
    expect(req(4).query).toEqual([]);
  });

  it("query encoding: scalars, nulls dropped, arrays repeated", async () => {
    const { account, req } = make(json(200, {}), json(200, {}), json(200, {}), json(200, {}), json(200, {}));
    await account.usage({ period: "7d", limit: 50, starting_after: null });
    expect(req(0).query).toEqual([["period", "7d"], ["limit", "50"]]);
    await account.usageByKey("key_ab/c", { from: "2026-10-01", to: "2026-10-06" });
    expect(req(1).path).toBe("/v2/customer/usage/key_ab%2Fc");
    expect(req(1).query).toEqual([["from", "2026-10-01"], ["to", "2026-10-06"]]);
    await account.usageTimeseries({ start_time: 1791000000, bucket_width: "1h", group_by: ["model", "key_id"], models: ["a", "b"] });
    expect(req(2).path).toBe("/v2/customer/usage/timeseries");
    expect(req(2).query).toEqual([["start_time", "1791000000"], ["bucket_width", "1h"], ["group_by", "model"], ["group_by", "key_id"], ["models", "a"], ["models", "b"]]);
    await account.metrics({ start_time: 1, end_time: 2, modes: ["direct"] });
    expect(req(3).path).toBe("/v2/customer/metrics");
    expect(req(3).query).toEqual([["start_time", "1"], ["end_time", "2"], ["modes", "direct"]]);
    await account.creditsHistory({ limit: 10, offset: 20, action: "topup" });
    expect(req(4).query).toEqual([["limit", "10"], ["offset", "20"], ["action", "topup"]]);
  });

  it("setModelAllowlist PATCHes the list, null clears", async () => {
    const { account, req } = make(json(200, { status: "ok", model_allowlist: ["direct.openai.openai/gpt-5.2"], updated_at: "t" }), json(200, { status: "ok", model_allowlist: null, updated_at: "t" }));
    await account.setModelAllowlist(["direct.openai.openai/gpt-5.2"]);
    expect(req(0)).toMatchObject({ method: "PATCH", path: "/v2/customer/model-allowlist", body: { model_allowlist: ["direct.openai.openai/gpt-5.2"] } });
    await account.setModelAllowlist(null);
    expect(req(1).body).toEqual({ model_allowlist: null });
  });

  it("F9: an inference key's 403 surfaces as PermissionDeniedError (no client-side guessing)", async () => {
    const { m, account } = make(relayError(403, null, { detail: "Superkey or JWT required" }));
    const e = await account.credits().catch((e) => e);
    expect(e).toBeInstanceOf(PermissionDeniedError);
    expect(e.status).toBe(403);
    expect(m.calls).toHaveLength(1);
  });

  it("creditsHistory with a superkey: staging answers 401 (JWT-only), surfaced as AuthenticationError", async () => {
    const { account } = make(relayError(401, null));
    await expect(account.creditsHistory()).rejects.toBeInstanceOf(AuthenticationError);
  });
});
