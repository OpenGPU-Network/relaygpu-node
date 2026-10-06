// A8 + A1 (media): BILLED against staging — the lead runs this once. Skips without RELAY_API_KEY / RELAY_BASE_URL;
// refuses a production base URL. Approximate cost at 2026-10-06 list prices:
//   A8 Kling v3-T2V 5 s std silent: 1 task (0.42; the replay and the 422 create none) — not waited on
//   A1 image Qwen/qwen-image 512x512: 0.036 · TTS qwen3-tts-flash ~20 chars: ~0.0002
//   A1 ASR whisper-1 on that TTS clip (~2 s, implicit relay1h upload = free): ~0.0002
//   A1 video + wait: Kling v3-T2V 3 s std silent: 0.252
import { describe, expect, it } from "vitest";
import { Relay, IdempotencyKeyReusedError } from "./sdk.js";
import { randomUUID } from "../../src/util.js";

const apiKey = process.env.RELAY_API_KEY;
const baseUrl = process.env.RELAY_BASE_URL;
const prod = /relaygpu\.com|relay\.opengpu\.network|:1301\b/.test(baseUrl ?? "");
const suite = apiKey && baseUrl && !prod ? describe : describe.skip;

function counted() {
  const calls: { method: string; url: string; idem: string | null; body: any }[] = [];
  const f = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", url: String(input), idem: new Headers(init.headers).get("idempotency-key"), body });
    return fetch(input, init);
  }) as typeof fetch;
  return { relay: new Relay({ apiKey, baseUrl, fetch: f }), calls };
}

const KLING = "KlingTeam/v3-T2V";
// Results of the A1 runs, reused as real inputs for the A3 motion-control submit.
let videoUrl: string | undefined;
let imageUrl: string | undefined;

suite("media e2e (staging, billed)", () => {
  it("A8: same idempotencyKey → same task_id, second replayed; changed body → IdempotencyKeyReusedError", async () => {
    const { relay, calls } = counted();
    const K = `sdk-e2e-${await randomUUID()}`;
    const body = { prompt: "A red ball rolling slowly across a wooden table", duration: 3, quality_mode: "std", sound: false } as const;
    const first = await relay.video.generate(KLING, body, { idempotencyKey: K });
    const second = await relay.video.generate(KLING, body, { idempotencyKey: K });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.task_id).toBe(first.task_id);
    const e = await relay.video.generate(KLING, { ...body, prompt: "A blue ball" }, { idempotencyKey: K }).catch((e) => e);
    expect(e).toBeInstanceOf(IdempotencyKeyReusedError);
    expect(e).toMatchObject({ status: 422, code: "IDEMPOTENCY_KEY_REUSED" });
    const submits = calls.filter((c) => c.method === "POST");
    expect(submits).toHaveLength(3);
    expect(submits.every((c) => c.idem === K)).toBe(true);
  });

  it("A1/A8: a generated key rides the async video submit; wait long-polls in few requests", async () => {
    const { relay, calls } = counted();
    const seen: string[] = [];
    const t = await relay.video.generate(KLING, { prompt: "A paper boat on a calm pond", duration: 3, quality_mode: "std", sound: false }, { wait: true, onProgress: (p) => seen.push(p.status) });
    expect(t.status).toBe("completed");
    expect((t.result as { urls?: string[] }).urls?.[0]).toMatch(/^https:\/\//);
    const submit = calls.find((c) => c.method === "POST")!;
    expect(submit.idem).toMatch(/^[0-9a-f-]{36}$/);
    const polls = calls.filter((c) => c.url.includes("/v2/tasks/"));
    expect(polls.every((c) => /[?&]wait=\d+/.test(c.url))).toBe(true);
    // Each long-poll is held ≤ 30 s: the count is bounded by the task's own duration.
    expect(polls.length).toBeLessThanOrEqual(Math.ceil(t.elapsed_seconds / 30) + 2);
    expect(seen.at(-1)).toBe("completed");
    videoUrl = (t.result as { urls?: string[] }).urls?.[0];
    console.log(`A1 video: task ${t.task_id} elapsed ${t.elapsed_seconds}s, ${polls.length} poll requests, transitions ${seen.join(">")}`);
  }, 25 * 60_000);

  it("A1: image sync and TTS carry no Idempotency-Key; ASR takes a Blob through the implicit upload", async () => {
    const { relay, calls } = counted();
    const img = await relay.image.generate("Qwen/qwen-image", { prompt: "A small red apple on a white table", size: "512x512" });
    expect(img.images.length).toBeGreaterThan(0);
    expect(img.images[0].url).toMatch(/^https:\/\//);
    expect((await img.images[0].toBlob()).size).toBeGreaterThan(0);
    imageUrl = img.images[0].url;
    console.log(`A1 image: ${img.images.length} RelayImage(s), requestId-bearing 200`);

    const tts = await relay.audio.speech("Qwen/qwen3-tts-flash", { input: "Hello from the Relay SDK.", voice: "Cherry" });
    expect(tts.audio_url).toMatch(/^https:\/\//);
    const clip = await (await fetch(tts.audio_url)).blob();

    const asr = await relay.audio.transcribe("openai/whisper-1", { audio_url: clip.type.startsWith("audio/") ? clip : new Blob([clip], { type: "audio/wav" }) });
    expect(typeof asr.text).toBe("string");

    const inference = calls.filter((c) => c.method === "POST" && !c.url.includes("/v2/files"));
    expect(inference).toHaveLength(3);
    expect(inference.every((c) => c.idem === null)).toBe(true);
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("/v2/files"))).toHaveLength(1);
    // The implicit relay1h upload of the clip: delete it (test hygiene; it would expire in 1 h anyway).
    const sent = calls.find((c) => c.method === "POST" && c.url.includes("/v2/audio/asr/"))!.body.audio_url;
    const up = (await relay.files.list({ source: "upload", limit: 5 })).files.find((f) => f.url === sent);
    if (up) await relay.files.delete(up.file_id);
  }, 5 * 60_000);

  it("A3: motion control with a Blob in video_url uploads once and submits the URL (202, not waited on)", async () => {
    expect(videoUrl && imageUrl).toBeTruthy();
    const { relay, calls } = counted();
    const clip = await (await fetch(videoUrl!)).blob();
    const blob = clip.type.startsWith("video/") ? clip : new Blob([clip], { type: "video/mp4" });
    const accepted = await relay.video.generate("KlingTeam/v3-Motion-Control", {
      video_url: blob,
      image_url: imageUrl!,
      character_orientation: "video",
      duration: 5,
      quality_mode: "std",
    });
    expect(accepted.task_id).toMatch(/^(direct|opengpu):/);
    const uploads = calls.filter((c) => c.method === "POST" && c.url.includes("/v2/files"));
    expect(uploads).toHaveLength(1);
    const submit = calls.find((c) => c.method === "POST" && c.url.includes("/v2/video/kling-3/motion-control"))!;
    expect(submit.body.video_url).toMatch(/^https:\/\//);
    expect(submit.body.image_url).toBe(imageUrl);
    // The implicit upload is relay1h; find its ledger row and delete it.
    const files = await relay.files.list({ source: "upload", limit: 5 });
    const row = files.files.find((f) => f.url === submit.body.video_url);
    expect(row).toBeTruthy();
    console.log(`A3 motion control: task ${accepted.task_id}, implicit upload ${row!.file_id} (${row!.retention}), 1 /v2/files POST`);
    await relay.files.delete(row!.file_id);
  }, 5 * 60_000);
});
