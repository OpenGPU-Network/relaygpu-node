// BILLED e2e (A9): ONE workflow run (script-voiceover: claude-haiku-4-5 + qwen3-tts-flash, ~$0.002 on
// staging), submitted with a webhookUrl, waited to its end, then its delivery read by run id.
// Skips without RELAY_BASE_URL / RELAY_API_KEY. The lead runs it.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Relay } from "./sdk.js";

function loadEnv() {
  const p = new URL("../../.env", import.meta.url);
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
loadEnv();
const { RELAY_BASE_URL: baseUrl, RELAY_API_KEY: apiKey } = process.env;

const WORKFLOW = "script-voiceover";
const WEBHOOK_URL = "https://example.com/relay-sdk-e2e";

describe.skipIf(!baseUrl || !apiKey)("workflows (staging, billed: one run)", () => {
  const relay = new Relay({ apiKey, baseUrl });

  it("list/get are public and the cheapest workflow is the expected chain", async () => {
    const list = await relay.workflows.list();
    expect(list.workflows.map((w) => w.workflow_id)).toContain(WORKFLOW);
    const wf = await relay.workflows.get(WORKFLOW);
    expect(wf.steps.length).toBe(2);
  });

  it(
    "A9: run with webhookUrl → accepted → waitRun to terminal → deliveries.get(runId) resolves",
    async () => {
      const accepted = await relay.workflows.run(
        WORKFLOW,
        { messages: [{ role: "user", content: "One short upbeat line about the sea." }], voice: "Serena" },
        { webhookUrl: WEBHOOK_URL },
      );
      expect(accepted.status).toBe("queued");
      expect(accepted.run_id).toMatch(/^wf:/);
      expect(accepted.replayed).toBe(false);

      const seen: string[] = [];
      const run = await relay.workflows.waitRun(accepted.run_id, { timeoutMs: 5 * 60_000, onProgress: (r) => seen.push(r.status) });
      expect(run.status).toBe("completed");
      expect(run.steps.length).toBe(2);
      expect(seen.at(-1)).toBe("completed");

      // The delivery is claimed at the terminal write; example.com refuses POSTs, so the first attempt
      // lands within seconds and retries continue in the background.
      let detail: Awaited<ReturnType<typeof relay.webhooks.deliveries.get>> | undefined;
      for (let i = 0; i < 20 && !detail; i++) {
        detail = await relay.webhooks.deliveries.get(accepted.run_id).catch((e) => {
          if (e?.status === 404) return undefined;
          throw e;
        });
        if (!detail) await new Promise((r) => setTimeout(r, 3000));
      }
      expect(detail).toBeTruthy();
      expect(detail!.task_id).toBe(accepted.run_id);
      expect(detail!.event).toBe("workflow.completed");
      expect(detail!.url).toBe(WEBHOOK_URL);
    },
    8 * 60_000,
  );
});
