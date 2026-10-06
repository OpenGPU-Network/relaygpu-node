import type { Relay } from "./client.js";
import { base64ToBytes, pathId, webCrypto } from "./util.js";
import { RelayError } from "./errors-base.js";
import type { OperationResponse, Schema, operations } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------------------------

/** `task.completed` / `task.failed`: the terminal task body plus `event`. */
export type TaskWebhookEvent = Schema<"WebhookPayload">;

/**
 * `workflow.completed` / `workflow.failed`: one per workflow run that was submitted with `webhookUrl`.
 *
 * - `result` is the run exactly as `GET /v2/workflows/runs/{run_id}` returns it (absent, with
 *   `result_omitted: true`, only past the 1 MiB inline cap).
 * - The top-level `status` is **always `"completed"`** (it says the delivery's envelope is complete,
 *   not the run). Branch on `event` or on `result.status`, never on `status`.
 * - A **cancelled** run arrives as `workflow.failed` with `result.status === "cancelled"`.
 * - `task_id` is the run id (`wf:…`).
 */
export type WorkflowWebhookEvent = Schema<"WorkflowRunWebhookPayload">;

export type InstanceEventName = "instance.ready" | "instance.failed" | "instance.terminated" | "instance.warning" | "instance.grace";

/**
 * `instance.*`: `result` is the instance as `GET /v2/instances/{instance_id}` returns it (plus `wallet`
 * on `instance.warning` / `instance.grace`). The top-level `status` is always `"completed"`; the
 * instance's own state is `result.status`. `task_id` is `{instance_id}:{event}`.
 */
export interface InstanceWebhookEvent {
  event: InstanceEventName;
  task_id: string;
  status: string;
  mode: string;
  model: string;
  created_at: string;
  elapsed_seconds: number;
  result?: { [key: string]: unknown } | null;
  result_omitted?: boolean | null;
  task_address?: string | null;
  [key: string]: unknown;
}

/** A verified delivery, discriminated on `event`. */
export type WebhookEvent = TaskWebhookEvent | WorkflowWebhookEvent | InstanceWebhookEvent;
export type WebhookEventName = WebhookEvent["event"];

export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export interface VerifyOptions {
  /** Accepted clock skew in seconds, both directions. Default 300 (5 min). */
  toleranceSeconds?: number;
  /** "Now" as a Unix epoch in **seconds** (for replaying captured deliveries in tests). Default: the clock. */
  now?: number;
}

/**
 * Client-side verification failure. `code` is one of `WEBHOOK_MISSING_HEADERS`,
 * `WEBHOOK_INVALID_TIMESTAMP`, `WEBHOOK_TIMESTAMP_OUT_OF_RANGE`, `WEBHOOK_INVALID_SECRET`,
 * `WEBHOOK_SIGNATURE_MISMATCH`, `WEBHOOK_INVALID_BODY`. Never carries the secret or the body.
 */
export class WebhookVerificationError extends RelayError {
  constructor(code: string, message: string) {
    super({ message, code });
  }
}

// ---------------------------------------------------------------------------------------------
// Verification (Standard Webhooks, WebCrypto only)
// ---------------------------------------------------------------------------------------------

const enc = new TextEncoder();

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() !== name || v == null) continue;
    return Array.isArray(v) ? v.join(" ") : v;
  }
  return undefined;
}

