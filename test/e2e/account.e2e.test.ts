// Free e2e against staging: account reads, a JWT client, a throwaway key's lifecycle, the webhook
// secret (never printed). Never calls rotate. Skips without RELAY_BASE_URL / RELAY_API_KEY.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Relay } from "../../src/client.js";

function loadEnv() {
  const p = new URL("../../.env", import.meta.url);
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadEnv();
const { RELAY_BASE_URL: baseUrl, RELAY_API_KEY: apiKey, RELAY_TEST_EMAIL: email, RELAY_TEST_PASSWORD: password, RELAY_CUSTOMER_ID: customerId } = process.env;

describe.skipIf(!baseUrl || !apiKey)("account + keys + webhooks (staging, superkey, free)", () => {
  const relay = new Relay({ apiKey, baseUrl });

  it("credits, profile, usage, pricing, allowlist read with the superkey", async () => {
    const credits = await relay.account.credits();
    expect(typeof credits.balance).toBe("number");
    const profile = await relay.account.profile();
    expect(profile.tier_details?.is_custom).toBe(true);
    if (customerId) expect(profile.customer_id === customerId).toBe(true);
    const usage = await relay.account.usage({ limit: 5 });
    expect(Array.isArray(usage.keys)).toBe(true);
    const pricing = await relay.account.pricing();
    expect(Array.isArray(pricing.pricing)).toBe(true);
    const allow = await relay.account.modelAllowlist();
    expect("model_allowlist" in allow).toBe(true);
    const start = Math.floor(Date.now() / 1000) - 86_400;
    expect((await relay.account.usageTimeseries({ start_time: start })).object).toBeTruthy();
    expect((await relay.account.metrics({ start_time: start })).object).toBeTruthy();
  });

  it("keys.list shows the superkey, masked", async () => {
    const list = await relay.keys.list({ is_superkey: true, status: "active", limit: 1 });
    expect(list.total).toBe(1);
    expect(list.keys[0].is_superkey).toBe(true);
    expect(list.keys[0].key.endsWith("...")).toBe(true);
  });

  it("webhooks.secret() returns a whsec_ (value never printed); deliveries list reads", async () => {
    const s = await relay.webhooks.secret();
    expect(s.secret.startsWith("whsec_")).toBe(true);
    const page = await relay.webhooks.deliveries.list({ limit: 5 });
    expect(Array.isArray(page.data)).toBe(true);
  });

  it("throwaway key: mint (key_budget 0) → get → rename → topup 0.01 → revoke → delete", async () => {
    const name = `sdk-e2e-${Date.now()}`;
    const created = await relay.keys.create({ name, key_budget: 0 });
    const keyId = created.key_id;
    let deleted = false;
    try {
      expect(created.key.startsWith("relay_sk_")).toBe(true);
      expect(created.is_superkey).toBe(false);
      expect(created.key_budget).toBe(0);
      expect((await relay.keys.get(keyId)).name).toBe(name);
      await relay.keys.rename(keyId, `${name}-renamed`);
      expect((await relay.keys.list({ name: `${name}-renamed` })).keys[0]?.key_id).toBe(keyId);
      const top = await relay.keys.topup(keyId, 0.01);
      expect(top.new_budget).toBeCloseTo(0.01, 6);
      await relay.keys.revoke(keyId);
      expect((await relay.keys.get(keyId)).status).toBe("revoked");
      await relay.keys.delete(keyId);
      deleted = true;
      await expect(relay.keys.get(keyId)).rejects.toMatchObject({ code: "KEY_NOT_FOUND" });
    } finally {
      if (!deleted) {
        await relay.keys.revoke(keyId).catch(() => {});
        await relay.keys.delete(keyId).catch(() => {});
      }
    }
  });

  it.skipIf(!email || !password)("a { jwt } client reads credits", async () => {
    const res = await fetch(`${baseUrl}/v2/auth/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    const { access_token: jwt } = (await res.json()) as { access_token: string };
    const viaJwt = new Relay({ jwt, baseUrl });
    const credits = await viaJwt.account.credits();
    expect(typeof credits.balance).toBe("number");
    // credits history is JWT-only
    const history = await viaJwt.account.creditsHistory({ limit: 1 });
    expect(history).toBeTruthy();
  });
});
