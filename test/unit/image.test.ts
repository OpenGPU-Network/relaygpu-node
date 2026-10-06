import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { normaliseImages, toRelayImage } from "../../src/image.js";
import { IMAGE_QWEN, detail, relayWith } from "../fixtures/catalog.js";
import { json, mockFetch } from "./helpers.js";

// A 1×1 PNG (synthetic: no base64 route was captured, each costs a billed call).
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==";

describe("RelayImage normalisation", () => {
  it("urls[] (Qwen, Seedream, Wan: the captured qwen-image body) → url-backed images", () => {
    const imgs = normaliseImages(IMAGE_QWEN.body);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].url).toBe(IMAGE_QWEN.body.urls[0]);
    expect(imgs[0].b64).toBeUndefined();
  });

  it("images[] of bare base64 (FLUX-2-pro, gpt-image, Gemini) → b64 with the mime sniffed", async () => {
    const imgs = normaliseImages({ images: [PNG_B64, JPEG_B64], model: "black-forest-labs/FLUX-2-pro" });
    expect(imgs.map((i) => i.mimeType)).toEqual(["image/png", "image/jpeg"]);
    expect(imgs[0].url).toBeUndefined();
    const blob = await imgs[0].toBlob();
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer()).slice(1, 4)).toEqual(new TextEncoder().encode("PNG"));
  });

  it("data URIs keep their mime and drop the prefix; output_format is the fallback hint", () => {
    const d = toRelayImage(`data:image/webp;base64,${PNG_B64}`);
    expect(d).toMatchObject({ b64: PNG_B64, mimeType: "image/webp" });
    const hinted = normaliseImages({ images: ["AAAA"] }, { output_format: "webp" });
    expect(hinted[0].mimeType).toBe("image/webp");
    const links = normaliseImages({ images: ["https://cdn.relaygpu.com/content/x"] });
    expect(links[0].url).toBe("https://cdn.relaygpu.com/content/x");
    const oa = normaliseImages({ data: [{ b64_json: PNG_B64 }, { url: "https://x.test/y.png" }] });
    expect(oa.map((i) => i.url ?? i.mimeType)).toEqual(["image/png", "https://x.test/y.png"]);
  });

  it("save() writes the decoded bytes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "relay-img-")), "out.png");
    await toRelayImage(PNG_B64).save(path);
    expect(readFileSync(path).subarray(0, 8)).toEqual(Buffer.from(PNG_B64, "base64").subarray(0, 8));
  });
});

describe("image.generate", () => {
  it("returns { images, raw } for a sync route (model in body, no key)", async () => {
    const m = mockFetch(detail("Qwen/qwen-image"), json(200, IMAGE_QWEN.body));
    const r = await relayWith(m.fetch).image.generate("Qwen/qwen-image", { prompt: "apple", size: "512x512" });
    expect(r.raw).toEqual(IMAGE_QWEN.body);
    expect(r.images[0].url).toBe(IMAGE_QWEN.body.urls[0]);
    expect(m.calls[1].body).toEqual({ prompt: "apple", size: "512x512", model: "Qwen/qwen-image" });
  });

  it("a base64 route (gpt-image-1.5-T2I: model not in body)", async () => {
    const m = mockFetch(detail("openai/gpt-image-1.5-T2I"), json(200, { images: [PNG_B64], model: "openai/gpt-image-1.5-T2I", size: "1024x1024" }));
    const r = await relayWith(m.fetch).image.generate("openai/gpt-image-1.5-T2I", { prompt: "x", output_format: "png" });
    expect(r.images[0]).toMatchObject({ b64: PNG_B64, mimeType: "image/png" });
    expect(m.calls[1].url).toBe("http://relay.test/v2/image/gpt-image/generate");
    expect(m.calls[1].body).not.toHaveProperty("model");
  });

  it("edit() resolves the edit route", async () => {
    const m = mockFetch(detail("Qwen/qwen-image-edit"), json(200, IMAGE_QWEN.body));
    await relayWith(m.fetch).image.edit("Qwen/qwen-image-edit", { prompt: "x", image: "https://x.test/in.png" });
    expect(m.calls[1].url).toBe("http://relay.test/v2/image/qwen/edit");
  });

  it("types: known models get the generated body; unknown names fall back to a record", () => {
    const relay = relayWith(mockFetch().fetch);
    type QwenIn = Parameters<typeof relay.image.generate<"Qwen/qwen-image">>[1];
    expectTypeOf<QwenIn>().toHaveProperty("prompt");
    expectTypeOf<QwenIn>().not.toHaveProperty("model");
    type AnyIn = Parameters<typeof relay.image.generate<"someone/new-model">>[1];
    expectTypeOf<AnyIn>().toEqualTypeOf<Record<string, unknown>>();
    // @ts-expect-error prompt is required on the qwen route
    void (() => relay.image.generate("Qwen/qwen-image", { size: "512x512" }));
  });
});
