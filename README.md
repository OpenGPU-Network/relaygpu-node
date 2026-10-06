# @relaygpu/client

> **Status: pre-release (v0.1), not yet published to npm.** The API may change before 1.0.

The TypeScript client for [Relay](https://relaygpu.com): image, video and audio generation, async tasks,
file uploads, webhook verification, workflows, account and keys, with typed errors. Request and response
types are generated from Relay's public OpenAPI spec. Chat is not wrapped: point the OpenAI or Anthropic
SDK at Relay ([quickstart 6](#6-chat-use-the-sdk-you-already-have)).

```bash
npm install @relaygpu/client
```

Node ≥ 18, Bun, Deno and Cloudflare Workers. No runtime dependencies (only `fetch` and WebCrypto).

## The client

```ts
import { Relay } from "@relaygpu/client";

const relay = new Relay({
  apiKey: process.env.RELAY_API_KEY, // relay_sk_…, sent as X-API-Key. Or { jwt } for a dashboard login token.
  baseUrl: "https://relaygpu.com",   // the default
  timeoutMs: 600_000,                // per HTTP attempt (default 10 min)
  retry: { maxRetries: 2, maxRateLimitRetries: 3, maxRetryAfterMs: 60_000 }, // the defaults; `false` disables retries
});
```

The key never appears in an error, a log line or `JSON.stringify(relay)`. Catalog reads (`models`,
`pricing`, `tiers`, `health`) and task polls need no credential.

## Quickstarts

Each one is a runnable file in [`examples/`](examples/) (how to run them: [examples/README.md](examples/README.md)).
They read `RELAY_API_KEY`, and `RELAY_BASE_URL` when set.


### 1. Image

Generate an image with `Qwen/qwen-image`, print its link and save it. ([`examples/01-image.ts`](examples/01-image.ts))

```ts
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay, ContentPolicyDeclinedError, InsufficientCreditsError } from "@relaygpu/client";

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });

try {
  const { images } = await relay.image.generate("Qwen/qwen-image", {
    prompt: process.argv[2] ?? "A red fox in an autumn forest",
    size: "1024x1024",
  });
  const image = images[0];
  console.log("url:", image.url); // a link that lives 1 h; pass { storeOutput: "relay7d" } to keep it longer

  const blob = await image.toBlob();
  const file = join(tmpdir(), `relay-image.${blob.type.split("/")[1] || "bin"}`);
  await writeFile(file, new Uint8Array(await blob.arrayBuffer()));
  console.log("saved:", file);
} catch (e) {
  // Status picks the class, error.code refines it: KeyBudgetExhaustedError is an InsufficientCreditsError (402).
  if (e instanceof InsufficientCreditsError) console.error(`out of credit (${e.code}), request ${e.requestId}`);
  else if (e instanceof ContentPolicyDeclinedError) console.error("the provider declined this prompt:", e.message);
  else throw e;
  process.exitCode = 1;
}
```

### 2. Video, waiting for the result

Kling v3 text-to-video, 3 seconds, standard quality. `wait: true` long-polls the task until it ends. ([`examples/02-video-wait.ts`](examples/02-video-wait.ts))

```ts
import { Relay, TaskFailedError } from "@relaygpu/client";

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });

try {
  const task = await relay.video.generate(
    "KlingTeam/v3-T2V",
    { prompt: process.argv[2] ?? "A paper boat drifting down a rain gutter", duration: 3, quality_mode: "std" },
    {
      wait: true,
      // Status transitions and elapsed time only: there is no queue position, log stream or cancel.
      onProgress: (p) => console.log(`${p.status} after ${p.elapsed_seconds}s`),
    },
  );
  const urls = task.result?.urls as string[] | undefined;
  console.log("video:", urls?.[0]); // expires 1 h after completion unless you pass storeOutput
} catch (e) {
  // The task ran and failed: e.code is the task's error_code (e.g. CONTENT_POLICY_DECLINED, UPSTREAM_TIMEOUT).
  if (e instanceof TaskFailedError) console.error(`task ${e.taskId} failed: ${e.code ?? "unclassified"}: ${e.message}`);
  else throw e;
  process.exitCode = 1;
}
```

### 3. Upload a file, then motion control

Both ways to send a local file: upload it explicitly (`files.upload`, here with 1-day retention), or put the `Blob` straight into a `*_url` field and let the SDK upload it. The submit returns the `202` without waiting. Arguments: a local video, then a character image URL. ([`examples/03-upload-motion-control.ts`](examples/03-upload-motion-control.ts))

```ts
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Relay, FileTooLargeError, ValidationError } from "@relaygpu/client";

const [videoPath, imageUrl] = process.argv.slice(2);
if (!videoPath || !imageUrl) {
  console.error("usage: npx tsx 03-upload-motion-control.ts <local video.mp4> <character image URL>");
  process.exit(2);
}

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });
const video = new Blob([new Uint8Array(await readFile(videoPath))]); // media type sniffed from the bytes

try {
  // Form 1, explicit: host the file yourself and get a link any *_url field takes.
  // relay1h is free; relay1d / relay7d / relay30d are billed per file (GET /v2/pricing → media_storage).
  const file = await relay.files.upload(video, { retention: "relay1d", filename: basename(videoPath) });
  console.log("uploaded:", file.file_id, file.url, "expires", file.expires_at);

  // Form 2, implicit: put the Blob straight into a *_url field; the SDK uploads it first (relay1h unless
  // opts.upload.retention says otherwise) and sends the link. `video_url: file.url` would work the same.
  const accepted = await relay.video.generate("KlingTeam/v3-Motion-Control", {
    video_url: video,
    image_url: imageUrl,
    character_orientation: "video", // "image" | "video": which input decides the facing direction
    duration: 5,
    quality_mode: "std",
  });
  // No wait: the 202 envelope. Poll later with relay.tasks.wait(accepted.task_id), or pass webhookUrl.
  console.log("task:", accepted.task_id, accepted.replayed ? "(replayed)" : "");

  // Take the explicit upload down now (idempotent; the fee is not refunded).
  await relay.files.delete(file.file_id);
  console.log("deleted:", file.file_id);
} catch (e) {
  if (e instanceof FileTooLargeError) console.error("files are capped at 100 MB");
  else if (e instanceof ValidationError) console.error(`rejected (${e.code}):`, e.message);
  else throw e;
  process.exitCode = 1;
}
```

### 4. Webhook receiver

Verify each delivery on its raw body and branch on `event`. The example file adds `--self-test`, which signs a delivery with a throwaway secret and posts it to itself, so it runs without a tunnel. ([`examples/04-webhook-receiver.ts`](examples/04-webhook-receiver.ts))

```ts
import { createServer, type IncomingMessage } from "node:http";
import { Relay, WebhookVerificationError } from "@relaygpu/client";

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });
// The account's signing secret: relay.webhooks.secret() (JWT or superkey). During the 24 h after a
// rotation, pass [current, previous] instead.
const secret = process.env.RELAY_WEBHOOK_SECRET;
if (!secret) throw new Error("set RELAY_WEBHOOK_SECRET");

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

server.listen(8787);
```

### 5. Workflow run

`script-voiceover`: an LLM writes a short line from your brief, a TTS model speaks it. Each step is billed as an ordinary request. ([`examples/05-workflow-run.ts`](examples/05-workflow-run.ts))

```ts
import { Relay, TaskFailedError } from "@relaygpu/client";

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });

try {
  // Inputs follow the template's input_schema: relay.workflows.get("script-voiceover").
  // Each step is billed as an ordinary request. Pass webhookUrl for one signed workflow.* delivery instead of waiting.
  const run = await relay.workflows.run(
    "script-voiceover",
    { messages: [{ role: "user", content: process.argv[2] ?? "a lighthouse at dusk" }], voice: "Cherry" },
    { wait: true, onProgress: (r) => console.log(r.status) },
  );
  console.log("run:", run.run_id, run.status);
  console.log("output:", JSON.stringify(run.output, null, 2)); // the last step's output (the speech)
} catch (e) {
  // A failed or cancelled run throws; e.task is the run as polled.
  if (e instanceof TaskFailedError) console.error(`run ${e.taskId} did not complete: ${e.message}`);
  else throw e;
  process.exitCode = 1;
}
```

### 6. Chat: use the SDK you already have

Chat and completions run on the official OpenAI and Anthropic SDKs: point them at Relay. This SDK does not wrap chat. ([`examples/06-chat-base-url.ts`](examples/06-chat-base-url.ts))

```ts
import OpenAI from "openai";

const base = process.env.RELAY_BASE_URL ?? "https://relaygpu.com";
const openai = new OpenAI({ apiKey: process.env.RELAY_API_KEY, baseURL: `${base}/v2/openai/v1` });

const completion = await openai.chat.completions.create({
  model: "openai/gpt-4o-mini",
  messages: [{ role: "user", content: "Say hello in five words." }],
  max_tokens: 20,
});
console.log(completion.choices[0].message.content);
```

## Any model: `run()` and model resolution

```ts
import { Relay, isAccepted } from "@relaygpu/client";

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY, baseUrl: process.env.RELAY_BASE_URL });

const out = await relay.run("Qwen/qwen-image", { prompt: "a lighthouse at dusk" }); // the output body
const sub = await relay.run("KlingTeam/v3-T2V", { prompt: "waves", duration: 3 }, { wait: false });
if (isAccepted(sub)) console.log(sub.task_id); // the 202 envelope
```

The SDK ships no model table. Every call resolves the model through `relay.models.get(name)`
(`GET /v2/models/{name}`, cached 5 min per client): its route, whether `model` goes in the body, whether
the route is async by default, and its request/response schemas. A model added to Relay after this
release works through `run()` and the family helpers (`image`, `video`, `audio`) without an upgrade; the
models this release knows also get typed inputs and autocomplete.

- An unknown name throws `ModelNotFoundError` (404); a retired one throws `ModelRetiredError` (403). Both
  before anything is submitted or billed.
- `relay.models.list({ tag: "text-to-video" })` lists the catalog; `relay.models.get(name)` returns one
  model with its `request_schema`, `request_example` and `pricing`.
- `run()` returns a sync route's body, or waits for an async route and returns the task's `result`.
  `{ wait: false }` returns the `202` envelope instead.

## Async tasks and `tasks.wait`

Video (and any call with `async: true`) answers `202` with a `task_id`. `relay.video.generate` returns that
envelope unless you pass `{ wait: true }`; `run()` and the image/audio helpers wait by default.

```ts
const task = await relay.tasks.wait(taskId, {
  timeoutMs: 20 * 60_000,                       // the default; the task keeps running past it (APITimeoutError)
  onProgress: (p) => console.log(p.status, p.elapsed_seconds),
  signal: AbortSignal.timeout(30 * 60_000),
});
```

`tasks.wait` long-polls `GET /v2/tasks/{id}?wait=30`: a 15 s task costs one or two requests, not a poll
every second. `onProgress` fires on status transitions (`queued` → `running` → `completed`) with
`elapsed_seconds`, and that is all there is: no queue position, no logs and no cancel, by design. A failed
task throws `TaskFailedError` with `code` = the task's `error_code`. Task polls need no key: the task id is
the access token. A task's result expires 1 hour after it finishes.

Workflow runs have no long-poll: `workflows.waitRun` polls the run every 1 s, backing off to 5 s (default
budget 30 min).

## Idempotency and retries

Every async submit (`202` routes, `video.generate`, `run()` on an async route) and every workflow run is
sent with an `Idempotency-Key`: yours (`{ idempotencyKey }`) or a generated UUID. That makes the submit
safe to retry, so the SDK retries it on a network error, a timeout or a 5xx (up to 2 times, same key).
When the server recognises a key it has already accepted, it answers with the original `202` and the SDK
returns it with `replayed: true`: no second task, no second charge. The same key with a different body
throws `IdempotencyKeyReusedError` (422). Keys live 24 hours.

```ts
const a = await relay.video.generate("KlingTeam/v3-T2V", { prompt: "waves", duration: 3 }, { idempotencyKey: "order-1234" });
const b = await relay.video.generate("KlingTeam/v3-T2V", { prompt: "waves", duration: 3 }, { idempotencyKey: "order-1234" });
// b.task_id === a.task_id, b.replayed === true
```

Sync calls (an image route answering `200`, chat, TTS) carry no key and are **never retried**: a retry
would run, and bill, the request again. GETs retry on 429/503 (honouring `Retry-After`, up to 3 times) and
on other 5xx (up to 2). `retry: false` turns every retry off.

## Files and implicit uploads

```ts
const file = await relay.files.upload(blob, { retention: "relay1d", filename: "dance.mp4" }); // { file_id, url, expires_at, … }
await relay.files.copy("https://example.com/clip.mp4", { retention: "relay7d" }); // Relay fetches it
await relay.files.get(file.file_id);
await relay.files.list({ source: "upload" });
await relay.files.delete(file.file_id); // the link goes down now; no refund
```

- Any `*_url` / `*_urls` input also takes a `Blob`, `Uint8Array`, `ArrayBuffer` or `ReadableStream`: the SDK
  uploads it first and sends the link (quickstart 3). Implicit uploads use `relay1h` unless you pass
  `{ upload: { retention: "relay1d" } }`.
- `{ inlineImages: true }` sends images of 4 MB or less as base64 instead, on routes whose schema takes it;
  larger ones are still uploaded.
- One file is at most 100 MB (`FileTooLargeError`). The media type comes from `Blob.type`, else from the
  file's first bytes.
- `relay1h` is free within a daily quota; `relay1d`, `relay7d` and `relay30d` are billed per file at upload.

## How long result links live

Result links (`urls`, `audio_url`, …) and uploaded files expire. By default a result link lives **1 hour**
after the task finishes. To keep outputs longer, buy storage per request with `storeOutput`:

```ts
await relay.image.generate("Qwen/qwen-image", { prompt: "a lighthouse" }, { storeOutput: "relay7d" });
```

| `storeOutput` / `retention` | Lifetime | Fee |
|---|---|---|
| `provider` (default) / `relay1h` | 1 hour | free |
| `relay1d` | 1 day | per file |
| `relay7d` | 7 days | per file |
| `relay30d` | 30 days | per file |

The fees are in `(await relay.pricing.get()).media_storage`; read them there rather than hard-coding them.

## Webhooks

Pass `webhookUrl` on an async submit (one `task.completed` or `task.failed`) or on a workflow run (one
`workflow.completed` or `workflow.failed`). Deliveries are signed with
[Standard Webhooks](https://www.standardwebhooks.com/); `relay.webhooks.verify(rawBody, headers, secret)`
checks the signature and the timestamp (±5 min) and returns the typed event, discriminated on `event`
(quickstart 4). It makes no request and needs no credential.

- Verify the **raw** body bytes, not a re-serialised `JSON.parse` result.
- Rotation: `relay.webhooks.rotateSecret()` issues a new secret and the previous one keeps working for
  24 hours. During that window pass both: `verify(raw, headers, [current, previous])`.
- On `workflow.*` events the top-level `status` is always `"completed"` (it describes the delivery). Branch
  on `event`, or on `result.status` (`completed`, `failed`, `cancelled`; a cancelled run arrives as
  `workflow.failed`).
- Delivery is at-least-once: dedupe on the `webhook-id` header.
- `relay.webhooks.secret()`, `.rotateSecret()` and `.deliveries.list()` / `.deliveries.get(taskIdOrRunId)`
  need a JWT or a partner superkey.

## Errors

Every error extends `RelayError`. HTTP errors extend `RelayAPIError`; the HTTP status picks the class:

| Status | Class |
|---|---|
| 400 | `InvalidRequestError` |
| 401 | `AuthenticationError` |
| 402 | `InsufficientCreditsError` |
| 403 | `PermissionDeniedError` |
| 404 | `NotFoundError` |
| 409 | `ConflictError` |
| 410 | `GoneError` |
| 422 | `ValidationError` |
| 429 | `RateLimitError` |
| 500 | `RelayInternalError` |
| 502 | `ProviderError` |
| 503 | `CapacityError` |
| 504 | `UpstreamTimeoutError` |

The `error.code` then picks a subclass: `KEY_BUDGET_EXHAUSTED` throws `KeyBudgetExhaustedError`, which is an
`InsufficientCreditsError`; `CONTENT_POLICY_DECLINED` throws `ContentPolicyDeclinedError` (a
`ValidationError`). Every code in Relay's error catalog has a class. A code this release does not know falls
back to the status class and keeps `e.code`; `e.code` may also be `null`.

```ts
import { KeyBudgetExhaustedError, RateLimitError, RelayAPIError } from "@relaygpu/client";

try {
  await relay.image.generate("Qwen/qwen-image", { prompt: "a lighthouse" });
} catch (e) {
  if (e instanceof KeyBudgetExhaustedError) console.error("this key's budget is spent");
  else if (e instanceof RateLimitError) console.error(`retry in ${e.retryAfter}s`);
  else if (e instanceof RelayAPIError) console.error(e.status, e.code, e.requestId, e.detail);
  else throw e;
}
```

- `e.requestId` is the id to quote to support; `e.retryAfter` (seconds) is set from `Retry-After`;
  `e.detail` is the server's detail.
- `TaskFailedError`: an async task (or workflow run) ended `failed`; `e.code` is the task's `error_code`,
  `e.taskId` and `e.task` carry the rest.
- `APIConnectionError` (no HTTP answer), `APITimeoutError` (a `timeoutMs` ran out),
  `WebhookVerificationError` (a delivery failed verification).
- Branch on the class or `e.code`, never on the message, and never on `error.source` in the response body.

## Account and keys

```ts
import { Relay } from "@relaygpu/client";

const relay = new Relay({ jwt: dashboardJwt }); // or the superkey of a partner (custom) tier

await relay.account.credits();
await relay.account.usage();
await relay.account.usageTimeseries({ start_time: Math.floor(Date.now() / 1000) - 86_400 });

const { key } = await relay.keys.create({ name: "end-user-42", key_budget: 5 }); // the secret, shown ONCE
for await (const k of relay.keys.listAll()) console.log(k.key_id, k.name);
await relay.keys.topup(keyId, 2);
await relay.keys.revoke(keyId);
```

These routes take a dashboard JWT or a custom-tier superkey. A plain inference key gets the server's 403
(`PermissionDeniedError`); the SDK does not guess the key class. `keys.create` returns the full secret in
`key` once; every later response masks it, so store it then. Address keys by `key_id`. `key_budget` is for
custom tiers only.

## Cost estimates

```ts
const est = await relay.estimateCost("KlingTeam/v3-T2V", { duration_seconds: 3, quality_mode: "std" });
console.log(est.usd, est.basis);
```

`estimateCost` computes from the public `/v2/pricing` rows. It is an **estimate, not an invoice**: you are
billed from provider-reported usage, and custom-tier prices are not in the public list.

## Runtimes

Node 18, 20 and 22 and Bun are tested in CI. Deno and Cloudflare Workers are supported by design (the
client uses only `fetch` and WebCrypto) and not yet in CI. ESM and CommonJS builds, types included, zero
runtime dependencies. `relay.request(method, path, body)` reaches any route with the same errors and
retry policy.

## Chat

Chat is a base-URL swap on the official SDKs, in any language:

| SDK | Base URL |
|---|---|
| OpenAI | `https://relaygpu.com/v2/openai/v1` |
| Anthropic | `https://relaygpu.com/v2/anthropic` |

## License

MIT
