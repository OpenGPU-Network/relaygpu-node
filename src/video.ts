import type { Relay } from "./client.js";
import type { ModelOperations } from "./generated/models.js";
import type { HelperInput } from "./image.js";
import { submit, type AsyncAccepted, type SubmitOptions } from "./submit.js";
import type { TaskProgress } from "./tasks.js";
import type { TaskStatus } from "./types.js";
import { RelayError } from "./errors-base.js";

type VideoOps = ModelOperations["Video"];
/** Known video model names, with autocomplete — any other string is accepted too. */
export type VideoModel = keyof VideoOps | (string & {});

export interface VideoOptions extends Omit<SubmitOptions, "async"> {
  /** `true` long-polls until the task is terminal and returns the completed `TaskStatus`. Default `false`: the `202` envelope. */
  wait?: boolean;
  onProgress?: (p: TaskProgress) => void;
  /** Wait budget (default 20 min). */
  timeoutMs?: number;
}

/** Video generation. Always submitted async (with an `Idempotency-Key`, retried safely). */
export class Videos {
  readonly #relay: Relay;
  constructor(relay: Relay) {
    this.#relay = relay;
  }

  /**
   * Submits a video task. Returns the `202` envelope (`task_id`, `poll_url`, `replayed`) by default;
   * with `{ wait: true }` waits and returns the completed `TaskStatus` (`result.urls`), or throws `TaskFailedError`.
   * Any `*_url` field may hold a Blob/bytes/stream: it is uploaded first (`opts.upload.retention`, default `relay1h`).
   */
  generate<M extends VideoModel>(model: M, input: HelperInput<VideoOps, M>, opts: VideoOptions & { wait: true }): Promise<TaskStatus>;
  generate<M extends VideoModel>(model: M, input: HelperInput<VideoOps, M>, opts?: VideoOptions & { wait?: false }): Promise<AsyncAccepted>;
  generate<M extends VideoModel>(model: M, input: HelperInput<VideoOps, M>, opts?: VideoOptions): Promise<AsyncAccepted | TaskStatus>;
  async generate(model: string, input: Record<string, unknown>, opts: VideoOptions = {}): Promise<AsyncAccepted | TaskStatus> {
    const res = await submit(this.#relay, model, input, { ...opts, async: true });
    if (res.kind === "sync") {
      // Every video route honours `async: true`; an inline answer means the contract moved.
      throw new RelayError({ message: `Model '${model}' answered inline to an async submit; use relay.run() for this model`, requestId: res.requestId });
    }
    if (!opts.wait) return res.accepted;
    return this.#relay.tasks.wait(res.accepted.task_id, { timeoutMs: opts.timeoutMs, onProgress: opts.onProgress, signal: opts.signal });
  }
}
