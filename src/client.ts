import { HttpClient, type ClientOptions, type RequestOptions } from "./http.js";
import { Models, Pricing, Tiers, health } from "./models.js";
import { estimateCost, type CostEstimate, type UsageInput } from "./estimate.js";
import { run, type RunOptions } from "./run.js";
import { Tasks } from "./tasks.js";
import { Images } from "./image.js";
import { Videos } from "./video.js";
import { Audio } from "./audio.js";
import { Files } from "./files.js";
import { Workflows } from "./workflows.js";
import { Account } from "./account.js";
import { Keys } from "./keys.js";
import { Webhooks } from "./webhooks.js";

export class Relay {
  /** @internal The transport. Not part of the public API. */
  readonly _http: HttpClient;

  readonly models: Models;
  readonly pricing: Pricing;
  readonly tiers: Tiers;
  readonly tasks: Tasks;
  readonly image: Images;
  readonly video: Videos;
  readonly audio: Audio;
  readonly files: Files;
  readonly workflows: Workflows;
  readonly account: Account;
  readonly keys: Keys;
  readonly webhooks: Webhooks;

  constructor(opts: ClientOptions = {}) {
    this._http = new HttpClient(opts);
    this.models = new Models(this);
    this.pricing = new Pricing(this);
    this.tiers = new Tiers(this);
    this.tasks = new Tasks(this);
    this.image = new Images(this);
    this.video = new Videos(this);
    this.audio = new Audio(this);
    this.files = new Files(this);
    this.workflows = new Workflows(this);
    this.account = new Account(this);
    this.keys = new Keys(this);
    this.webhooks = new Webhooks(this);
  }

  /** `GET /v2/health`. */
  health() {
    return health(this);
  }

  /** Runs any model: resolves its route through `models.get`, submits, and (by default) waits for the result. */
  run(model: string, input: Record<string, unknown>, opts?: RunOptions) {
    return run(this, model, input, opts);
  }

  /** Client-side estimate from `/v2/pricing` rows. An estimate, never an invoice. */
  estimateCost(model: string, usage: UsageInput): Promise<CostEstimate> {
    return estimateCost(this, model, usage);
  }

  /** Escape hatch: any route, typed errors and the retry policy included. Returns the parsed body. */
  async request<T = unknown>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
    const res = await this._http.request<T>(method, path, body === undefined ? opts : { ...opts, body });
    return res.data;
  }

  /** Never reveal the credential when the client is logged or serialised. */
  toJSON() {
    return { baseUrl: this._http.baseUrl };
  }
}
