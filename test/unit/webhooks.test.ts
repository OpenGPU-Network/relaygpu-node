import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { Relay } from "../../src/client.js";
import { PermissionDeniedError } from "../../src/errors.js";
import { HttpClient } from "../../src/http.js";
import { WebhookVerificationError, Webhooks, verifyWebhook, type WebhookEvent } from "../../src/webhooks.js";
import { json, mockFetch, relayError } from "./helpers.js";

const newSecret = () => `whsec_${randomBytes(24).toString("base64")}`;
const SECRET = newSecret();
const PREVIOUS = newSecret();

function sign(secret: string, id: string, ts: number, body: string) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

const NOW = 1_791_000_000;
const runBody = JSON.stringify({
  event: "workflow.failed",
  task_id: "wf:7c9e6679-7425-40de-944b-e07fc1f90ae7",
  status: "completed",
  elapsed_seconds: 14,
  created_at: "2026-10-06T10:00:00Z",
  mode: "workflows",
  model: "script-voiceover",
  task_address: null,
  result: { run_id: "wf:7c9e6679-7425-40de-944b-e07fc1f90ae7", workflow_id: "script-voiceover", version: 2, status: "cancelled", inputs: {}, steps: [] },
});

function delivery(body = runBody, opts: { secrets?: string[]; ts?: number; id?: string } = {}) {
  const id = opts.id ?? "msg_2abc";
  const ts = opts.ts ?? NOW;
  const signature = (opts.secrets ?? [SECRET]).map((s) => sign(s, id, ts, body)).join(" ");
  return { body, headers: { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": signature } };
}

const reject = async (p: Promise<unknown>, code: string) => {
  const e = (await p.catch((e) => e)) as WebhookVerificationError;
  expect(e).toBeInstanceOf(WebhookVerificationError);
  expect(e.code).toBe(code);
  expect(e.message + JSON.stringify(e)).not.toContain(SECRET);
};

describe("webhooks.verify (Standard Webhooks)", () => {
  it("accepts a correctly signed delivery and returns the event", async () => {
    const d = delivery();
    const e = await verifyWebhook(d.body, d.headers, SECRET, { now: NOW });
    expect(e.event).toBe("workflow.failed");
    expect(e.task_id).toMatch(/^wf:/);
  });

  it("accepts a Uint8Array body byte-exact (non-ASCII included)", async () => {
    const body = JSON.stringify({ event: "task.completed", task_id: "direct:1", status: "completed", elapsed_seconds: 1, result: { text: "çağrı ✓" } });
    const d = delivery(body);
    const e = await verifyWebhook(new TextEncoder().encode(body), d.headers, SECRET, { now: NOW });
    expect(e.event).toBe("task.completed");
  });

  it("rejects a tampered body", async () => {
    const d = delivery();
    await reject(verifyWebhook(d.body.replace("cancelled", "completed"), d.headers, SECRET, { now: NOW }), "WEBHOOK_SIGNATURE_MISMATCH");
  });

  it("rejects a timestamp 10 minutes old and 10 minutes in the future; honours toleranceSeconds", async () => {
    const d = delivery();
    await reject(verifyWebhook(d.body, d.headers, SECRET, { now: NOW + 600 }), "WEBHOOK_TIMESTAMP_OUT_OF_RANGE");
    await reject(verifyWebhook(d.body, d.headers, SECRET, { now: NOW - 600 }), "WEBHOOK_TIMESTAMP_OUT_OF_RANGE");
    await expect(verifyWebhook(d.body, d.headers, SECRET, { now: NOW + 299 })).resolves.toBeTruthy();
    await expect(verifyWebhook(d.body, d.headers, SECRET, { now: NOW + 600, toleranceSeconds: 900 })).resolves.toBeTruthy();
  });

  it("uses the clock by default", async () => {
    const d = delivery(runBody, { ts: Math.floor(Date.now() / 1000) - 600 });
    await reject(verifyWebhook(d.body, d.headers, SECRET), "WEBHOOK_TIMESTAMP_OUT_OF_RANGE");
    const fresh = delivery(runBody, { ts: Math.floor(Date.now() / 1000) });
    await expect(verifyWebhook(fresh.body, fresh.headers, SECRET)).resolves.toBeTruthy();
  });

  it("rotation window: two tokens (previous + current) verify with the previous alone and with [current, previous]", async () => {
    const d = delivery(runBody, { secrets: [PREVIOUS, SECRET] });
    expect(d.headers["webhook-signature"].split(" ")).toHaveLength(2);
    await expect(verifyWebhook(d.body, d.headers, PREVIOUS, { now: NOW })).resolves.toBeTruthy();
    await expect(verifyWebhook(d.body, d.headers, [SECRET, PREVIOUS], { now: NOW })).resolves.toBeTruthy();
    await expect(verifyWebhook(d.body, d.headers, SECRET, { now: NOW })).resolves.toBeTruthy();
    // after the grace: only the new signature, the previous secret alone no longer matches
    const after = delivery(runBody, { secrets: [SECRET] });
    await reject(verifyWebhook(after.body, after.headers, PREVIOUS, { now: NOW }), "WEBHOOK_SIGNATURE_MISMATCH");
    await expect(verifyWebhook(after.body, after.headers, [SECRET, PREVIOUS], { now: NOW })).resolves.toBeTruthy();
  });

  it("rejects a wrong secret, a malformed secret and no secret", async () => {
    const d = delivery();
    await reject(verifyWebhook(d.body, d.headers, newSecret(), { now: NOW }), "WEBHOOK_SIGNATURE_MISMATCH");
    await reject(verifyWebhook(d.body, d.headers, "whsec_!!!not-base64", { now: NOW }), "WEBHOOK_INVALID_SECRET");
    await reject(verifyWebhook(d.body, d.headers, [], { now: NOW }), "WEBHOOK_INVALID_SECRET");
  });

  it("ignores non-v1 tokens and garbage tokens", async () => {
    const d = delivery();
    const headers = { ...d.headers, "webhook-signature": `v2,abc v1,%%% ${d.headers["webhook-signature"]}` };
    await expect(verifyWebhook(d.body, headers, SECRET, { now: NOW })).resolves.toBeTruthy();
    await reject(verifyWebhook(d.body, { ...d.headers, "webhook-signature": "v2,abc" }, SECRET, { now: NOW }), "WEBHOOK_SIGNATURE_MISMATCH");
  });

  it("rejects missing headers and a non-integer timestamp", async () => {
    const d = delivery();
    for (const h of ["webhook-id", "webhook-timestamp", "webhook-signature"]) {
      const headers: Record<string, string> = { ...d.headers };
      delete headers[h];
      await reject(verifyWebhook(d.body, headers, SECRET, { now: NOW }), "WEBHOOK_MISSING_HEADERS");
    }
    await reject(verifyWebhook(d.body, { ...d.headers, "webhook-timestamp": "1791000000.5" }, SECRET, { now: NOW }), "WEBHOOK_INVALID_TIMESTAMP");
  });

  it("rejects a signed body that is not a JSON event", async () => {
    const d = delivery("not json");
    await reject(verifyWebhook(d.body, d.headers, SECRET, { now: NOW }), "WEBHOOK_INVALID_BODY");
    const n = delivery("[1,2]");
    await reject(verifyWebhook(n.body, n.headers, SECRET, { now: NOW }), "WEBHOOK_INVALID_BODY");
  });

  it("header lookup: Node-style lowercase record, mixed-case record, string[] values and a Headers instance", async () => {
    const d = delivery();
    await expect(verifyWebhook(d.body, d.headers, SECRET, { now: NOW })).resolves.toBeTruthy();
    const mixed = { "Webhook-Id": d.headers["webhook-id"], "WEBHOOK-TIMESTAMP": d.headers["webhook-timestamp"], "Webhook-Signature": [d.headers["webhook-signature"]] };
    await expect(verifyWebhook(d.body, mixed, SECRET, { now: NOW })).resolves.toBeTruthy();
    await expect(verifyWebhook(d.body, new Headers(d.headers), SECRET, { now: NOW })).resolves.toBeTruthy();
  });

  it("narrows on event (type-level)", async () => {
    const d = delivery();
    const e: WebhookEvent = await verifyWebhook(d.body, d.headers, SECRET, { now: NOW });
    if (e.event === "workflow.completed" || e.event === "workflow.failed") {
      expectTypeOf(e.mode).toEqualTypeOf<"workflows">();
      expectTypeOf(e.status).toEqualTypeOf<"completed">();
      expectTypeOf(e.result!.status).toEqualTypeOf<"queued" | "running" | "completed" | "failed" | "cancelled">();
      expect(e.result?.status).toBe("cancelled");
    } else if (e.event === "task.completed" || e.event === "task.failed") {
      expectTypeOf(e.error_code).toEqualTypeOf<string | null | undefined>();
      throw new Error("unreachable");
    } else {
      expectTypeOf(e.event).toEqualTypeOf<"instance.ready" | "instance.failed" | "instance.terminated" | "instance.warning" | "instance.grace">();
      throw new Error("unreachable");
    }
  });

  it("Webhooks#verify delegates without a request", async () => {
    const m = mockFetch();
    const wh = new Webhooks({ _http: new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://relay.test", fetch: m.fetch }) } as unknown as Relay);
    const d = delivery();
    await expect(wh.verify(d.body, d.headers, SECRET, { now: NOW })).resolves.toMatchObject({ event: "workflow.failed" });
    expect(m.calls).toHaveLength(0);
  });
});

describe("webhooks namespace routes", () => {
  const make = (...replies: Parameters<typeof mockFetch>) => {
    const m = mockFetch(...replies);
    const wh = new Webhooks({ _http: new HttpClient({ apiKey: "relay_sk_x", baseUrl: "http://relay.test", fetch: m.fetch, retry: false }) } as unknown as Relay);
    return { m, wh };
  };

  it("secret() and rotateSecret()", async () => {
    const s = { secret: "whsec_AAAA", created_at: "2026-10-06T00:00:00Z", previous_valid_until: null };
    const { m, wh } = make(json(200, s), json(200, { ...s, previous_valid_until: "2026-10-07T00:00:00Z" }));
    expect(await wh.secret()).toEqual(s);
    expect((await wh.rotateSecret()).previous_valid_until).toBe("2026-10-07T00:00:00Z");
    expect(m.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /v2/customer/webhook-secret", "POST /v2/customer/webhook-secret/rotate"]);
  });

  it("deliveries.list encodes filters; deliveries.get keeps the run id raw in the path", async () => {
    const { m, wh } = make(json(200, { object: "page", data: [], has_more: false, next_page: null }), json(200, { task_id: "wf:abc" }));
    await wh.deliveries.list({ event: "workflow.completed", outcome: "gave_up", task_id: "wf:abc", limit: 5, page: "cur" });
    const u = new URL(m.calls[0].url);
    expect(u.pathname).toBe("/v2/customer/webhook-deliveries");
    expect(Object.fromEntries(u.searchParams)).toEqual({ event: "workflow.completed", outcome: "gave_up", task_id: "wf:abc", limit: "5", page: "cur" });
    await wh.deliveries.get("wf:7c9e6679-7425");
    expect(m.calls[1].url).toBe("http://relay.test/v2/customer/webhook-deliveries/wf:7c9e6679-7425");
  });

  it("an inference key gets the server's 403 as PermissionDeniedError", async () => {
    const { wh } = make(relayError(403, null));
    await expect(wh.secret()).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
