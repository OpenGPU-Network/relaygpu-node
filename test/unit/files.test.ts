import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Files } from "../../src/files.js";
import { HttpClient } from "../../src/http.js";
import type { Relay } from "../../src/client.js";
import { FileNotFoundError, FileQuotaExceededError, FileTooLargeError, FileTypeUnsupportedError, InsufficientCreditsError, RateLimitError, RelayAPIError } from "../../src/errors.js";
import { json, mockFetch, relayError, type Recorded } from "./helpers.js";

// Node 18 has no global File; node:buffer has had one since 18.13.
const File = globalThis.File ?? ((await import("node:buffer")).File as unknown as typeof globalThis.File);

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}_20261006.json`, import.meta.url), "utf8"));
const UPLOAD = fixture("files_upload_201");
const UPLOAD_STREAM = fixture("files_upload_stream_201");
const GET = fixture("files_get_200");
const LIST = fixture("files_list_200");
const E404 = fixture("files_get_404");
const E415 = fixture("files_upload_415");

const KEY = "relay_sk_unit_secret_never_logged";
const filesWith = (...replies: Parameters<typeof mockFetch>) => {
  const m = mockFetch(...replies);
  const http = new HttpClient({ apiKey: KEY, baseUrl: "http://relay.test", fetch: m.fetch, retry: { maxRetryAfterMs: 0 } });
  return { files: new Files({ _http: http } as unknown as Relay), calls: m.calls };
};
const created = (body = UPLOAD.body) => json(201, body);
const q = (c: Recorded) => new URL(c.url).searchParams;

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((x) => c.enqueue(x));
      c.close();
    },
  });

describe("files.upload", () => {
  it("sends the raw body with its media type, retention and filename on the query", async () => {
    const { files, calls } = filesWith(created());
    const blob = new File([PNG], "pixel.png", { type: "image/png" });
    const f = await files.upload(blob, { retention: "relay1h" });
    expect(f).toEqual(UPLOAD.body);
    const c = calls[0];
    expect(c.method).toBe("POST");
    expect(new URL(c.url).pathname).toBe("/v2/files");
    expect(q(c).get("retention")).toBe("relay1h");
    expect(q(c).get("filename")).toBe("pixel.png");
    expect(c.headers["content-type"]).toBe("image/png");
    expect(c.body).toBe(blob); // passed through, never buffered
  });

  it("omits absent query params; opts.contentType and opts.filename win", async () => {
    const { files, calls } = filesWith(created());
    await files.upload(new Blob([PNG], { type: "image/png" }), { contentType: "image/x-custom", filename: "a.bin" });
    expect(calls[0].headers["content-type"]).toBe("image/x-custom");
    expect(q(calls[0]).get("filename")).toBe("a.bin");
    expect(q(calls[0]).has("retention")).toBe(false);
  });

  it("forwards Idempotency-Key", async () => {
    const { files, calls } = filesWith(created(), created());
    const a = await files.upload(PNG, { idempotencyKey: "clip-001" });
    const b = await files.upload(PNG, { idempotencyKey: "clip-001" });
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual(["clip-001", "clip-001"]);
    expect(a.file_id).toBe(b.file_id);
  });

  it("sniffs png / jpeg / webp / gif / mp4 / mov / webm / wav / mp3 / ogg / flac", async () => {
    const pad = (b: number[]) => Uint8Array.from([...b, ...new Array(16).fill(0)]);
    const s = (t: string) => [...t].map((c) => c.charCodeAt(0));
    const cases: [Uint8Array, string][] = [
      [PNG, "image/png"],
      [pad([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"],
      [pad([...s("RIFF"), 0, 0, 0, 0, ...s("WEBP")]), "image/webp"],
      [pad(s("GIF89a")), "image/gif"],
      [MP4, "video/mp4"],
      [pad([0, 0, 0, 0x14, ...s("ftypqt  ")]), "video/quicktime"],
      [pad([0x1a, 0x45, 0xdf, 0xa3]), "video/webm"],
      [pad([...s("RIFF"), 0, 0, 0, 0, ...s("WAVE")]), "audio/wav"],
      [pad(s("ID3")), "audio/mpeg"],
      [pad([0xff, 0xfb, 0x90]), "audio/mpeg"],
      [pad(s("OggS")), "audio/ogg"],
      [pad(s("fLaC")), "audio/flac"],
    ];
    const { files, calls } = filesWith(...cases.map(() => created()));
    for (const [bytes] of cases) await files.upload(bytes.buffer as ArrayBuffer);
    expect(calls.map((c) => c.headers["content-type"])).toEqual(cases.map(([, t]) => t));
  });

  it("refuses an unrecognisable type before sending anything", async () => {
    const { files, calls } = filesWith();
    await expect(files.upload(new TextEncoder().encode("hello world, plain text"))).rejects.toThrow(TypeError);
    await expect(files.upload(new Blob(["hello"]))).rejects.toThrow(/contentType/);
    await expect(files.upload("not a file" as never)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("a ReadableStream is peeked for its type and still sends every byte, once", async () => {
    let sent: Uint8Array | null = null;
    const { files, calls } = filesWith(async (req) => {
      sent = new Uint8Array(await new Response(req.body as ReadableStream).arrayBuffer());
      return created(UPLOAD_STREAM.body);
    });
    const tail = new Uint8Array(5000).fill(7);
    const f = await files.upload(streamOf(MP4.subarray(0, 6), MP4.subarray(6), tail), { retention: "relay1h", filename: "tiny.mp4" });
    expect(f.content_type).toBe("video/mp4");
    expect(calls[0].headers["content-type"]).toBe("video/mp4");
    expect(sent!.byteLength).toBe(MP4.byteLength + tail.byteLength);
    expect(Array.from(sent!.subarray(0, 16))).toEqual(Array.from(MP4));
  });

  it("a streamed upload is never retried, even with an idempotency key", async () => {
    const { files, calls } = filesWith(relayError(502, "UPSTREAM_ERROR"), created());
    await expect(files.upload(streamOf(MP4), { idempotencyKey: "k" })).rejects.toMatchObject({ status: 502 });
    expect(calls).toHaveLength(1);
  });

  it("a keyed Blob upload is retried on 5xx with the same key", async () => {
    const { files, calls } = filesWith(relayError(502, "UPSTREAM_ERROR"), created());
    const f = await files.upload(new Blob([PNG], { type: "image/png" }), { idempotencyKey: "k" });
    expect(f.file_id).toBe(UPLOAD.body.file_id);
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual(["k", "k"]);
  });
});

describe("files.copy", () => {
  it("posts the JSON form with retention and filename in the body, none on the query", async () => {
    const { files, calls } = filesWith(created());
    await files.copy("https://example.com/voice.wav", { retention: "relay7d", filename: "voice.wav", idempotencyKey: "c1" });
    const c = calls[0];
    expect(c.url).toBe("http://relay.test/v2/files");
    expect(c.headers["content-type"]).toBe("application/json");
    expect(c.headers["idempotency-key"]).toBe("c1");
    expect(c.body).toEqual({ url: "https://example.com/voice.wav", retention: "relay7d", filename: "voice.wav" });
  });

  it("sends only the url when nothing else is given", async () => {
    const { files, calls } = filesWith(created());
    await files.copy("https://example.com/a.png");
    expect(calls[0].body).toEqual({ url: "https://example.com/a.png" });
  });
});

describe("files.get / list / listAll / delete", () => {
  it("get returns the file", async () => {
    const { files, calls } = filesWith(json(200, GET.body));
    expect(await files.get(GET.body.file_id)).toEqual(GET.body);
    expect(calls[0].url).toBe(`http://relay.test/v2/files/${GET.body.file_id}`);
  });

  it("list sends the filters and returns the page", async () => {
    const { files, calls } = filesWith(json(200, LIST.body));
    const page = await files.list({ source: "upload", status: "ready", limit: 1, cursor: "file_x" });
    expect(page).toEqual(LIST.body);
    expect(Object.fromEntries(q(calls[0]))).toEqual({ source: "upload", status: "ready", limit: "1", cursor: "file_x" });
  });

  it("listAll follows next_cursor to the null page", async () => {
    const f = (id: string) => ({ ...LIST.body.files[0], file_id: id });
    const { files, calls } = filesWith(
      json(200, { files: [f("a"), f("b")], next_cursor: "b" }),
      json(200, { files: [f("c")], next_cursor: "c" }),
      json(200, { files: [], next_cursor: null }),
    );
    const ids: string[] = [];
    for await (const x of files.listAll({ source: "upload", limit: 2 })) ids.push(x.file_id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(calls.map((c) => q(c).get("cursor"))).toEqual([null, "b", "c"]);
    expect(calls.every((c) => q(c).get("limit") === "2" && q(c).get("source") === "upload")).toBe(true);
  });

  it("delete answers 204 → void", async () => {
    const { files, calls } = filesWith(new Response(null, { status: 204 }));
    expect(await files.delete("file_1")).toBeUndefined();
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("http://relay.test/v2/files/file_1");
  });
});

