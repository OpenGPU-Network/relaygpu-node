import { pathId } from "./util.js";
import type { Relay } from "./client.js";
import type { FileObject, Schema } from "./types.js";
import {
  fileNameOf,
  isFileData,
  prepareInputs,
  resolveMediaType,
  unknownTypeError,
  type FileData,
  type PrepareInputsOptions,
} from "./inputs.js";

export type { FileData, PrepareInputsOptions } from "./inputs.js";
export { INLINE_IMAGE_MAX_BYTES } from "./inputs.js";

/**
 * How long the link lives. `relay1h` is free (daily quota); the others are the `media_storage`
 * SKUs in `GET /v2/pricing`. SKUs are data: any string the server offers is accepted.
 */
export type Retention = "relay1h" | "relay1d" | "relay7d" | "relay30d" | (string & {});

export type FileListResponse = Schema<"FileListResponse">;

export interface UploadOptions {
  /** Default `relay1h` (server-side). */
  retention?: Retention;
  /** Defaults to `File.name` when the data is a `File`. */
  filename?: string;
  /** Media type; defaults to `Blob.type`, else sniffed from the first bytes. */
  contentType?: string;
  /** Makes a retry safe: a replay answers the same `file_id` and is not charged again. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface CopyOptions {
  retention?: Retention;
  filename?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ListFilesOptions {
  source?: "upload" | "result";
  status?: "ready" | "expired";
  /** 1–200, default 50. */
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

const path = (id: string) => `/v2/files/${pathId(id)}`;

/** `POST|GET|DELETE /v2/files`: host an image, video or audio file and get a link any `*_url` field takes. */
export class Files {
  readonly #relay: Relay;

  constructor(relay: Relay) {
    this.#relay = relay;
  }

  /**
   * Uploads the raw bytes (streamed; a Blob is never read into memory, a ReadableStream passes
   * through and is sent once, never retried). Returns the hosted file (`url` is the link).
   */
  async upload(data: FileData, opts: UploadOptions = {}): Promise<FileObject> {
    if (!isFileData(data)) throw new TypeError("Relay: files.upload takes a Blob, Uint8Array, ArrayBuffer or ReadableStream");
    const { data: body, type } = await resolveMediaType(data, opts.contentType);
    if (!type) throw unknownTypeError("the upload");
    const res = await this.#relay._http.request<FileObject>("POST", "/v2/files", {
      rawBody: body,
      contentType: type,
      query: { retention: opts.retention, filename: opts.filename ?? fileNameOf(data) },
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
    return res.data;
  }

  /** Has Relay copy a public http(s) object (the JSON form; `retention`/`filename` ride in the body). */
  async copy(url: string, opts: CopyOptions = {}): Promise<FileObject> {
    const body: Record<string, string> = { url };
    if (opts.retention != null) body.retention = opts.retention;
    if (opts.filename != null) body.filename = opts.filename;
    const res = await this.#relay._http.request<FileObject>("POST", "/v2/files", {
      body,
      idempotencyKey: opts.idempotencyKey,
      signal: opts.signal,
    });
    return res.data;
  }

  /** One file. Unknown, foreign or long-expired ids throw `FileNotFoundError`. */
  async get(id: string, opts: { signal?: AbortSignal } = {}): Promise<FileObject> {
    return (await this.#relay._http.request<FileObject>("GET", path(id), { signal: opts.signal })).data;
  }

  /** One page, newest first: uploads and hosted results. Follow `next_cursor` (null on the last page). */
  async list(opts: ListFilesOptions = {}): Promise<FileListResponse> {
    const { signal, ...query } = opts;
    return (await this.#relay._http.request<FileListResponse>("GET", "/v2/files", { query: { ...query }, signal })).data;
  }

  /** Every file across pages, following `next_cursor`. */
  async *listAll(opts: ListFilesOptions = {}): AsyncGenerator<FileObject, void, undefined> {
    let cursor = opts.cursor;
    for (;;) {
      const page = await this.list({ ...opts, cursor });
      yield* page.files;
      if (!page.next_cursor || page.files.length === 0 || page.next_cursor === cursor) return;
      cursor = page.next_cursor;
    }
  }

  /** Takes the link down now (idempotent; no refund). */
  async delete(id: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await this.#relay._http.request("DELETE", path(id), { signal: opts.signal });
  }

  /**
   * The implicit upload: a copy of `input` with every file in a `*_url` / `*_urls` field (nested too)
   * uploaded and replaced by its link, or — per the route's request schema — inlined as base64.
   * See `prepareInputs` in `inputs.ts` for the rule. Zero calls when the body holds no file.
   */
  prepareInputs<T extends Record<string, unknown>>(input: T, opts: PrepareInputsOptions = {}): Promise<T> {
    return prepareInputs(input, opts, async (data, o) => (await this.upload(data, o)).url);
  }
}
