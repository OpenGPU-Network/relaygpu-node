// A webhook receiver: verify the signature on the raw body, branch on the event, answer 2xx fast.
//   RELAY_WEBHOOK_SECRET=whsec_... npx tsx 04-webhook-receiver.ts      (listens on :8787)
//   npx tsx 04-webhook-receiver.ts --self-test                         (signs a delivery to itself, exits 0)
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Relay, WebhookVerificationError } from "@relaygpu/client";

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });
const selfTest = process.argv.includes("--self-test");
// The account's signing secret: relay.webhooks.secret() (JWT or superkey). During the 24 h after a
// rotation, pass [current, previous] instead.
const secret = selfTest ? "whsec_" + randomBytes(32).toString("base64") : process.env.RELAY_WEBHOOK_SECRET;
if (!secret) throw new Error("set RELAY_WEBHOOK_SECRET (or run with --self-test)");

async function rawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks); // verify the bytes as sent, never a re-serialised JSON.parse result
}

const server = createServer(async (req, res) => {
  try {
    const event = await relay.webhooks.verify(await rawBody(req), req.headers, secret);
    // Delivery is at-least-once: dedupe on req.headers["webhook-id"] in production.
    switch (event.event) {
      case "task.completed":
        console.log("task done:", event.task_id, event.result);
        break;
      case "task.failed":
        console.log("task failed:", event.task_id, event.error_code, event.error);
        break;
      case "workflow.completed":
      case "workflow.failed":
        // Run events: the top-level status is always "completed" (the envelope). The run's own
        // outcome is result.status: completed | failed | cancelled.
        console.log(`${event.event}:`, event.task_id, event.result?.status);
        break;
      default:
        console.log("other event:", event.event); // instance.*
    }
    res.writeHead(204).end();
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      console.warn("rejected delivery:", e.code);
      res.writeHead(400).end();
    } else {
      res.writeHead(500).end();
    }
  }
});

server.listen(selfTest ? 0 : Number(process.env.PORT ?? 8787), () => {
  const { port } = server.address() as AddressInfo;
  console.log(`listening on http://127.0.0.1:${port}`);
  if (selfTest) runSelfTest(port).then((ok) => server.close(() => process.exit(ok ? 0 : 1)));
});

// --self-test: sign deliveries the way Relay does (Standard Webhooks) and POST them to ourselves.
async function runSelfTest(port: number): Promise<boolean> {
  const post = async (payload: object, tamper = false) => {
    const body = JSON.stringify(payload);
    const id = `msg_${randomUUID()}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const key = Buffer.from(secret!.slice("whsec_".length), "base64");
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` },
      body: tamper ? body.replace("completed", "c0mpleted") : body,
    });
    return res.status;
  };
  const base = { created_at: new Date().toISOString(), elapsed_seconds: 42, mode: "direct" };
  const results = [
    (await post({ ...base, event: "task.completed", status: "completed", task_id: "direct:self-test", model: "Qwen/qwen-image", result: { urls: ["https://cdn.relaygpu.com/content/x"] } })) === 204,
    (await post({ ...base, event: "workflow.failed", status: "completed", task_id: "wf:self-test", mode: "workflows", model: "script-voiceover", result: { status: "cancelled" } })) === 204,
    (await post({ ...base, event: "task.completed", status: "completed", task_id: "direct:tampered" }, true)) === 400,
  ];
  console.log(results.every(Boolean) ? "self-test ok" : `self-test FAILED: ${JSON.stringify(results)}`);
  return results.every(Boolean);
}
