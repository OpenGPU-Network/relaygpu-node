import { describe, expect, it } from "vitest";
import { ModelNotFoundError } from "../../src/errors.js";
import { DETAILS, MODELS, PRICING, detail, relayWith } from "../fixtures/catalog.js";
import { json, mockFetch } from "./helpers.js";

describe("models.get", () => {
  it("puts the slash raw in the path, sends no key, caches for one fetch per name", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"));
    const relay = relayWith(m.fetch);
    const a = await relay.models.get("KlingTeam/v3-T2V");
    const b = await relay.models.get("KlingTeam/v3-T2V");
    expect(a).toBe(b);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].url).toBe("http://relay.test/v2/models/KlingTeam/v3-T2V");
    expect(m.calls[0].headers["x-api-key"]).toBeUndefined();
    expect(a.endpoint).toMatchObject({ path: "/v2/video/kling-3/t2v", model_in_body: false, async_default: true });
  });

  it("keeps dots and the slash literal (FLUX.2-klein-4B)", async () => {
    const m = mockFetch(detail("black-forest-labs/FLUX.2-klein-4B"));
    await relayWith(m.fetch).models.get("black-forest-labs/FLUX.2-klein-4B");
    expect(m.calls[0].url).toBe("http://relay.test/v2/models/black-forest-labs/FLUX.2-klein-4B");
  });

  it("an unknown name is the typed ModelNotFoundError, and the failure is not cached", async () => {
    const m = mockFetch(detail("nope/nope"), detail("nope/nope"));
    const relay = relayWith(m.fetch);
    const e = await relay.models.get("nope/nope").catch((e) => e);
    expect(e).toBeInstanceOf(ModelNotFoundError);
    expect(e).toMatchObject({ status: 404, code: "MODEL_NOT_FOUND", requestId: DETAILS["nope/nope"].body.error.request_id });
    await expect(relay.models.get("nope/nope")).rejects.toBeInstanceOf(ModelNotFoundError);
    expect(m.calls).toHaveLength(2);
  });
});

describe("models.list", () => {
  it("flattens auto into unique rows and filters by tag", async () => {
    const m = mockFetch(json(200, MODELS), json(200, MODELS));
    const relay = relayWith(m.fetch);
    const all = await relay.models.list();
    const names = all.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("KlingTeam/v3-T2V");
    expect(names).toContain("Qwen/qwen-image");
    const videos = await relay.models.list({ tag: "text-to-video" });
    expect(videos.length).toBeGreaterThan(0);
    expect(videos.every((r) => r.tag === "text-to-video")).toBe(true);
    expect(videos.map((r) => r.name)).toContain("KlingTeam/v3-T2V");
    expect(m.calls[0].url).toBe("http://relay.test/v2/models");
  });
});

describe("pricing, tiers, health", () => {
  it("are keyless GETs", async () => {
    const m = mockFetch(json(200, PRICING), json(200, { tiers: [] }), json(200, { status: "ok", version: "2", commit: "abc" }));
    const relay = relayWith(m.fetch);
    expect((await relay.pricing.get()).media_storage).toMatchObject({ relay1d: 0.0005 });
    await relay.tiers.list();
    expect(await relay.health()).toMatchObject({ status: "ok" });
    expect(m.calls.map((c) => c.url)).toEqual(["http://relay.test/v2/pricing", "http://relay.test/v2/tiers", "http://relay.test/v2/health"]);
    expect(m.calls.every((c) => c.headers["x-api-key"] === undefined)).toBe(true);
  });
});
