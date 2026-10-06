import { describe, expect, it } from "vitest";
import { APITimeoutError, TaskFailedError, TaskNotFoundError } from "../../src/errors.js";
import { VIDEO_KLING, relayWith, task } from "../fixtures/catalog.js";
import { json, mockFetch, relayError } from "./helpers.js";

const ID = VIDEO_KLING.accepted.body.task_id as string;
const waitParam = (url: string) => new URL(url).searchParams.get("wait");

describe("tasks.get", () => {
  it("is keyless with the colon literal", async () => {
    const m = mockFetch(json(200, VIDEO_KLING.completed.body));
    const t = await relayWith(m.fetch).tasks.get(ID);
    expect(t.status).toBe("completed");
    expect(m.calls[0].url).toBe(`http://relay.test/v2/tasks/${ID}`);
    expect(m.calls[0].headers["x-api-key"]).toBeUndefined();
  });

  it("an unknown id is the typed TaskNotFoundError", async () => {
    const m = mockFetch(relayError(404, "TASK_NOT_FOUND"));
    await expect(relayWith(m.fetch).tasks.get("direct:gone")).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

describe("tasks.wait (F3, design rule 3)", () => {
  it("long-polls ?wait=30 keylessly and resolves the completed task (the captured Kling run: 5 polls)", async () => {
    const polls = VIDEO_KLING.polls as { task_status: string; elapsed_seconds: number }[];
    const m = mockFetch(...polls.slice(0, -1).map((p) => task(p.task_status, { task_id: ID, elapsed_seconds: p.elapsed_seconds })), json(200, VIDEO_KLING.completed.body));
    const seen: unknown[] = [];
    const t = await relayWith(m.fetch).tasks.wait(ID, { onProgress: (p) => seen.push(p) });
    expect(t).toEqual(VIDEO_KLING.completed.body);
    expect(m.calls).toHaveLength(polls.length);
    expect(m.calls.every((c) => c.url === `http://relay.test/v2/tasks/${ID}?wait=30` && c.headers["x-api-key"] === undefined)).toBe(true);
    // onProgress only on transitions: running (once), then completed.
    expect(seen).toEqual([
      { status: "running", elapsed_seconds: 30 },
      { status: "completed", elapsed_seconds: 121 },
    ]);
  });

  it("a ~15 s task costs ≤ 2 requests when the server holds the poll (A8)", async () => {
    const m = mockFetch(task("completed", { elapsed_seconds: 15, result: { urls: ["u"] } }));
    await relayWith(m.fetch).tasks.wait("direct:t1");
    expect(m.calls.length).toBeLessThanOrEqual(2);
  });

  it("wait never exceeds the remaining budget (ceil, ≥ 1) and a shed (early) answer just loops, ≥ 0.5 s apart", async () => {
    const stamps: number[] = [];
    const running = () => {
      stamps.push(Date.now());
      return task("running");
    };
    const m = mockFetch(running, running, running, task("completed", { result: {} }));
    await relayWith(m.fetch).tasks.wait("direct:t1", { timeoutMs: 10_500 });
    const w = m.calls.map((c) => Number(waitParam(c.url)));
    expect(w[0]).toBe(11);
    expect(w.every((x) => x >= 1 && x <= 11)).toBe(true);
    expect(w[1]).toBeLessThanOrEqual(10);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeGreaterThanOrEqual(490);
  });

  it("failed → TaskFailedError carrying error_code, error, error_detail, taskId", async () => {
    const failed = { task_id: ID, status: "failed", elapsed_seconds: 40, error: "The provider declined the prompt", error_code: "CONTENT_POLICY_DECLINED", error_detail: { upstream_code: "x", filtered: "input" } };
    const m = mockFetch(task("queued", { task_id: ID }), json(200, failed));
    const e = await relayWith(m.fetch).tasks.wait(ID).catch((e) => e);
    expect(e).toBeInstanceOf(TaskFailedError);
    expect(e).toMatchObject({ code: "CONTENT_POLICY_DECLINED", message: failed.error, detail: failed.error_detail, taskId: ID, task: failed });
  });

  it("budget exhausted → APITimeoutError", async () => {
    const m = mockFetch(...Array.from({ length: 10 }, () => task("running")));
    const e = await relayWith(m.fetch).tasks.wait("direct:t1", { timeoutMs: 1_200 }).catch((e) => e);
    expect(e).toBeInstanceOf(APITimeoutError);
    expect(e.message).toMatch(/still running/);
    expect(m.calls.length).toBeGreaterThanOrEqual(2);
    expect(m.calls.length).toBeLessThanOrEqual(4);
  });

  it("abort rejects with the signal's reason (between polls and in flight)", async () => {
    const ctrl = new AbortController();
    const reason = new Error("stop");
    const m = mockFetch(() => {
      setTimeout(() => ctrl.abort(reason), 50);
      return task("running");
    }, task("running"));
    await expect(relayWith(m.fetch).tasks.wait("direct:t1", { signal: ctrl.signal })).rejects.toBe(reason);
    expect(m.calls).toHaveLength(1);

    const pre = new AbortController();
    pre.abort(reason);
    const m2 = mockFetch(task("running"));
    await expect(relayWith(m2.fetch).tasks.wait("direct:t1", { signal: pre.signal })).rejects.toBe(reason);
    expect(m2.calls).toHaveLength(0);
  });
});
