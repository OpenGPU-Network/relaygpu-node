// A2 (catalog): free, keyless reads against staging — models.list, models.get for one model per family, run-path
// resolution WITHOUT a submit, retired → ModelRetiredError before any POST, unknown → ModelNotFoundError.
// Skips without RELAY_BASE_URL; refuses a production base URL. Costs nothing.
import { describe, expect, it } from "vitest";
import { Relay, ModelNotFoundError, ModelRetiredError } from "./sdk.js";
import { resolveEndpoint } from "../../src/submit.js";

const apiKey = process.env.RELAY_API_KEY;
const baseUrl = process.env.RELAY_BASE_URL;
const prod = /relaygpu\.com|relay\.opengpu\.network|:1301\b/.test(baseUrl ?? "");
const suite = baseUrl && !prod ? describe : describe.skip;

/** A client whose fetch counts requests by method. */
function counted() {
  const calls: { method: string; url: string }[] = [];
  const f = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? "GET", url: String(input) });
    return fetch(input, init);
  }) as typeof fetch;
  return { relay: new Relay({ apiKey, baseUrl, fetch: f }), calls, posts: () => calls.filter((c) => c.method === "POST").length };
}

const FAMILIES: [name: string, path: string, modelInBody: boolean, asyncDefault: boolean][] = [
  ["Qwen/qwen-image", "/v2/image/qwen/generate", true, false],
  ["openai/gpt-image-1.5-T2I", "/v2/image/gpt-image/generate", false, false],
  ["KlingTeam/v3-T2V", "/v2/video/kling-3/t2v", false, true],
  ["KlingTeam/v3-Motion-Control", "/v2/video/kling-3/motion-control", false, true],
  ["Qwen/qwen3-tts-flash", "/v2/audio/qwen3-tts-flash/generate", false, false],
  ["openai/whisper-1", "/v2/audio/asr/whisper", true, false],
  ["openai/gpt-5.4", "/v2/openai/v1/chat/completions", true, false],
];

suite("catalog e2e (staging, free)", () => {
  it("models.list flattens auto with unique names and endpoints; tag filter works", async () => {
    const { relay } = counted();
    const all = await relay.models.list();
    expect(all.length).toBeGreaterThan(50);
    expect(new Set(all.map((r) => r.name)).size).toBe(all.length);
    const kling = all.find((r) => r.name === "KlingTeam/v3-T2V");
    expect(kling?.endpoint?.path).toBe("/v2/video/kling-3/t2v");
    const t2v = await relay.models.list({ tag: "text-to-video" });
    expect(t2v.length).toBeGreaterThan(0);
    expect(t2v.every((r) => r.tag === "text-to-video")).toBe(true);
  });

  it("models.get resolves one model per family to its route — no submit, one fetch per name (cache)", async () => {
    const { relay, calls, posts } = counted();
    for (const [name, path, modelInBody, asyncDefault] of FAMILIES) {
      const d = await relay.models.get(name);
      expect(d.status, name).toBe("available");
      const ep = resolveEndpoint(name, d);
      expect(ep, name).toMatchObject({ path, model_in_body: modelInBody, async_default: asyncDefault });
      expect(d.request_schema, name).toBeTruthy();
      await relay.models.get(name);
    }
    expect(calls).toHaveLength(FAMILIES.length);
    expect(calls[0].url).toBe(`${baseUrl!.replace(/\/+$/, "")}/v2/models/Qwen/qwen-image`);
    expect(posts()).toBe(0);
  });

  it("pricing, tiers and health answer", async () => {
    const { relay } = counted();
    const p = await relay.pricing.get();
    expect(p.pricing.length).toBeGreaterThan(0);
    expect((await relay.tiers.list()).tiers.length).toBeGreaterThan(0);
    expect((await relay.health()).status).toBe("ok");
    const e = await relay.estimateCost("KlingTeam/v3-T2V", { duration_seconds: 5, quality_mode: "std", sound: false });
    expect(e.usd).toBeGreaterThan(0);
  });

  it("a retired model throws ModelRetiredError before any POST (endpoint present and endpoint null)", async () => {
    for (const name of ["black-forest-labs/FLUX.2-klein-4B", "xai/grok-4"]) {
      const { relay, posts } = counted();
      const e = await relay.run(name, { prompt: "x" }).catch((e) => e);
      expect(e, name).toBeInstanceOf(ModelRetiredError);
      expect(e.code).toBe("MODEL_RETIRED");
      await expect(relay.image.generate(name, { prompt: "x" })).rejects.toBeInstanceOf(ModelRetiredError);
      expect(posts()).toBe(0);
    }
  });

  it("an unknown model throws ModelNotFoundError (with requestId) before any POST", async () => {
    const { relay, posts } = counted();
    const e = await relay.run("nope/does-not-exist", {}).catch((e) => e);
    expect(e).toBeInstanceOf(ModelNotFoundError);
    expect(e.requestId).toBeTruthy();
    expect(posts()).toBe(0);
  });

  it("model names are case-sensitive (KlingTeam/v3-motion-control is not a model)", async () => {
    const { relay } = counted();
    await expect(relay.models.get("KlingTeam/v3-motion-control")).rejects.toBeInstanceOf(ModelNotFoundError);
  });
});
