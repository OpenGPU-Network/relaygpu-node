// A3 (files): a ~20 MB mp4 streamed to POST /v2/files with relay1d, then an idempotent replay.
// Staging only; skips without RELAY_API_KEY / RELAY_BASE_URL. Costs one relay1d fee (0.0005).
// The server judges the type by the declared Content-Type only (no magic-byte check; a 4 KB
// ftyp-plus-padding stream was accepted on staging 2026-10-06), so the body is synthetic.
import { afterAll, describe, expect, it } from "vitest";
import { Relay } from "./sdk.js";

const apiKey = process.env.RELAY_API_KEY;
const baseUrl = process.env.RELAY_BASE_URL;
const prod = /relaygpu\.com|relay\.opengpu\.network|:1301\b/.test(baseUrl ?? "");
const run = apiKey && baseUrl && !prod ? describe : describe.skip;

const SIZE = 20 * 1024 * 1024;
const CHUNK = 1024 * 1024;

/** An ftyp box + zero padding, streamed in 1 MB chunks (never held whole in memory). */
function mp4Stream(): ReadableStream<Uint8Array> {
  const ftyp = Uint8Array.from([0, 0, 0, 0x18, ...[..."ftypisom"].map((c) => c.charCodeAt(0)), 0, 0, 2, 0, ...[..."isommp41"].map((c) => c.charCodeAt(0))]);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent >= SIZE) return ctrl.close();
      const n = Math.min(CHUNK, SIZE - sent);
      const chunk = new Uint8Array(n);
      if (sent === 0) chunk.set(ftyp);
      sent += n;
      ctrl.enqueue(chunk);
    },
  });
}

run("files e2e (staging)", () => {
  const relay = new Relay({ apiKey, baseUrl });
  const created = new Set<string>();

  afterAll(async () => {
    for (const id of created) await relay.files.delete(id);
  });

  it("A3: a 20 MB mp4 stream uploads with relay1d, and a keyed replay answers the same file", async () => {
    const idempotencyKey = `sdk-e2e-a3-${Date.now()}`;
    const first = await relay.files.upload(mp4Stream(), { retention: "relay1d", filename: "a3.mp4", idempotencyKey });
    created.add(first.file_id);
    expect(first.source).toBe("upload");
    expect(first.content_type).toBe("video/mp4");
    expect(first.size_bytes).toBe(SIZE);
    expect(first.retention).toBe("relay1d");
    expect(first.status).toBe("ready");
    expect(first.cost_usd).toBe(0.0005);
    expect(first.url).toMatch(/^https:\/\/cdn\.relaygpu\.com\//);

    const replay = await relay.files.upload(mp4Stream(), { retention: "relay1d", filename: "a3.mp4", idempotencyKey });
    created.add(replay.file_id);
    expect(replay.file_id).toBe(first.file_id);
    expect(replay.url).toBe(first.url);

    const got = await relay.files.get(first.file_id);
    expect(got.status).toBe("ready");
  }, 300_000);
});
