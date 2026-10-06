import type { Relay } from "./client.js";
import { submit, type AsyncAccepted, type SubmitOptions } from "./submit.js";
import type { TaskProgress } from "./tasks.js";

export type { AsyncAccepted, Uploadable } from "./submit.js";

export interface RunOptions extends SubmitOptions {
  /** Wait for an async task to finish (long-poll). Default `true`. `false` returns the `202` envelope instead. */
  wait?: boolean;
  /** Fires on status transitions of an async task only. */
  onProgress?: (p: TaskProgress) => void;
  /** Budget for waiting on an async task (default 20 min); per-attempt HTTP timeout of a sync call. */
  timeoutMs?: number;
}

/** The model's output: a sync route's response body, or a completed task's `result`. */
export type RunOutput = Record<string, unknown>;

/** True for the `202` envelope `run(..., { wait: false })` returns when the route answered async. */
export function isAccepted(v: RunOutput | AsyncAccepted): v is AsyncAccepted {
  return typeof (v as AsyncAccepted).task_id === "string" && typeof (v as AsyncAccepted).poll_url === "string" && (v as AsyncAccepted).status === "queued";
}

/**
 * Runs any model by name. The route, `model_in_body` and `async_default` come from `relay.models.get(model)`; a
 * retired or unknown model throws (`ModelRetiredError` / `ModelNotFoundError`) before anything is submitted.
 *
 * - sync route → the response body;
 * - async route (or `async: true`) → waits and returns the task's `result` (`TaskFailedError` on failure);
 * - async with `wait: false` → the `202` envelope (`AsyncAccepted`, with `replayed`) — narrow with `isAccepted()`.
 *
 * Async submits carry an `Idempotency-Key` (yours, or a generated UUID) and are retried safely; sync calls never are.
 */
export async function run(relay: Relay, model: string, input: Record<string, unknown>, opts?: RunOptions & { wait?: true }): Promise<RunOutput>;
export async function run(relay: Relay, model: string, input: Record<string, unknown>, opts?: RunOptions): Promise<RunOutput | AsyncAccepted>;
export async function run(relay: Relay, model: string, input: Record<string, unknown>, opts: RunOptions = {}): Promise<RunOutput | AsyncAccepted> {
  const res = await submit(relay, model, input, opts);
  if (res.kind === "sync") return res.data;
  if (opts.wait === false) return res.accepted;
  const task = await relay.tasks.wait(res.accepted.task_id, { timeoutMs: opts.timeoutMs, onProgress: opts.onProgress, signal: opts.signal });
  return (task.result ?? {}) as RunOutput;
}
