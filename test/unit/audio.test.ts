import { describe, expect, expectTypeOf, it } from "vitest";
import { TTS_QWEN, detail, relayWith, task } from "../fixtures/catalog.js";
import { json, mockFetch } from "./helpers.js";

describe("audio", () => {
  it("speech → the response body (the captured qwen3-tts-flash answer), model not in body", async () => {
    const m = mockFetch(detail("Qwen/qwen3-tts-flash"), json(200, TTS_QWEN.body));
    const r = await relayWith(m.fetch).audio.speech("Qwen/qwen3-tts-flash", { input: "Hello from Relay.", voice: "Cherry" });
    expect(r).toEqual(TTS_QWEN.body);
    expect(r.audio_url).toMatch(/^https:\/\/cdn\.relaygpu\.com\//);
    expect(m.calls[1]).toMatchObject({ url: "http://relay.test/v2/audio/qwen3-tts-flash/generate", body: { input: "Hello from Relay.", voice: "Cherry" } });
    expect(m.calls[1].headers["idempotency-key"]).toBeUndefined();
  });

  it("transcribe → POST /v2/audio/asr/whisper with model in body", async () => {
    const m = mockFetch(detail("openai/whisper-1"), json(200, { text: "hello", language: "en", duration: 1.2, task_id: "direct:a", mode: "direct" }));
    const r = await relayWith(m.fetch).audio.transcribe("openai/whisper-1", { audio_url: "https://x.test/a.mp3", language: "en" });
    expect(r.text).toBe("hello");
    expect(m.calls[1]).toMatchObject({ url: "http://relay.test/v2/audio/asr/whisper", body: { audio_url: "https://x.test/a.mp3", language: "en", model: "openai/whisper-1" } });
  });

  it("an async answer (async: true) is waited for and the result returned", async () => {
    const m = mockFetch(detail("Qwen/qwen3-tts-flash"), json(202, { task_id: "direct:t1", status: "queued", poll_url: "/v2/tasks/direct:t1", message: "m" }), task("completed", { result: TTS_QWEN.body }));
    const r = await relayWith(m.fetch).audio.speech("Qwen/qwen3-tts-flash", { input: "x", voice: "Cherry" }, { async: true });
    expect(r).toEqual(TTS_QWEN.body);
    expect(m.calls[1].headers["idempotency-key"]).toBeTruthy();
  });

  it("types: transcribe takes only ASR models' bodies; audio_url accepts a Blob", () => {
    const relay = relayWith(mockFetch().fetch);
    type AsrIn = Parameters<typeof relay.audio.transcribe<"openai/whisper-1">>[1];
    expectTypeOf<AsrIn>().toHaveProperty("audio_url");
    void (() => relay.audio.transcribe("openai/whisper-1", { audio_url: new Blob([]) }));
    // @ts-expect-error input/voice are required on qwen3-tts-flash
    void (() => relay.audio.speech("Qwen/qwen3-tts-flash", {}));
  });
});