describe("files errors map to the core's typed classes", () => {
  it("404 FILE_NOT_FOUND (captured)", async () => {
    const { files } = filesWith(json(404, E404.body));
    const e = await files.get("file_000000000000000000000000").catch((x) => x);
    expect(e).toBeInstanceOf(FileNotFoundError);
    expect(e.code).toBe("FILE_NOT_FOUND");
    expect(e.requestId).toBe(E404.body.error.request_id);
  });

  it("415 FILE_TYPE_UNSUPPORTED (captured) and 413 FILE_TOO_LARGE are RelayAPIErrors with the code", async () => {
    const { files } = filesWith(json(415, E415.body), relayError(413, "FILE_TOO_LARGE"));
    const a = await files.upload(PNG, { contentType: "image/png" }).catch((x) => x);
    expect(a).toBeInstanceOf(FileTypeUnsupportedError);
    expect(a).toBeInstanceOf(RelayAPIError);
    expect(a.status).toBe(415);
    const b = await files.upload(PNG).catch((x) => x);
    expect(b).toBeInstanceOf(FileTooLargeError);
    expect(b.code).toBe("FILE_TOO_LARGE");
  });

  it("429 FILE_QUOTA_EXCEEDED carries retryAfter; 402 is InsufficientCreditsError", async () => {
    const { files } = filesWith(relayError(429, "FILE_QUOTA_EXCEEDED", {}, { "retry-after": "3600" }), relayError(402, "INSUFFICIENT_CREDITS"));
    const a = await files.upload(PNG).catch((x) => x);
    expect(a).toBeInstanceOf(FileQuotaExceededError);
    expect(a).toBeInstanceOf(RateLimitError);
    expect(a.retryAfter).toBe(3600);
    const b = await files.upload(PNG, { retention: "relay1d" }).catch((x) => x);
    expect(b).toBeInstanceOf(InsufficientCreditsError);
  });
});

