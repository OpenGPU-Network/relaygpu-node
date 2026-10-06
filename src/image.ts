import type { Relay } from "./client.js";
import type { ModelOperations } from "./generated/models.js";
import { submit, type SubmitOptions, type Uploadable } from "./submit.js";
import type { TaskProgress } from "./tasks.js";
import type { OperationBody, OperationResponse, operations } from "./types.js";

type Widen<K, V> = K extends `${string}_url` ? V | Uploadable : K extends `${string}_urls` ? V | Uploadable[] : V;
type Optional<T> = { [K in keyof T]: null extends T[K] ? K : undefined extends T[K] ? K : never }[keyof T];

/**
 * A generated request body as callers write it: fields the server defaults (nullable in the spec — the generator marks
 * them required) become optional, and every `*_url` / `*_urls` field also takes a Blob/bytes/stream (uploaded first).
 */
export type WithUploads<T> = T extends object
  ? { [K in Exclude<keyof T, Optional<T>>]: Widen<K, T[K]> } & { [K in Optional<T>]?: Widen<K, T[K]> }
  : T;

/** The typed input of a known model (`model` is set by the SDK), or a free-form record for a model this SDK version does not list. */
export type HelperInput<Ops, M extends string> = M extends keyof Ops
  ? Ops[M] extends keyof operations
    ? WithUploads<Omit<OperationBody<Ops[M]>, "model">>
    : Record<string, unknown>
  : Record<string, unknown>;

/** The typed `200` body of a known model, or a free-form record. */
export type HelperOutput<Ops, M extends string> = M extends keyof Ops
  ? Ops[M] extends keyof operations
    ? OperationResponse<Ops[M], 200>
    : Record<string, unknown>
  : Record<string, unknown>;

type ImageOps = ModelOperations["Image"];
/** Known image model names, with autocomplete — any other string is accepted too. */
export type ImageModel = keyof ImageOps | (string & {});

export interface ImageOptions extends SubmitOptions {
  /** When the route answers async: status transitions while waiting. */
  onProgress?: (p: TaskProgress) => void;
  /** Wait budget when the route answers async (default 20 min); per-attempt HTTP timeout of a sync call. */
  timeoutMs?: number;
}

/** One output image, URL- or base64-backed. URLs expire (1 h by default; `store_output` buys 1/7/30 d). */
export interface RelayImage {
  url?: string;
  /** Raw base64 (no `data:` prefix). */
  b64?: string;
  mimeType?: string;
  /** Fetches (URL) or decodes (base64) the bytes. */
  toBlob(): Promise<Blob>;
  /** Writes the bytes to a file (Node, Bun, Deno). */
  save(path: string): Promise<void>;
}

export interface ImageResult<Raw = Record<string, unknown>> {
  images: RelayImage[];
  /** The response body (or the async task's `result`) exactly as the API sent it. */
  raw: Raw;
}

const MAGIC: [string, string][] = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["UklGR", "image/webp"],
  ["R0lGOD", "image/gif"],
];

function decodeB64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function writeFile(path: string, bytes: Uint8Array) {
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, bytes);
}

/** Builds a `RelayImage` from a URL, a data URI or a bare base64 string. */
export function toRelayImage(value: string, mimeHint?: string): RelayImage {
  const dataUri = /^data:([^;,]+)?(;base64)?,/i.exec(value);
  if (!dataUri && /^https?:\/\//i.test(value)) {
    const url = value;
    const toBlob = async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status} (result links expire; see store_output)`);
      return res.blob();
    };
    return { url, toBlob, save: async (path) => writeFile(path, new Uint8Array(await (await toBlob()).arrayBuffer())) };
  }
  const b64 = dataUri ? value.slice(dataUri[0].length) : value;
  const mimeType = dataUri?.[1] ?? MAGIC.find(([m]) => b64.startsWith(m))?.[1] ?? mimeHint;
  return {
    b64,
    mimeType,
    toBlob: async () => new Blob([decodeB64(b64)], mimeType ? { type: mimeType } : {}),
    save: (path) => writeFile(path, decodeB64(b64)),
  };
}

const FORMAT_MIME: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" };

/** Normalises every image response shape the live routes use: `urls[]`, `images[]` (base64 or links), OpenAI-style `data[]`, single `url`/`image`. */
export function normaliseImages(body: Record<string, unknown>, input: Record<string, unknown> = {}): RelayImage[] {
  const hint = typeof input.output_format === "string" ? FORMAT_MIME[input.output_format.toLowerCase()] : undefined;
  const out: RelayImage[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v) out.push(toRelayImage(v, hint));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      add(o.url ?? o.b64_json ?? o.b64 ?? o.base64);
    }
  };
  for (const key of ["urls", "images", "data"]) if (Array.isArray(body[key])) (body[key] as unknown[]).forEach(add);
  if (!out.length) for (const key of ["url", "image", "image_url", "b64_json"]) add(body[key]);
  return out;
}

/** Image generation and editing. Both methods take any image model; the route comes from `relay.models.get`. */
export class Images {
  readonly #relay: Relay;
  constructor(relay: Relay) {
    this.#relay = relay;
  }

  /**
   * Generates images. Returns `{ images, raw }` with every image normalised to a `RelayImage` (URL or base64).
   * If the route answers async (`async: true`), waits for the task like `run()` does.
   */
  async generate<M extends ImageModel>(model: M, input: HelperInput<ImageOps, M>, opts: ImageOptions = {}): Promise<ImageResult<HelperOutput<ImageOps, M>>> {
    const body = input as Record<string, unknown>;
    const res = await submit(this.#relay, model, body, opts);
    let raw: Record<string, unknown>;
    if (res.kind === "sync") raw = res.data;
    else {
      const task = await this.#relay.tasks.wait(res.accepted.task_id, { timeoutMs: opts.timeoutMs, onProgress: opts.onProgress, signal: opts.signal });
      raw = (task.result ?? {}) as Record<string, unknown>;
    }
    return { images: normaliseImages(raw, body), raw: raw as HelperOutput<ImageOps, M> };
  }

  /** Image-to-image editing (`image`/`images`/`*_url` inputs; Blobs are uploaded). Same contract as `generate`. */
  edit<M extends ImageModel>(model: M, input: HelperInput<ImageOps, M>, opts: ImageOptions = {}): Promise<ImageResult<HelperOutput<ImageOps, M>>> {
    return this.generate(model, input, opts);
  }
}
