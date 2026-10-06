import { describe, expect, it } from "vitest";
import { RelayError } from "../../src/errors.js";
import { PRICING, relayWith } from "../fixtures/catalog.js";
import { json, mockFetch } from "./helpers.js";

// Rows from the /v2/pricing capture of 2026-10-06 (staging).
const est = async (model: string, usage: Parameters<ReturnType<typeof relayWith>["estimateCost"]>[1]) => {
  const m = mockFetch(json(200, PRICING));
  const r = await relayWith(m.fetch).estimateCost(model, usage);
  expect(m.calls).toHaveLength(1);
  expect(m.calls[0].url).toBe("http://relay.test/v2/pricing");
  return r;
};

describe("estimateCost (F8)", () => {
  it("per_token: input/output, cached subset, Anthropic cache writes", async () => {
    // openai.openai/gpt-5.5: 5 / 30 / 0.5 cached
    expect((await est("openai/gpt-5.5", { input_tokens: 200_000, output_tokens: 100_000 })).usd).toBeCloseTo(0.2 * 5 + 0.1 * 30, 8);
    expect((await est("openai/gpt-5.5", { input_tokens: 200_000, cached_input_tokens: 80_000 })).usd).toBeCloseTo(0.12 * 5 + 0.08 * 0.5, 8);
    // anthropic/claude-fable-5-1: 10 / 50 / 0.25 cached / 12.5 5m-write / 20 1h-write
    const r = await est("anthropic/claude-fable-5-1", { input_tokens: 1_000_000, cache_write_5m_input_tokens: 200_000, cache_write_1h_input_tokens: 100_000, output_tokens: 0 });
    expect(r.usd).toBeCloseTo(0.7 * 10 + 0.2 * 12.5 + 0.1 * 20, 8);
    expect(r.basis).toContain("5m-write");
  });

  it("per_token long context reprices the whole request above the threshold", async () => {
    // gpt-5.5 threshold 278528 → long 10 / 45
    const r = await est("openai/gpt-5.5", { input_tokens: 300_000, output_tokens: 10_000 });
    expect(r.usd).toBeCloseTo(0.3 * 10 + 0.01 * 45, 8);
    expect(r.basis).toContain("long context");
  });

  it("per_image: flat and resolution tiers (unknown tier falls back to the cheapest without a default)", async () => {
    expect((await est("Qwen/qwen-image", { image_count: 2 })).usd).toBeCloseTo(0.072, 8);
    expect((await est("google/gemini-3-pro-image", { image_count: 1, resolution_tier: "4K" })).usd).toBeCloseTo(0.24, 8);
    const g = await est("openai/gpt-image-2", { image_count: 1, resolution_tier: "1024x1024" });
    expect(g.usd).toBeCloseTo(0.211, 8);
    expect(g.basis).toContain("1024x1024");
  });

  it("per_second_video: Kling quality|sound grid, default cell, resolution map", async () => {
    const k = await est("KlingTeam/v3-T2V", { duration_seconds: 5, quality_mode: "std", sound: false });
    expect(k.usd).toBeCloseTo(0.42, 8);
    expect(k.basis).toBe("per_second_video: 5 s × $0.084 (std|silent)");
    expect((await est("KlingTeam/v3-T2V", { duration_seconds: 5 })).usd).toBeCloseTo(0.84, 8); // default = most expensive
    expect((await est("Wan-AI/Wan2.5-T2V", { duration_seconds: 10, resolution_tier: "1080p" })).usd).toBeCloseTo(1, 8);
  });

  it("per_character, per_second_audio, per_media_token", async () => {
    expect((await est("Qwen/qwen3-tts-flash", { character_count: 17 })).usd).toBeCloseTo((17 * 0.0112) / 1000, 10);
    expect((await est("openai/whisper-1", { duration_seconds: 60 })).usd).toBeCloseTo(0.006, 10);
    expect((await est("ByteDance/doubao-seedance-2-0-260128", { media_output_tokens: 1_000_000 })).usd).toBeCloseTo(7.14, 8);
  });

  it("adds the per-file storage fee for store_output and retention (from media_storage)", async () => {
    const r = await est("Qwen/qwen-image", { image_count: 2, store_output: "relay7d" });
    expect(r.usd).toBeCloseTo(0.072 + 2 * 0.001, 8);
    expect(r.basis).toContain("store_output relay7d");
    expect((await est("Qwen/qwen-image", { image_count: 1, store_output: "provider", retention: "relay1h" })).usd).toBeCloseTo(0.036, 8);
    expect((await est("Qwen/qwen-image", { image_count: 1, retention: "relay30d" })).usd).toBeCloseTo(0.036 + 0.003, 8);
  });

  it("mode selects the row: opengpu rows are separate", async () => {
    expect((await est("Qwen/Qwen3.5-397B-A17B-FP8", { mode: "opengpu", input_tokens: 1_000_000 })).usd).toBeCloseTo(0.16, 8);
  });

  it("throws a RelayError for an unknown model, an unoffered SKU, an unknown billing type", async () => {
    await expect(est("nope/nope", {})).rejects.toThrow(/no direct pricing row for "nope\/nope"/);
    await expect(est("Qwen/qwen-image", { store_output: "relay90d" })).rejects.toThrow(/not offered/);
    const m = mockFetch(json(200, { pricing: [{ mode: "direct", model: "x.a/b", billing_type: "per_galaxy" }], total_count: 1 }));
    const e = await relayWith(m.fetch).estimateCost("a/b", {}).catch((e) => e);
    expect(e).toBeInstanceOf(RelayError);
    expect(e.message).toMatch(/per_galaxy/);
  });
});
