// A5 against staging. Both calls are refused at auth/scope time (no task, no bill).
import { describe, expect, it } from "vitest";
import { KeyBudgetExhaustedError, PermissionDeniedError, Relay, env } from "./sdk.js";

const budgetZero = process.env.RELAY_BUDGET_ZERO_KEY;
const allowlisted = process.env.RELAY_ALLOWLISTED_KEY;
// The allowlist holds a scope, `{mode}.{source}.{model}`; the model name is what follows the second dot.
const allowedModel = process.env.RELAY_ALLOWLISTED_MODEL?.split(".").slice(2).join(".") || undefined;
const suite = env.ready && budgetZero && allowlisted && allowedModel ? describe : describe.skip;

// The model's own documented example: a valid body, so only the credential decides the answer.
async function exampleFor(model: string) {
  const detail = await new Relay({ baseUrl: env.baseUrl }).models.get(model);
  return { ...(detail.request_example ?? {}) } as Record<string, unknown>;
}

suite("typed errors e2e (staging)", () => {
  it("A5: a budget-zero key on its allowed model → KeyBudgetExhaustedError (402) with code and requestId", async () => {
    const relay = new Relay({ apiKey: budgetZero, baseUrl: env.baseUrl });
    const e = await relay.run(allowedModel!, await exampleFor(allowedModel!), { wait: false }).catch((e) => e);
    expect(e).toBeInstanceOf(KeyBudgetExhaustedError);
    expect(e).toMatchObject({ status: 402, code: "KEY_BUDGET_EXHAUSTED" });
    expect(e.requestId).toMatch(/\S+/);
    console.log(`A5 402: ${e.constructor.name} code=${e.code} requestId=${e.requestId}`);
  });

  it("A5: the allowlisted key on any other model → the 403 class with its code", async () => {
    const other = allowedModel === "Qwen/qwen3-tts-flash" ? "Qwen/qwen-image" : "Qwen/qwen3-tts-flash";
    const relay = new Relay({ apiKey: allowlisted, baseUrl: env.baseUrl });
    const e = await relay.run(other, await exampleFor(other), { wait: false }).catch((e) => e);
    expect(e).toBeInstanceOf(PermissionDeniedError);
    expect(e.status).toBe(403);
    expect(e.code).toMatch(/^[A-Z_]+$/);
    expect(e.requestId).toMatch(/\S+/);
    console.log(`A5 403: ${e.constructor.name} code=${e.code} requestId=${e.requestId}`);
  });
});
