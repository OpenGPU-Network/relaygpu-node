// A4 / A9: verify real staging deliveries captured by the EM. Format: test/fixtures/webhooks/README.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WebhookVerificationError, verifyWebhook } from "../../src/webhooks.js";

interface Fixture {
  event: string;
  captured_at: string;
  headers: { "webhook-id": string; "webhook-timestamp": string; "webhook-signature": string };
  body: string;
}

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/webhooks");
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];
const secret = process.env.RELAY_WEBHOOK_SECRET;
const fixtures = files.map((f) => ({ file: f, fx: JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture }));

describe.skipIf(files.length === 0 || !secret)("webhook fixtures (real staging deliveries)", () => {
  for (const { file, fx } of fixtures) {
    const now = Number(fx.headers["webhook-timestamp"]);

    it(`${file}: verifies and carries its event`, async () => {
      const e = await verifyWebhook(fx.body, fx.headers, secret!, { now });
      expect(e.event).toBe(fx.event);
    });

    it(`${file}: tampered body and stale timestamp are rejected`, async () => {
      const tampered = fx.body.replace(/"elapsed_seconds":\s*(\d+)/, (_, n) => `"elapsed_seconds": ${Number(n) + 1}`);
      expect(tampered).not.toBe(fx.body);
      await expect(verifyWebhook(tampered, fx.headers, secret!, { now })).rejects.toBeInstanceOf(WebhookVerificationError);
      await expect(verifyWebhook(fx.body, fx.headers, secret!, { now: now + 600 })).rejects.toBeInstanceOf(WebhookVerificationError);
    });

    if (fx.event === "workflow.completed") {
      it(`${file}: narrows to the run event (result.status, top-level status always completed)`, async () => {
        const e = await verifyWebhook(fx.body, fx.headers, secret!, { now });
        if (e.event !== "workflow.completed") throw new Error(`expected workflow.completed, got ${e.event}`);
        expect(e.status).toBe("completed");
        expect(e.task_id).toMatch(/^wf:/);
        expect(e.result?.status).toBe("completed");
        expect(e.result?.run_id).toBe(e.task_id);
      });
    }
  }
});
