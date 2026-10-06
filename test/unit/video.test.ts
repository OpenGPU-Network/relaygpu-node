import { describe, expect, expectTypeOf, it } from "vitest";
import { TaskFailedError } from "../../src/errors.js";
import { VIDEO_KLING, detail, relayWith, task } from "../fixtures/catalog.js";
import { json, mockFetch } from "./helpers.js";

const accepted = () => json(202, VIDEO_KLING.accepted.body, { "x-request-id": "rid" });

describe("video.generate", () => {
  it("returns the 202 envelope by default (route path from models.get, no model in body)", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), accepted());
    const r = await relayWith(m.fetch).video.generate("KlingTeam/v3-T2V", { prompt: "ball", duration: 5, quality_mode: "std", sound: false });
    expect(r).toEqual({ ...VIDEO_KLING.accepted.body, replayed: false, requestId: "rid" });
    expect(m.calls[1]).toMatchObject({ method: "POST", url: "http://relay.test/v2/video/kling-3/t2v", body: { prompt: "ball", duration: 5, quality_mode: "std", sound: false, async: true } });
    expect(m.calls).toHaveLength(2);
  });

  it("{ wait: true } long-polls and returns the completed TaskStatus; onProgress on transitions", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), accepted(), task("running", { elapsed_seconds: 30 }), json(200, VIDEO_KLING.completed.body));
    const seen: string[] = [];
    const t = await relayWith(m.fetch).video.generate("KlingTeam/v3-T2V", { prompt: "ball" }, { wait: true, onProgress: (p) => seen.push(p.status) });
    expect(t).toEqual(VIDEO_KLING.completed.body);
    expect((t.result as { urls: string[] }).urls[0]).toMatch(/^https:\/\/cdn\.relaygpu\.com\//);
    expect(seen).toEqual(["running", "completed"]);
    expect(m.calls.slice(2).every((c) => c.url.endsWith("?wait=30"))).toBe(true);
  });

  it("{ wait: true } on a failed task throws TaskFailedError", async () => {
    const m = mockFetch(detail("KlingTeam/v3-T2V"), accepted(), task("failed", { error: "upstream timed out", error_code: "UPSTREAM_TIMEOUT", error_detail: null }));
    const e = await relayWith(m.fetch).video.generate("KlingTeam/v3-T2V", { prompt: "x" }, { wait: true }).catch((e) => e);
    expect(e).toBeInstanceOf(TaskFailedError);
    expect(e.code).toBe("UPSTREAM_TIMEOUT");
  });

  it("motion control resolves its own route; video_url is the reference field", async () => {
    const m = mockFetch(detail("KlingTeam/v3-Motion-Control"), accepted());
    await relayWith(m.fetch).video.generate("KlingTeam/v3-Motion-Control", { image_url: "https://x.test/i.png", video_url: "https://x.test/v.mp4", character_orientation: "image" });
    expect(m.calls[1].url).toBe("http://relay.test/v2/video/kling-3/motion-control");
    expect(m.calls[1].body).toMatchObject({ video_url: "https://x.test/v.mp4", async: true });
  });

  it("types: the default return is the envelope, wait:true the TaskStatus; *_url fields accept a Blob", () => {
    const relay = relayWith(mockFetch().fetch);
    const call = () => relay.video.generate("KlingTeam/v3-T2V", { prompt: "p" });
    expectTypeOf<Awaited<ReturnType<typeof call>>>().toHaveProperty("replayed");
    const waited = () => relay.video.generate("KlingTeam/v3-T2V", { prompt: "p" }, { wait: true });
    expectTypeOf<Awaited<ReturnType<typeof waited>>>().toHaveProperty("elapsed_seconds");
    void (() => relay.video.generate("KlingTeam/v3-Motion-Control", { image_url: new Blob([]), video_url: new Uint8Array(1), character_orientation: "image" }));
  });
});
