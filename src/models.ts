import type { Relay } from "./client.js";
import type { ModelDetail, ModelRow, OperationResponse, Schema } from "./types.js";

const MODEL_CACHE_MS = 5 * 60_000;

/** The per-mode, per-source catalog `GET /v2/models` answers. */
export type ModelCatalog = Schema<"ModelsResponse">;
export type PricingResponse = Schema<"PricingResponse">;
export type TiersResponse = Schema<"TiersResponse">;
export type HealthResponse = OperationResponse<"health_get", 200>;

/** A model name as a path: the `/` stays literal (the route is `{model:path}`), every other reserved character is encoded. */
export const modelPath = (name: string) => "/v2/models/" + name.split("/").map(encodeURIComponent).join("/");

/** The catalog (keyless). `get()` is the SDK's one resolver of route, `model_in_body`, `async_default` and schemas. */
export class Models {
  readonly #relay: Relay;
  readonly #cache = new Map<string, { expires: number; detail: Promise<ModelDetail> }>();

  constructor(relay: Relay) {
    this.#relay = relay;
  }

  /** `GET /v2/models` flattened: every model listed under `auto`, once, optionally filtered by `tag` (e.g. `text-to-video`). */
  async list(opts: { tag?: string; signal?: AbortSignal } = {}): Promise<ModelRow[]> {
    const { data } = await this.#relay._http.request<ModelCatalog>("GET", "/v2/models", { noAuth: true, signal: opts.signal });
    const seen = new Map<string, ModelRow>();
    for (const rows of Object.values(data.auto ?? {})) {
      for (const row of rows ?? []) if (!seen.has(row.name)) seen.set(row.name, row);
    }
    const all = [...seen.values()];
    return opts.tag ? all.filter((r) => r.tag === opts.tag) : all;
  }

  /**
   * `GET /v2/models/{name}` — route, request/response schema, example, pricing, status. Cached per client for 5 minutes.
   * An unknown name throws `ModelNotFoundError`; a retired model resolves with `status: "retired"`.
   */
  get(name: string): Promise<ModelDetail> {
    const now = Date.now();
    const hit = this.#cache.get(name);
    if (hit && hit.expires > now) return hit.detail;
    const detail = this.#relay._http.request<ModelDetail>("GET", modelPath(name), { noAuth: true }).then((r) => r.data);
    const entry = { expires: now + MODEL_CACHE_MS, detail };
    this.#cache.set(name, entry);
    detail.catch(() => {
      if (this.#cache.get(name) === entry) this.#cache.delete(name);
    });
    return detail;
  }
}

/** `GET /v2/pricing` — list prices per mode and model, plus the `media_storage` per-file fees. */
export class Pricing {
  readonly #relay: Relay;
  constructor(relay: Relay) {
    this.#relay = relay;
  }
  async get(opts: { signal?: AbortSignal } = {}): Promise<PricingResponse> {
    return (await this.#relay._http.request<PricingResponse>("GET", "/v2/pricing", { noAuth: true, signal: opts.signal })).data;
  }
}

/** `GET /v2/tiers`. */
export class Tiers {
  readonly #relay: Relay;
  constructor(relay: Relay) {
    this.#relay = relay;
  }
  async list(opts: { signal?: AbortSignal } = {}): Promise<TiersResponse> {
    return (await this.#relay._http.request<TiersResponse>("GET", "/v2/tiers", { noAuth: true, signal: opts.signal })).data;
  }
}

/** `GET /v2/health` — `{ status, version, commit }`. */
export async function health(relay: Relay): Promise<HealthResponse> {
  return (await relay._http.request<HealthResponse>("GET", "/v2/health", { noAuth: true })).data;
}