describe("files.prepareInputs (implicit upload)", () => {
  const uploaded = (n: number) => ({ ...UPLOAD.body, file_id: `file_${n}`, url: `https://cdn.relaygpu.com/content/u${n}` });
  let n = 0;
  const reply = () => created(uploaded(++n));

  it("uploads a Blob in video_url once and swaps in its link; the input is not mutated", async () => {
    const { files, calls } = filesWith(reply());
    const blob = new Blob([MP4], { type: "video/mp4" });
    const input = { prompt: "dance", video_url: blob };
    const out = await files.prepareInputs(input);
    expect(out).toEqual({ prompt: "dance", video_url: `https://cdn.relaygpu.com/content/u${n}` });
    expect(input.video_url).toBe(blob);
    expect(out).not.toBe(input);
    expect(calls).toHaveLength(1);
    expect(q(calls[0]).get("retention")).toBe("relay1h");
    expect(calls[0].body).toBe(blob);
  });

  it("the same Blob in two fields uploads once", async () => {
    const { files, calls } = filesWith(reply());
    const blob = new Blob([PNG], { type: "image/png" });
    const out = await files.prepareInputs({ image_url: blob, reference_image_url: blob });
    expect(calls).toHaveLength(1);
    expect(out.image_url).toBe(out.reference_image_url);
  });

  it("arrays in *_urls fields, nested objects, mixed strings", async () => {
    const { files, calls } = filesWith(reply(), reply(), reply());
    const a = new Blob([PNG], { type: "image/png" });
    const b = new Uint8Array(PNG);
    const input = {
      reference_image_urls: [a, "https://x.test/keep.png", b],
      settings: { deep: { audio_url: new Blob([MP4], { type: "audio/mp4" }) }, label: "x" },
      list: [{ first_frame_url: a }],
    };
    const out = (await files.prepareInputs(input)) as any;
    expect(calls).toHaveLength(3); // a, b, the audio — a reused in list[0]
    expect(out.reference_image_urls[1]).toBe("https://x.test/keep.png");
    expect(out.reference_image_urls[0]).toMatch(/^https:\/\/cdn\.relaygpu\.com\//);
    expect(out.reference_image_urls[2]).toMatch(/^https:\/\/cdn\.relaygpu\.com\//);
    expect(out.settings.deep.audio_url).toMatch(/^https:\/\/cdn\.relaygpu\.com\//);
    expect(out.settings.label).toBe("x");
    expect(out.list[0].first_frame_url).toBe(out.reference_image_urls[0]);
    expect(input.reference_image_urls[0]).toBe(a);
  });

  it("a pure-string body makes zero calls and returns an equal copy", async () => {
    const { files, calls } = filesWith();
    const input = { prompt: "x", video_url: "https://x.test/a.mp4", n: 2, nested: { image_url: "https://x.test/b.png" } };
    const out = await files.prepareInputs(input, { inlineImages: true });
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(calls).toHaveLength(0);
  });

  it("retention comes from opts.upload", async () => {
    const { files, calls } = filesWith(reply());
    await files.prepareInputs({ video_url: new Blob([MP4], { type: "video/mp4" }) }, { upload: { retention: "relay1d" } });
    expect(q(calls[0]).get("retention")).toBe("relay1d");
  });

  it("a File's name rides as filename; a ReadableStream is uploaded", async () => {
    const { files, calls } = filesWith(reply(), reply());
    await files.prepareInputs({ video_url: new File([MP4], "clip.mp4", { type: "video/mp4" }), audio_url: streamOf(MP4) });
    expect(q(calls[0]).get("filename")).toBe("clip.mp4");
    expect(calls[1].headers["content-type"]).toBe("video/mp4");
  });

  // Shapes as GET /v2/models/{model}.request_schema returns them (staging, 2026-10-06).
  const KLING_I2V = {
    type: "object",
    properties: {
      image: { type: "string", description: "Reference image URL or base64 encoded string" },
      image_tail: { anyOf: [{ type: "string" }, { type: "null" }], description: "Optional end-frame image (URL or base64). Used for start→end-frame interpolation." },
    },
  };
  const GEMINI = {
    type: "object",
    properties: {
      image: { anyOf: [{ type: "string" }, { type: "null" }], description: "Optional reference image for image-to-image editing. Accepts raw base64 or a data URI (data:image/png;base64,...)." },
      images: { anyOf: [{ items: { type: "string" }, type: "array" }, { type: "null" }], description: "Multiple reference images (1-14). Each item is raw base64 or a data URI." },
    },
  };
  const GPT_I2I = {
    type: "object",
    properties: {
      image: { type: "string", description: "Source image as base64 encoded string" },
      mask: { anyOf: [{ type: "string" }, { type: "null" }], description: "Mask image as base64 encoded string (optional)" },
    },
  };
  const SEEDANCE = {
    type: "object",
    properties: {
      first_frame_url: { anyOf: [{ type: "string" }, { type: "null" }], description: "URL or base64 data URI of the first frame image." },
      reference_video_url: { anyOf: [{ type: "string" }, { type: "null" }], description: "URL of a reference video (role=reference_video)." },
    },
  };
  const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

  it("inlineImages: an image ≤ 4 MB in a base64-capable field becomes base64, zero uploads", async () => {
    const { files, calls } = filesWith();
    const img = new Blob([PNG], { type: "image/png" });
    const k = await files.prepareInputs({ image: img, image_tail: PNG }, { inlineImages: true, requestSchema: KLING_I2V });
    expect(k).toEqual({ image: b64(PNG), image_tail: b64(PNG) }); // "base64 encoded string" → raw
    const g = await files.prepareInputs({ images: [img, PNG] }, { inlineImages: true, requestSchema: GEMINI });
    expect(g.images).toEqual([`data:image/png;base64,${b64(PNG)}`, `data:image/png;base64,${b64(PNG)}`]);
    const s = await files.prepareInputs({ first_frame_url: img }, { inlineImages: true, requestSchema: SEEDANCE });
    expect(s.first_frame_url).toBe(`data:image/png;base64,${b64(PNG)}`); // a *_url field takes a data URI
    expect(calls).toHaveLength(0);
  });

  it("inlineImages: > 4 MB, a stream, a non-image, or a URL-only field → upload", async () => {
    const { files, calls } = filesWith(reply(), reply(), reply(), reply());
    const big = new Uint8Array(4 * 1024 * 1024 + 1);
    big.set(PNG);
    const out = await files.prepareInputs(
      { first_frame_url: big, reference_video_url: new Blob([PNG], { type: "image/png" }) },
      { inlineImages: true, requestSchema: SEEDANCE },
    );
    expect(out.first_frame_url).toMatch(/^https:/);
    expect(out.reference_video_url).toMatch(/^https:/);
    await files.prepareInputs({ image: streamOf(PNG) }, { inlineImages: true, requestSchema: KLING_I2V });
    await files.prepareInputs({ first_frame_url: new Blob([MP4], { type: "video/mp4" }) }, { inlineImages: true, requestSchema: SEEDANCE });
    expect(calls).toHaveLength(4);
  });

  it("without inlineImages a URL-or-base64 field uploads", async () => {
    const { files, calls } = filesWith(reply());
    const out = await files.prepareInputs({ image: new Blob([PNG], { type: "image/png" }) }, { requestSchema: KLING_I2V });
    expect(out.image).toMatch(/^https:/);
    expect(calls).toHaveLength(1);
  });

  it("a base64-only field is always inlined (no URL is accepted there), streams included", async () => {
    const { files, calls } = filesWith();
    const out = await files.prepareInputs({ image: new Blob([PNG], { type: "image/png" }), mask: streamOf(PNG) }, { requestSchema: GPT_I2I });
    expect(out).toEqual({ image: b64(PNG), mask: b64(PNG) });
    expect(calls).toHaveLength(0);
  });

  it("a file in a field that takes neither a URL nor base64 is a TypeError, before any call", async () => {
    const { files, calls } = filesWith();
    await expect(files.prepareInputs({ prompt: new Blob([PNG], { type: "image/png" }) })).rejects.toThrow(/neither a URL nor base64/);
    await expect(files.prepareInputs({ image: PNG })).rejects.toThrow(/request schema/);
    expect(calls).toHaveLength(0);
  });
});
