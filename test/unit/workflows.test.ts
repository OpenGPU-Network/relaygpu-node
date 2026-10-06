import { afterEach, describe, expect, it, vi } from "vitest";
import type { Relay } from "../../src/client.js";
import { APITimeoutError, TaskFailedError, WorkflowRunLimitReachedError, WorkflowRunNotCancellableError } from "../../src/errors.js";
import { HttpClient } from "../../src/http.js";
import { Workflows } from "../../src/workflows.js";
import { json, mockFetch, relayError } from "./helpers.js";

const KEY = "relay_sk_unit";
const RUN = "wf:7c9e6679-7425-40de-944b-e07fc1f90ae7";
const accepted = { run_id: RUN, status: "queued", poll_url: `/v2/workflows/runs/${RUN}` };
const state = (status: string, extra: Record<string, unknown> = {}) => ({ run_id: RUN, workflow_id: "script-voiceover", version: 2, status, inputs: {}, steps: [], ...extra });

function make(...replies: Parameters<typeof mockFetch>) {
  const m = mockFetch(...replies);
  const wf = new Workflows({ _http: new HttpClient({ apiKey: KEY, baseUrl: "http://relay.test", fetch: m.fetch }) } as unknown as Relay);
  return { m, wf };
}

afterEach(() => vi.useRealTimers());

describe("workflows.list / get", () => {
  it("hits the public routes", async () => {
    const { m, wf } = make(json(200, { total: 0, workflows: [] }), json(200, { workflow_id: "gen-edit", name: "x", steps: [], version: 1 }));
    await wf.list();
    await wf.get("gen-edit");
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET http://relay.test/v2/workflows", "GET http://relay.test/v2/workflows/gen-edit"]);
  });
});

describe("workflows.run", () => {
  it("sends inputs, webhook_url (A9) and store_output, with a generated Idempotency-Key", async () => {
    const { m, wf } = make(json(202, accepted));
    const r = await wf.run("script-voiceover", { voice: "Serena" }, { webhookUrl: "https://example.com/hook", storeOutput: "relay1d" });
    expect(r).toEqual({ ...accepted, replayed: false });
    const c = m.calls[0];
    expect(`${c.method} ${c.url}`).toBe("POST http://relay.test/v2/workflows/script-voiceover/run");
    expect(c.body).toEqual({ inputs: { voice: "Serena" }, webhook_url: "https://example.com/hook", store_output: "relay1d" });
    expect(c.headers["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(c.headers["x-api-key"]).toBe(KEY);
  });

  it("omits optional fields; a fresh key per call; the caller's key verbatim", async () => {
    const { m, wf } = make(json(202, accepted), json(202, accepted), json(202, accepted, { "idempotency-replayed": "true" }));
    await wf.run("gen-edit", { prompt: "a", edit: "b" });
    await wf.run("gen-edit", { prompt: "a", edit: "b" });
    const r = await wf.run("gen-edit", { prompt: "a", edit: "b" }, { idempotencyKey: "my-key-1" });
    expect(m.calls[0].body).toEqual({ inputs: { prompt: "a", edit: "b" } });
    expect(m.calls[0].headers["idempotency-key"]).not.toBe(m.calls[1].headers["idempotency-key"]);
    expect(m.calls[2].headers["idempotency-key"]).toBe("my-key-1");
    expect(r.replayed).toBe(true);
  });

  it("a 5xx is retried with the same key", async () => {
    const { m, wf } = make(relayError(502, "UPSTREAM_ERROR", {}, { "retry-after": "0" }), json(202, accepted));
    await wf.run("gen-edit", {});
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1].headers["idempotency-key"]).toBe(m.calls[0].headers["idempotency-key"]);
  });

  it("429 WORKFLOW_RUN_LIMIT_REACHED surfaces, never retried", async () => {
    const { m, wf } = make(relayError(429, "WORKFLOW_RUN_LIMIT_REACHED", {}, { "retry-after": "0" }), json(202, accepted));
    await expect(wf.run("gen-edit", {})).rejects.toBeInstanceOf(WorkflowRunLimitReachedError);
    expect(m.calls).toHaveLength(1);
  });

  it("wait: true polls the run (keyless) to its terminal state", async () => {
    vi.useFakeTimers();
    const { m, wf } = make(json(202, accepted), json(200, state("running")), json(200, state("completed", { output: { audio: "u" } })));
    const p = wf.run("script-voiceover", {}, { wait: true });
    await vi.advanceTimersByTimeAsync(1000);
    const run = await p;
    expect(run.status).toBe("completed");
    expect(m.calls[1].url).toBe(`http://relay.test/v2/workflows/runs/${RUN}`);
    expect(m.calls[1].headers["x-api-key"]).toBeUndefined();
  });
});

describe("workflows.waitRun", () => {
  it("reports status transitions once each and backs off 1 s → 5 s", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const times: number[] = [];
    const replies = ["queued", "running", "running", "running", "running", "completed"].map((s) => () => {
      times.push(Date.now());
      return json(200, state(s));
    });
    const { wf } = make(...replies);
    const p = wf.waitRun(RUN, { onProgress: (r) => seen.push(r.status) });
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await p).status).toBe("completed");
    expect(seen).toEqual(["queued", "running", "completed"]);
    expect(times.slice(1).map((t, i) => t - times[i])).toEqual([1000, 2000, 4000, 5000, 5000]);
  });

  it("failed and cancelled throw TaskFailedError carrying the run", async () => {
    const failed = state("failed", { error: "Step 2 failed: boom", failed_step_index: 1 });
    const { wf } = make(json(200, failed), json(200, state("cancelled")));
    const e = await wf.waitRun(RUN).catch((e) => e);
    expect(e).toBeInstanceOf(TaskFailedError);
    expect(e).toMatchObject({ taskId: RUN, message: "Step 2 failed: boom", task: failed });
    const c = await wf.waitRun(RUN).catch((e) => e);
    expect(c).toBeInstanceOf(TaskFailedError);
    expect(c.message).toBe("Workflow run cancelled");
  });

  it("the budget elapsing throws APITimeoutError", async () => {
    vi.useFakeTimers();
    const { m, wf } = make(...Array.from({ length: 10 }, () => () => json(200, state("running"))));
    const p = wf.waitRun(RUN, { timeoutMs: 2500 }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBeInstanceOf(APITimeoutError);
    expect(m.calls).toHaveLength(3); // t=0, 1000, 2500 (sleep clipped to the budget)
  });

  it("abort stops the wait", async () => {
    vi.useFakeTimers();
    const ctrl = new AbortController();
    const { wf } = make(json(200, state("running")));
    const p = wf.waitRun(RUN, { signal: ctrl.signal }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10);
    ctrl.abort(new Error("stop"));
    expect((await p).message).toBe("stop");
  });
});

describe("workflows.cancelRun", () => {
  it("POSTs with the key; 409 surfaces typed", async () => {
    const { m, wf } = make(json(200, state("cancelled")), relayError(409, "WORKFLOW_RUN_NOT_CANCELLABLE"));
    expect((await wf.cancelRun(RUN)).status).toBe("cancelled");
    expect(`${m.calls[0].method} ${m.calls[0].url}`).toBe(`POST http://relay.test/v2/workflows/runs/${RUN}/cancel`);
    expect(m.calls[0].headers["x-api-key"]).toBe(KEY);
    await expect(wf.cancelRun(RUN)).rejects.toBeInstanceOf(WorkflowRunNotCancellableError);
  });
});
