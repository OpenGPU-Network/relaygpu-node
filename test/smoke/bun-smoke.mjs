// Runtime smoke for non-Node runtimes (Bun; Deno with --allow-read): the built ESM loads,
// the client constructs, errors map, and a webhook signature verifies with WebCrypto alone.
import Relay, { KeyBudgetExhaustedError, errorFromResponse } from "../../dist/index.js";

const relay = new Relay({ apiKey: "relay_sk_smoke", fetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) });
if (JSON.stringify(relay).includes("relay_sk_smoke")) throw new Error("key leaked into JSON");
const e = errorFromResponse(402, { detail: "x", error: { code: "KEY_BUDGET_EXHAUSTED", type: null, source: null, message: "x", request_id: "r" } }, new Headers());
if (!(e instanceof KeyBudgetExhaustedError)) throw new Error("error mapping broken");

const secret = "whsec_" + btoa("smoke-secret-0123456789");
const body = JSON.stringify({ event: "task.completed", task_id: "direct:1", status: "completed", elapsed_seconds: 1 });
const id = "msg_1", ts = String(Math.floor(Date.now() / 1000));
const subtle = (globalThis.crypto ?? (await import("node:crypto")).webcrypto).subtle;
const key = await subtle.importKey("raw", Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const sig = btoa(String.fromCharCode(...new Uint8Array(await subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)))));
const evt = await relay.webhooks.verify(body, { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` }, secret);
if (evt.event !== "task.completed") throw new Error("verify broken");
console.log("smoke ok");
