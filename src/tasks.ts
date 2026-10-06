import type { Relay } from "./client.js";
import { pathId } from "./util.js";
import { APITimeoutError, TaskFailedError } from "./errors.js";
import { sleep } from "./http.js";
import type { TaskStatus } from "./types.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 20 * 60_000;
/** The server holds a `?wait=` call at most this long. */
const MAX_WAIT_S = 30;
/** Floor between two polls, so a shed (early) answer never turns into a hot loop. */
const POLL_FLOOR_MS = 500;
/** Slack over `wait` for the HTTP timeout of one long-poll. */
const POLL_SLACK_MS = 15_000;

export interface TaskProgress {
  status: TaskStatus["status"];
  elapsed_seconds: number;
}

export interface WaitOptions {
  /** Total budget. Default 20 min; exhausted → `APITimeoutError` (the task keeps running server-side). */
  timeoutMs?: number;
  /** Fires on each status transition (`queued` → `running` → …) only. There is no finer-grained progress. */
  onProgress?: (p: TaskProgress) => void;
  signal?: AbortSignal;
}

/** The task id goes into the path raw: the colon of `direct:{uuid}` stays literal. */
const taskPath = (id: string) => "/v2/tasks/" + pathId(id);

/** Async task polling. Keyless: the task id is the capability. */
export class Tasks {
  readonly #relay: Relay;
  constructor(relay: Relay) {
    this.#relay = relay;
  }

  /** `GET /v2/tasks/{id}` — the current status. An unknown or expired id throws `TaskNotFoundError`. */
  async get(id: string, opts: { signal?: AbortSignal } = {}): Promise<TaskStatus> {
    return (await this.#relay._http.request<TaskStatus>("GET", taskPath(id), { noAuth: true, signal: opts.signal })).data;
  }

  /**
   * Long-polls `GET /v2/tasks/{id}?wait=W` until the task is terminal. Resolves the completed task; throws
   * `TaskFailedError` (`code` = the task's `error_code`) on `failed`, `APITimeoutError` when `timeoutMs` runs out,
   * and rejects with the signal's reason on abort.
   */
  async wait(id: string, opts: WaitOptions = {}): Promise<TaskStatus> {
    const budget = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + budget;
    const { signal } = opts;
    let last: string | undefined;
    let lastCall = 0;
    let task: TaskStatus | undefined;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      if (lastCall) {
        const gap = POLL_FLOOR_MS - (Date.now() - lastCall);
        if (gap > 0) await sleep(gap, signal);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new APITimeoutError({
          message: `Task ${id} is still ${task?.status ?? "pending"} after ${budget} ms (it keeps running; poll it again or wait longer)`,
          detail: { taskId: id, task },
        });
      }
      const w = Math.max(1, Math.min(MAX_WAIT_S, Math.ceil(remaining / 1000)));
      lastCall = Date.now();
      const res = await this.#relay._http.request<TaskStatus>("GET", taskPath(id), {
        query: { wait: w },
        noAuth: true,
        signal,
        timeoutMs: w * 1000 + POLL_SLACK_MS,
      });
      task = res.data;
      if (task.status !== last) {
        last = task.status;
        opts.onProgress?.({ status: task.status, elapsed_seconds: task.elapsed_seconds });
      }
      if (task.status === "completed") return task;
      if (task.status === "failed") {
        throw new TaskFailedError({
          message: task.error || `Task ${id} failed`,
          code: task.error_code ?? null,
          detail: task.error_detail ?? undefined,
          requestId: res.requestId,
          taskId: id,
          task,
        });
      }
    }
  }
}
