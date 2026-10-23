// Account-aware catalog reads on staging: the SDK test account is granted two private groups, so its keyed
// reads include their models and a keyless client's do not. Reads only; no inference. Skips without
// RELAY_BASE_URL / RELAY_API_KEY and refuses a production base URL.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Relay, ModelNotFoundError } from "./sdk.js";

function loadEnv() {
  const p = new URL("../../.env", import.meta.url);
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadEnv();
const { RELAY_API_KEY: apiKey, RELAY_BASE_URL: baseUrl } = process.env;
const prod = /relaygpu\.com|relay\.opengpu\.network|:1301\b/.test(baseUrl ?? "");
const suite = apiKey && baseUrl && !prod ? describe : describe.skip;

const HAIKU = "anthropic/claude-haiku-5-5";
const FILTER_OFF = "ByteDance/doubao-seedance-2-0-filter-off";

suite("account-aware catalog (staging, reads only)", () => {
  const keyed = () => new Relay({ apiKey, baseUrl });
  const keyless = () => new Relay({ baseUrl });

  it("keyed models.list() contains both private models; keyless contains neither", async () => {
    const names = (await keyed().models.list()).map((r) => r.name);
    expect(names).toContain(HAIKU);
    expect(names).toContain(FILTER_OFF);
    const pub = (await keyless().models.list()).map((r) => r.name);
    expect(pub).not.toContain(HAIKU);
    expect(pub).not.toContain(FILTER_OFF);
  });

  it("keyed models.get resolves the private model; keyless throws ModelNotFoundError", async () => {
    const d = await keyed().models.get(HAIKU);
    expect(d.status).toBe("available");
    expect(d.endpoint?.path).toBe("/v2/anthropic/v1/messages");
    await expect(keyless().models.get(HAIKU)).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it("keyed pricing.get() has a direct row for the private model; keyless has none", async () => {
    const has = (p: { pricing: { model: string; mode: string }[] }) => p.pricing.some((r) => r.mode === "direct" && r.model.slice(r.model.indexOf(".") + 1) === HAIKU);
    expect(has(await keyed().pricing.get())).toBe(true);
    expect(has(await keyless().pricing.get())).toBe(false);
  });

  it("keyed estimateCost for the private model returns a number", async () => {
    const e = await keyed().estimateCost(HAIKU, { input_tokens: 1000, output_tokens: 100 });
    expect(typeof e.usd).toBe("number");
    expect(e.usd).toBeGreaterThan(0);
  });
});
