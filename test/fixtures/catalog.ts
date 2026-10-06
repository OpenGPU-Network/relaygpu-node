// Loaders for the staging captures of 2026-10-06 (free catalog reads + three billed calls). No credentials inside.
import { readFileSync } from "node:fs";
import { Relay } from "../../src/client.js";
import { json } from "../unit/helpers.js";

export const load = (file: string) => JSON.parse(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));

/** `GET /v2/models/{name}` answers captured on staging, by model name (incl. a 404 for `nope/nope`). */
export const DETAILS: Record<string, { status: number; body: any }> = load("model-details_20261006.json");
export const PRICING = load("pricing_20261006.json");
export const MODELS = load("models_20261006.json");
export const IMAGE_QWEN = load("image_qwen-image_20261006.json");
export const TTS_QWEN = load("audio_qwen3-tts-flash_20261006.json");
export const VIDEO_KLING = load("video_kling-v3-t2v_20261006.json");

/** The captured `GET /v2/models/{name}` reply as a Response. */
export const detail = (name: string) => {
  const d = DETAILS[name];
  if (!d) throw new Error(`no captured detail for ${name}`);
  return json(d.status, d.body);
};

/** A detail with its endpoint overridden (e.g. an image route forced to answer async). */
export const detailWith = (name: string, endpoint: Record<string, unknown>) =>
  json(200, { ...DETAILS[name].body, endpoint: { ...DETAILS[name].body.endpoint, ...endpoint } });

export const KEY = "relay_sk_unit_secret_never_logged";
export const relayWith = (f: typeof fetch) => new Relay({ apiKey: KEY, baseUrl: "http://relay.test", fetch: f, retry: { maxRetryAfterMs: 60_000 } });

export const task = (status: string, extra: Record<string, unknown> = {}) =>
  json(200, { task_id: "direct:t1", status, elapsed_seconds: 1, ...extra });
