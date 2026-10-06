// @internal The one submit path under run() and the family helpers: resolve → refuse retired → build body →
// implicit uploads → POST (keyed when async).
import type { Relay } from "./client.js";
import { randomUUID } from "./util.js";
import { ModelRetiredError, RelayError } from "./errors.js";
import type { AsyncTaskAccepted, Mode, ModelDetail, ModelEndpoint } from "./types.js";

/** The `202` envelope of an async submit. `replayed` is true when the server replayed an earlier submit with the same `Idempotency-Key`. */
export type AsyncAccepted = AsyncTaskAccepted & { replayed: boolean; requestId: string | null };

/** A Blob, bytes or a stream placed in any `*_url` / `*_urls` field: uploaded first (`relay.files`), then replaced by its URL. */
export type Uploadable = Blob | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

export interface SubmitOptions {
  /** Routing mode; omitted → the server's default (`auto`). */
  mode?: Mode;
  /** `store_output`: `provider` (default) or a `relay1d|relay7d|relay30d` SKU from `/v2/pricing.media_storage`. */
  storeOutput?: string;
  /** `webhook_url`: receives `task.completed` / `task.failed` for an async task. */
  webhookUrl?: string;
  /** Idempotency key for an async submit. Default: a fresh UUID per call. Never sent on a sync call. */
  idempotencyKey?: string;
  /** Force async (`true`) or sync (`false`). Default: the input's `async`, else the route's `async_default`. */
  async?: boolean;
  /** Retention of implicit uploads. Default `relay1h` (free). */
  upload?: { retention?: string };
  /** Send image inputs as base64 data URIs instead of uploading them, where the route accepts it (4 MB cap). */
  inlineImages?: boolean;
  signal?: AbortSignal;
  /** Per-attempt HTTP timeout of a sync call. */
  timeoutMs?: number;
}

export type SubmitResult =
  | { kind: "sync"; data: Record<string, unknown>; requestId: string | null; detail: ModelDetail }
  | { kind: "async"; accepted: AsyncAccepted; detail: ModelDetail };

/** Refuses a retired model (or one with no single route) before anything is sent. */
export function resolveEndpoint(name: string, detail: ModelDetail): ModelEndpoint {
  if (detail.status === "retired") {
    throw new ModelRetiredError({ message: `Model '${name}' is retired and no longer served`, status: 403, code: "MODEL_RETIRED" });
  }
  if (!detail.endpoint) {
    throw new RelayError({ message: `Model '${name}' has no single route to submit to; call it with relay.request()` });
  }
  return detail.endpoint;
}

export async function submit(relay: Relay, model: string, input: Record<string, unknown>, opts: SubmitOptions = {}): Promise<SubmitResult> {
  const detail = await relay.models.get(model);
  const endpoint = resolveEndpoint(model, detail);

  let body: Record<string, unknown> = { ...input };
  if (endpoint.model_in_body) body.model = model;
  else delete body.model;
  if (opts.mode) body.mode = opts.mode;
  if (opts.storeOutput) body.store_output = opts.storeOutput;
  if (opts.webhookUrl) body.webhook_url = opts.webhookUrl;

  const isAsync = opts.async ?? (typeof input.async === "boolean" ? input.async : undefined) ?? endpoint.async_default;
  if (isAsync) body.async = true;
  else if (endpoint.async_default) body.async = false;
  else delete body.async;

  body = await relay.files.prepareInputs(body, {
    upload: opts.upload,
    inlineImages: opts.inlineImages,
    signal: opts.signal,
    requestSchema: detail.request_schema,
  });

  const res = await relay._http.request<Record<string, unknown>>(endpoint.method || "POST", endpoint.path, {
    body,
    signal: opts.signal,
    ...(isAsync ? { idempotencyKey: opts.idempotencyKey ?? (await randomUUID()) } : { timeoutMs: opts.timeoutMs }),
  });
  if (res.status === 202) {
    return { kind: "async", accepted: { ...(res.data as unknown as AsyncTaskAccepted), replayed: res.replayed, requestId: res.requestId }, detail };
  }
  return { kind: "sync", data: res.data, requestId: res.requestId, detail };
}
