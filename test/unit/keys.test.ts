import { describe, expect, it } from "vitest";
import type { Relay } from "../../src/client.js";
import { KeyBudgetExhaustedError, KeyNotFoundError, NotFoundError, PermissionDeniedError, RelayInternalError } from "../../src/errors.js";
import { HttpClient } from "../../src/http.js";
import { Keys } from "../../src/keys.js";
import { json, mockFetch, relayError } from "./helpers.js";

function make(...replies: Parameters<typeof mockFetch>) {
  const m = mockFetch(...replies);
  const keys = new Keys({ _http: new HttpClient({ apiKey: "relay_sk_unit", baseUrl: "http://relay.test", fetch: m.fetch }) } as unknown as Relay);
  const req = (i: number) => {
    const u = new URL(m.calls[i].url);
    return { method: m.calls[i].method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: m.calls[i].body };
  };
  return { m, keys, req };
}

const key = (id: string) => ({ key: "relay_sk_abcdefghijkl...", key_id: id, name: id, status: "active", created_at: "t", last_used_at: null, restrictions: {}, key_budget: null, is_superkey: false, system: false });
const page = (ids: string[], next: string | null) => ({ total: 9, max_allowed: 20, limit: ids.length, has_more: next != null, next_cursor: next, keys: ids.map(key) });

describe("keys.list / listAll / get", () => {
  it("list encodes filters", async () => {
    const { keys, req } = make(json(200, page([], null)));
    await keys.list({ status: "active", name_prefix: "sdk-", is_superkey: false, limit: 5 });
    expect(req(0)).toMatchObject({ method: "GET", path: "/v2/customer/keys", query: { status: "active", name_prefix: "sdk-", is_superkey: "false", limit: "5" } });
  });

  it("listAll follows next_cursor as starting_after", async () => {
    const { keys, req, m } = make(json(200, page(["k1", "k2"], "k2")), json(200, page(["k3"], null)));
    const ids: string[] = [];
    for await (const k of keys.listAll({ status: "active" })) ids.push(k.key_id!);
    expect(ids).toEqual(["k1", "k2", "k3"]);
    expect(m.calls).toHaveLength(2);
    expect(req(0).query).toEqual({ status: "active" });
    expect(req(1).query).toEqual({ status: "active", starting_after: "k2" });
  });

  it("get pages the list (limit 1000) and stops at the match", async () => {
    const { keys, req, m } = make(json(200, page(["k1", "k2"], "k2")), json(200, page(["k3", "k4"], "k4")), json(200, page(["k5"], null)));
    expect((await keys.get("k3")).key_id).toBe("k3");
    expect(m.calls).toHaveLength(2);
    expect(req(0).query).toEqual({ limit: "1000" });
  });

  it("get on an absent key_id throws KeyNotFoundError (client-side, code KEY_NOT_FOUND)", async () => {
    const { keys } = make(json(200, page(["k1"], "k1")), json(200, page(["k2"], null)));
    const e = await keys.get("nope").catch((e) => e);
    expect(e).toBeInstanceOf(KeyNotFoundError);
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e.code).toBe("KEY_NOT_FOUND");
  });
});

describe("keys mutations", () => {
  it("paths, methods and bodies; key_id is path-escaped", async () => {
    const { keys, req } = make(...Array.from({ length: 8 }, () => json(200, {})));
    await keys.create({ name: "end_user_42", key_budget: 5 });
    await keys.rename("key_1", "renamed");
    await keys.update("key_1", { key_budget: null });
    await keys.revoke("key_1");
    await keys.unrevoke("key_1");
    await keys.delete("key_1");
    await keys.topup("key_1", 2.5);
    await keys.promote("key/1");
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => [req(i).method, req(i).path, req(i).body])).toEqual([
      ["POST", "/v2/customer/keys", { name: "end_user_42", key_budget: 5 }],
      ["PATCH", "/v2/customer/keys/key_1", { name: "renamed" }],
      ["PATCH", "/v2/customer/keys/key_1", { key_budget: null }],
      ["POST", "/v2/customer/keys/key_1/revoke", undefined],
      ["POST", "/v2/customer/keys/key_1/unrevoke", undefined],
      ["DELETE", "/v2/customer/keys/key_1", undefined],
      ["POST", "/v2/customer/keys/key_1/topup", { amount: 2.5 }],
      ["POST", "/v2/customer/keys/key%2F1/promote", undefined],
    ]);
  });

  it("create is never retried (no Idempotency-Key; a retry could mint twice)", async () => {
    const { keys, m } = make(relayError(500, "INTERNAL_ERROR"), json(201, {}));
    await expect(keys.create({ name: "x" })).rejects.toBeInstanceOf(RelayInternalError);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].headers["idempotency-key"]).toBeUndefined();
  });

  it("server refusals surface typed: 403 (non-custom key_budget, superkey promote) and 402", async () => {
    const { keys } = make(relayError(403, null), relayError(403, "KEY_NOT_OWNED"), relayError(402, "KEY_BUDGET_EXHAUSTED"));
    await expect(keys.create({ name: "x", key_budget: 1 })).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(keys.promote("key_1")).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(keys.topup("key_1", 1)).rejects.toBeInstanceOf(KeyBudgetExhaustedError);
  });
});
