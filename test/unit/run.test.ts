import { describe, expect, it } from "vitest";
import { ModelNotFoundError, ModelRetiredError, RelayError } from "../../src/errors.js";
import { isAccepted } from "../../src/run.js";
import { IMAGE_QWEN, TTS_QWEN, VIDEO_KLING, detail, detailWith, relayWith, task } from "../fixtures/catalog.js";
import { json, mockFetch, relayError } from "./helpers.js";

const posts = <C extends { method: string }>(calls: C[]) => calls.filter((c) => c.method === "POST");
const accepted202 = (headers: Record<string, string> = {}) => json(202, VIDEO_KLING.accepted.body, { "x-request-id": "rid-202", ...headers });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("run() resolution (F2, A2)", () => {
  it("model_in_body true → model sent; sync → the response body; no Idempotency-Key, no async field", async () => {
    const m = mockFetch(detail("Qwen/qwen-image"), json(200, IMAGE_QWEN.body));
    const out = await relayWith(m.fetch).run("Qwen/qwen-image", { prompt: "apple", size: "512x512" });
    expect(out).toEqual(IMAGE_QWEN.body);
    const post = m.calls[1];
    expect(post).toMatchObject({ method: "POST", url: "http://relay.test/v2/image/qwen/generate", body: { prompt: "apple", size: "512x512", model: "Qwen/qwen-image" } });
    expect(post.headers["idempotency-key"]).toBeUndefined();
    expect(post.body).not.toHaveProperty("async");
    expect(post.body).not.toHaveProperty("mode");
  });

  it("model_in_body false → model stripped (TTS)", async () => {
    const m = mockFetch(detail("Qwen/qwen3-tts-flash"), json(200, TTS_QWEN.body));
    await relayWith(m.fetch).run("Qwen/qwen3-tts-flash", { input: "hi", voice: "Cherry", model: "ignored" });
    expect(m.calls[1].url).toBe("http://relay.test/v2/audio/qwen3-tts-flash/generate");
    expect(m.calls[1].body).toEqual({ input: "hi", voice: "Cherry" });
  });

  it("async route + wait (default) → long-polls and returns task.result", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), accepted202(), json(200, VIDEO_KLING.completed.body));
    const out = await relayWith(m.fetch).run("KlingTeam/v3-T2V", { prompt: "ball", duration: 5 });
    expect(out).toEqual(VIDEO_KLING.completed.body.result);
    expect(m.calls[1].body).toEqual({ prompt: "ball", duration: 5, async: true });
    expect(m.calls[1].body).not.toHaveProperty("model");
    expect(m.calls[2].url).toBe(`http://relay.test/v2/tasks/${VIDEO_KLING.accepted.body.task_id}?wait=30`);
  });

  it("wait:false → the 202 envelope with replayed + requestId; isAccepted narrows it", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), accepted202());
    const out = await relayWith(m.fetch).run("KlingTeam/v3-T2V", { prompt: "ball" }, { wait: false });
    expect(isAccepted(out)).toBe(true);
    expect(out).toMatchObject({ ...VIDEO_KLING.accepted.body, replayed: false, requestId: "rid-202" });
    expect(isAccepted(IMAGE_QWEN.body)).toBe(false);
  });

  it("mode, storeOutput, webhookUrl map to body fields", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), accepted202());
    await relayWith(m.fetch).run("KlingTeam/v3-T2V", { prompt: "p" }, { wait: false, mode: "direct", storeOutput: "relay7d", webhookUrl: "https://hook.test/x" });
    expect(m.calls[1].body).toEqual({ prompt: "p", mode: "direct", store_output: "relay7d", webhook_url: "https://hook.test/x", async: true });
  });

  it("async:false on an async-default route sends async:false and no key", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), json(200, VIDEO_KLING.completed.body.result));
    const out = await relayWith(m.fetch).run("KlingTeam/v3-T2V", { prompt: "p" }, { async: false });
    expect(out).toEqual(VIDEO_KLING.completed.body.result);
    expect(m.calls[1].body).toMatchObject({ async: false });
    expect(m.calls[1].headers["idempotency-key"]).toBeUndefined();
  });

  it("a retired model throws ModelRetiredError with ZERO POSTs (endpoint present or null)", async () => {
    for (const name of ["black-forest-labs/FLUX.2-klein-4B", "xai/grok-4"]) {
      const m = mockFetch(detail(name));
      const e = await relayWith(m.fetch).run(name, { prompt: "x" }).catch((e) => e);
      expect(e).toBeInstanceOf(ModelRetiredError);
      expect(e).toMatchObject({ status: 403, code: "MODEL_RETIRED" });
      expect(posts(m.calls)).toHaveLength(0);
    }
  });

  it("an available model with no single route refuses before submit", async () => {
    const m = mockFetch(json(200, { name: "a/b", status: "available", endpoint: null }));
    const e = await relayWith(m.fetch).run("a/b", {}).catch((e) => e);
    expect(e).toBeInstanceOf(RelayError);
    expect(e).not.toBeInstanceOf(ModelRetiredError);
    expect(posts(m.calls)).toHaveLength(0);
  });

  it("an unknown model throws ModelNotFoundError with ZERO POSTs", async () => {
    const m = mockFetch(detail("nope/nope"));
    await expect(relayWith(m.fetch).run("nope/nope", {})).rejects.toBeInstanceOf(ModelNotFoundError);
    expect(posts(m.calls)).toHaveLength(0);
  });
});