/** Constant-time for equal lengths (signature lengths are public). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verifies a Relay webhook delivery (Standard Webhooks) and returns the typed event.
 *
 * Pass the **raw** request body, byte-exact (not a re-serialised `JSON.parse` result), the request
 * headers (a `Headers`, or a Node `IncomingMessage.headers` record — lookup is case-insensitive) and
 * the account's signing secret (`whsec_…`, from `webhooks.secret()`). During the 24 h grace after a
 * rotation pass `[current, previous]`: a delivery is accepted when any `v1,` signature matches any
 * secret.
 *
 * Rejects (throws {@link WebhookVerificationError}) on missing headers, a timestamp outside
 * ±`toleranceSeconds` (default 300), no matching signature, or a body that is not a JSON event.
 * Dedupe on the `webhook-id` header: delivery is at-least-once.
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string | string[],
  opts: VerifyOptions = {},
): Promise<WebhookEvent> {
  const id = header(headers, "webhook-id");
  const ts = header(headers, "webhook-timestamp");
  const sig = header(headers, "webhook-signature");
  if (!id || !ts || !sig) throw new WebhookVerificationError("WEBHOOK_MISSING_HEADERS", "Missing webhook-id, webhook-timestamp or webhook-signature header");

  if (!/^\d+$/.test(ts.trim())) throw new WebhookVerificationError("WEBHOOK_INVALID_TIMESTAMP", "webhook-timestamp is not an integer epoch in seconds");
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > tolerance) {
    throw new WebhookVerificationError("WEBHOOK_TIMESTAMP_OUT_OF_RANGE", `webhook-timestamp is outside the ${tolerance} s tolerance`);
  }

  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === "string" && s !== "");
  if (secrets.length === 0) throw new WebhookVerificationError("WEBHOOK_INVALID_SECRET", "No signing secret given");
  const keys = secrets.map((s) => {
    const k = base64ToBytes(s.startsWith("whsec_") ? s.slice(6) : s);
    if (!k || k.length === 0) throw new WebhookVerificationError("WEBHOOK_INVALID_SECRET", "Signing secret is not a whsec_<base64> value");
    return k;
  });

  const bodyBytes = typeof rawBody === "string" ? enc.encode(rawBody) : rawBody;
  const prefix = enc.encode(`${id}.${ts}.`);
  const signed = new Uint8Array(prefix.length + bodyBytes.length);
  signed.set(prefix);
  signed.set(bodyBytes, prefix.length);

  const given = sig
    .split(/\s+/)
    .filter((t) => t.startsWith("v1,"))
    .map((t) => base64ToBytes(t.slice(3)))
    .filter((b): b is Uint8Array<ArrayBuffer> => b != null);

  const subtle = (await webCrypto()).subtle;
  let ok = false;
  for (const k of keys) {
    const key = await subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = new Uint8Array(await subtle.sign("HMAC", key, signed));
    for (const g of given) if (timingSafeEqual(expected, g)) ok = true;
  }
  if (!ok) throw new WebhookVerificationError("WEBHOOK_SIGNATURE_MISMATCH", "No webhook-signature matches the signing secret");

  let event: unknown;
  try {
    event = JSON.parse(typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody));
  } catch {
    throw new WebhookVerificationError("WEBHOOK_INVALID_BODY", "Webhook body is not JSON");
  }
  if (typeof event !== "object" || event === null || typeof (event as { event?: unknown }).event !== "string") {
    throw new WebhookVerificationError("WEBHOOK_INVALID_BODY", "Webhook body has no event");
  }
  return event as WebhookEvent;
}

// ---------------------------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------------------------

export type WebhookSecret = Schema<"WebhookSecretResponse">;
export type WebhookDeliveryPage = OperationResponse<"customer_webhook_deliveries_list">;
export type WebhookDeliveryDetail = OperationResponse<"customer_webhook_deliveries_get">;
export type WebhookDeliveryListParams = NonNullable<operations["customer_webhook_deliveries_list"]["parameters"]["query"]>;

class WebhookDeliveries {
  constructor(private readonly relay: Relay) {}

  /** `GET /v2/customer/webhook-deliveries`, newest first; pass `next_page` back as `page`. JWT or superkey. */
  async list(params: WebhookDeliveryListParams = {}): Promise<WebhookDeliveryPage> {
    return (await this.relay._http.request<WebhookDeliveryPage>("GET", "/v2/customer/webhook-deliveries", { query: params })).data;
  }

  /** `GET /v2/customer/webhook-deliveries/{id}`: the attempt timeline for a task id or a workflow run id (`wf:…`). */
  async get(taskIdOrRunId: string): Promise<WebhookDeliveryDetail> {
    return (await this.relay._http.request<WebhookDeliveryDetail>("GET", `/v2/customer/webhook-deliveries/${pathId(taskIdOrRunId)}`)).data;
  }
}

export class Webhooks {
  readonly deliveries: WebhookDeliveries;

  constructor(private readonly relay: Relay) {
    this.deliveries = new WebhookDeliveries(relay);
  }

  /** See {@link verifyWebhook}. Needs no credential and makes no request. */
  verify(rawBody: string | Uint8Array, headers: WebhookHeaders, secret: string | string[], opts?: VerifyOptions): Promise<WebhookEvent> {
    return verifyWebhook(rawBody, headers, secret, opts);
  }

  /** `GET /v2/customer/webhook-secret`: the account-level signing secret (`whsec_…`). JWT or superkey. */
  async secret(): Promise<WebhookSecret> {
    return (await this.relay._http.request<WebhookSecret>("GET", "/v2/customer/webhook-secret")).data;
  }

  /**
   * `POST /v2/customer/webhook-secret/rotate`: issues a new secret; the previous one keeps verifying
   * for 24 h (`previous_valid_until`), deliveries carry both signatures meanwhile. Only two secrets are
   * ever valid: rotating again inside the window retires the oldest at once. JWT or superkey.
   */
  async rotateSecret(): Promise<WebhookSecret> {
    return (await this.relay._http.request<WebhookSecret>("POST", "/v2/customer/webhook-secret/rotate")).data;
  }
}
