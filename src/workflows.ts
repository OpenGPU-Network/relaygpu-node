import type { Relay } from "./client.js";
import { APITimeoutError, TaskFailedError } from "./errors-base.js";
import { sleep } from "./http.js";
import type { OperationResponse, Schema, WorkflowRunState } from "./types.js";
import { pathId, randomUUID } from "./util.js";

/** Default `waitRun` budget. */
const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;

export type WorkflowList = OperationResponse<"workflows_list">;
export type WorkflowTemplate = Schema<"WorkflowTemplateItem">;
export type WorkflowRunAccepted = Schema<"WorkflowRunAccepted">;
/** A `store_output` SKU; the live set is `/v2/pricing.media_storage` (data, never a closed enum). */
export type StoreOutput = "provider" | "relay1d" | "relay7d" | "relay30d" | (string & {});

export interface WaitRunOptions {
  /** Total wait budget. Default 30 min. Exceeding it throws `APITimeoutError` (the run keeps going). */
  timeoutMs?: number;
  /** Called with the run whenever its `status` changes (including the first poll). */
  onProgress?: (run: WorkflowRunState) => void;
  signal?: AbortSignal;
}

export interface WorkflowRunOptions extends WaitRunOptions {
  /** Wait for the run to end and return its terminal state instead of the 202. */
  wait?: boolean;
  /** HTTPS URL for ONE signed `workflow.completed` / `workflow.failed` delivery when the run ends. */
  webhookUrl?: string;
  /** Sent as `Idempotency-Key`; a UUID is generated when omitted, so the submit is always retry-safe. */
  idempotencyKey?: string;
  /** Run-level storage for every media step (`relay1d|7d|30d` are billed per file). */
  storeOutput?: StoreOutput;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export class Workflows {
  constructor(private readonly relay: Relay) {}

  /** `GET /v2/workflows` (public). Each entry carries `input_schema`, `steps` and `version`. */
  async list(): Promise<WorkflowList> {
    return (await this.relay._http.request<WorkflowList>("GET", "/v2/workflows")).data;
  }

  /** `GET /v2/workflows/{id}` (public). */
  async get(workflowId: string): Promise<WorkflowTemplate> {
    return (await this.relay._http.request<WorkflowTemplate>("GET", `/v2/workflows/${pathId(workflowId)}`)).data;
  }

  /**
   * `POST /v2/workflows/{id}/run`. Always carries an `Idempotency-Key` (yours, or a generated UUID), so a
   * network error / timeout / 5xx is retried with the same key and can never start a second run; a
   * replayed 202 comes back with `replayed: true`. Every step is billed as an ordinary request.
   * `429 WORKFLOW_RUN_LIMIT_REACHED` (runs in flight) surfaces as `WorkflowRunLimitReachedError`.
   *
   * With `wait: true` it returns the terminal run (see {@link Workflows.waitRun}).
   */
  run(workflowId: string, inputs: Record<string, unknown>, opts: WorkflowRunOptions & { wait: true }): Promise<WorkflowRunState>;
  run(workflowId: string, inputs?: Record<string, unknown>, opts?: WorkflowRunOptions & { wait?: false }): Promise<WorkflowRunAccepted & { replayed: boolean }>;
  run(workflowId: string, inputs?: Record<string, unknown>, opts?: WorkflowRunOptions): Promise<WorkflowRunState | (WorkflowRunAccepted & { replayed: boolean })>;
  async run(workflowId: string, inputs: Record<string, unknown> = {}, opts: WorkflowRunOptions = {}) {
    const body: Record<string, unknown> = { inputs };
    if (opts.storeOutput !== undefined) body.store_output = opts.storeOutput;
    if (opts.webhookUrl !== undefined) body.webhook_url = opts.webhookUrl;
    const idempotencyKey = opts.idempotencyKey ?? (await randomUUID());
    const res = await this.relay._http.request<WorkflowRunAccepted>("POST", `/v2/workflows/${pathId(workflowId)}/run`, {
      body,
      idempotencyKey,
      signal: opts.signal,
    });
    const accepted = { ...res.data, replayed: res.replayed };
    if (!opts.wait) return accepted;
    return this.waitRun(accepted.run_id, opts);
  }

  /** `GET /v2/workflows/runs/{run_id}`. Keyless: the run id is the capability token. */
  async getRun(runId: string, opts: { signal?: AbortSignal } = {}): Promise<WorkflowRunState> {
    return (await this.relay._http.request<WorkflowRunState>("GET", `/v2/workflows/runs/${pathId(runId)}`, { noAuth: true, signal: opts.signal })).data;
  }

  /**
   * Polls the run (1 s, backing off to 5 s; runs have no long-poll) until it ends.
   * `completed` resolves with the run; `failed` / `cancelled` throw `TaskFailedError` (`taskId` = the
   * run id, `task` = the run, message = `run.error`). The budget elapsing throws `APITimeoutError`.
   */
  async waitRun(runId: string, opts: WaitRunOptions = {}): Promise<WorkflowRunState> {
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    let delay = 1000;
    let last: string | null = null;
    for (;;) {
      const run = await this.getRun(runId, { signal: opts.signal });
      if (run.status !== last) {
        last = run.status;
        opts.onProgress?.(run);
      }
      if (TERMINAL.has(run.status)) {
        if (run.status === "completed") return run;
        throw new TaskFailedError({
          message: run.error || `Workflow run ${run.status}`,
          taskId: run.run_id ?? runId,
          task: run,
        });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new APITimeoutError({ message: `Workflow run ${runId} still ${run.status} after ${opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS} ms` });
      await sleep(Math.min(delay, remaining), opts.signal);
      delay = Math.min(5000, delay * 2);
    }
  }

  /**
   * `POST /v2/workflows/runs/{run_id}/cancel` (key required). Cancels between steps only: a step
   * already running completes and bills. A run already ended answers 409 `WORKFLOW_RUN_NOT_CANCELLABLE`.
   */
  async cancelRun(runId: string): Promise<WorkflowRunState> {
    return (await this.relay._http.request<WorkflowRunState>("POST", `/v2/workflows/runs/${pathId(runId)}/cancel`)).data;
  }
}