describe("Idempotency-Key on submits (A8, F7 — fixture-pinned)", () => {
  it("a generated UUID rides every async submit: video default and image with async:true", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), accepted202(), accepted202());
    const relay = relayWith(m.fetch);
    await relay.video.generate("KlingTeam/v3-T2V", { prompt: "a" });
    await relay.video.generate("KlingTeam/v3-T2V", { prompt: "a" });
    const [k1, k2] = posts(m.calls).map((c) => c.headers["idempotency-key"]);
    expect(k1).toMatch(UUID);
    expect(k2).toMatch(UUID);
    expect(k1).not.toBe(k2);

    const m2 = mockFetch(detail("Qwen/qwen-image"), json(202, { task_id: "direct:i1", status: "queued", poll_url: "/v2/tasks/direct:i1", message: "m" }), task("completed", { task_id: "direct:i1", result: IMAGE_QWEN.body }));
    const img = await relayWith(m2.fetch).image.generate("Qwen/qwen-image", { prompt: "a" }, { async: true });
    expect(posts(m2.calls)[0].headers["idempotency-key"]).toMatch(UUID);
    expect(posts(m2.calls)[0].body).toMatchObject({ async: true, model: "Qwen/qwen-image" });
    expect(img.images[0].url).toBe(IMAGE_QWEN.body.urls[0]);
  });

  it("NONE rides a sync call (image, TTS, ASR), and a sync 5xx is not retried", async () => {
    const m = mockFetch(detail("Qwen/qwen-image"), json(200, IMAGE_QWEN.body), detail("Qwen/qwen3-tts-flash"), json(200, TTS_QWEN.body), detail("openai/whisper-1"), relayError(502, "UPSTREAM_ERROR", {}, { "retry-after": "0" }));
    const relay = relayWith(m.fetch);
    await relay.image.generate("Qwen/qwen-image", { prompt: "a" });
    await relay.audio.speech("Qwen/qwen3-tts-flash", { input: "hi", voice: "Cherry" });
    await expect(relay.audio.transcribe("openai/whisper-1", { audio_url: "https://x.test/a.mp3" })).rejects.toThrow();
    const p = posts(m.calls);
    expect(p).toHaveLength(3);
    expect(p.every((c) => c.headers["idempotency-key"] === undefined)).toBe(true);
    expect(p[2].body).toEqual({ audio_url: "https://x.test/a.mp3", model: "openai/whisper-1" });
  });

  it("a caller idempotencyKey is used verbatim", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), accepted202());
    await relayWith(m.fetch).video.generate("KlingTeam/v3-T2V", { prompt: "a" }, { idempotencyKey: "my-key-1" });
    expect(m.calls[1].headers["idempotency-key"]).toBe("my-key-1");
  });

  it("a 5xx on an async submit is retried once with the SAME key", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), relayError(502, "UPSTREAM_ERROR", {}, { "retry-after": "0" }), accepted202());
    const r = await relayWith(m.fetch).video.generate("KlingTeam/v3-T2V", { prompt: "a" });
    const p = posts(m.calls);
    expect(p).toHaveLength(2);
    expect(p[0].headers["idempotency-key"]).toMatch(UUID);
    expect(p[1].headers["idempotency-key"]).toBe(p[0].headers["idempotency-key"]);
    expect(r.task_id).toBe(VIDEO_KLING.accepted.body.task_id);
  });

  it("replayed: true surfaces from the Idempotency-Replayed header", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), accepted202({ "idempotency-replayed": "true" }));
    const r = await relayWith(m.fetch).video.generate("KlingTeam/v3-T2V", { prompt: "a" }, { idempotencyKey: "k" });
    expect(r).toMatchObject({ task_id: VIDEO_KLING.accepted.body.task_id, replayed: true });
  });
});
