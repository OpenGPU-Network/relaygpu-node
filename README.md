# RelayGPU Node SDK — `@relaygpu/client`

> **Status: pre-release — under active development, not yet published to npm.**

Official TypeScript/Node client for [RelayGPU](https://relaygpu.com): media generation
(image, video, audio), async task lifecycle, webhook verification, workflows, and typed
errors — the surfaces the OpenAI/Anthropic SDKs don't cover.

```ts
import { Relay } from "@relaygpu/client";

const relay = new Relay({ apiKey: process.env.RELAY_API_KEY });

const task = await relay.video.generate("KlingTeam/v3-T2V", { prompt: "..." });
const done = await relay.tasks.wait(task.task_id);
```

## LLMs? Use the SDK you already have

Chat/completions work with the official OpenAI and Anthropic SDKs in **any language** —
just point them at Relay:

```ts
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: process.env.RELAY_API_KEY,
  baseURL: "https://relay.opengpu.network/v2/openai/v1",
});
```

This SDK exists for everything else: 202/task polling, `curl -N`-free streaming helpers,
Standard-Webhooks signature verification, workflow runs, and machine-readable error codes.

## Packages

| Package | Purpose |
|---|---|
| `@relaygpu/client` | The API client (this repo's core) |
| `@relaygpu/server-proxy` | Browser-app key protection (planned) |
| `@relaygpu/mcp` | MCP server for agent tooling (planned) |

Python: [`relaygpu-python`](https://github.com/OpenGPU-Network/relaygpu-python) (planned,
after the TS API freezes).

## Docs

- API docs: https://docs.relaygpu.com
- Error catalog, model list, and pricing: rendered live in the API Explorer.

## License

MIT
