import { pathId } from "./util.js";
import type { Relay } from "./client.js";
import type { RequestOptions } from "./http.js";
import type { OperationResponse, operations } from "./types.js";

type Query<Op extends keyof operations> = operations[Op] extends { parameters: { query?: infer Q } } ? NonNullable<Q> : never;

export type Credits = OperationResponse<"customer_credits_get">;
export type CreditHistory = OperationResponse<"customer_credits_history_get">;
export type CreditHistoryParams = Query<"customer_credits_history_get">;
export type Usage = OperationResponse<"customer_usage_get">;
export type UsageParams = Query<"customer_usage_get">;
export type KeyUsage = OperationResponse<"customer_usage_by_key_get">;
export type KeyUsageParams = Query<"customer_usage_by_key_get">;
export type UsageTimeseries = OperationResponse<"customer_usage_timeseries_get">;
export type UsageTimeseriesParams = Query<"customer_usage_timeseries_get">;
export type Metrics = OperationResponse<"customer_metrics_get">;
export type MetricsParams = Query<"customer_metrics_get">;
export type CustomerPricing = OperationResponse<"customer_pricing_get">;
export type Profile = OperationResponse<"customer_profile_get">;
export type ModelAllowlist = OperationResponse<"customer_model_allowlist_get">;
export type ModelAllowlistUpdate = OperationResponse<"customer_model_allowlist_update">;

/**
 * Account reads (Customer + Metrics ops). Auth: a dashboard JWT, or the superkey of a partner
 * (custom) tier. A plain inference key gets the server's 403 as `PermissionDeniedError`; the SDK never
 * guesses the key class client-side.
 */
export class Account {
  constructor(private readonly relay: Relay) {}

  async #get<T>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return (await this.relay._http.request<T>("GET", path, { query })).data;
  }

  /** `GET /v2/customer/credits`: balance, promos, consumption. */
  credits(): Promise<Credits> {
    return this.#get("/v2/customer/credits");
  }

  /** `GET /v2/customer/credits/history`. **JWT only** (a superkey is refused by the server). */
  creditsHistory(params: CreditHistoryParams = {}): Promise<CreditHistory> {
    return this.#get("/v2/customer/credits/history", params);
  }

  /** `GET /v2/customer/usage`: per-key analytics; page with `starting_after` = `next_cursor`. */
  usage(params: UsageParams = {}): Promise<Usage> {
    return this.#get("/v2/customer/usage", params);
  }

  /** `GET /v2/customer/usage/{key_id}`. Address the key by `key_id`, never its secret. */
  usageByKey(keyId: string, params: KeyUsageParams = {}): Promise<KeyUsage> {
    return this.#get(`/v2/customer/usage/${pathId(keyId)}`, params);
  }

  /** `GET /v2/customer/usage/timeseries`: bucketed spend/tokens (`start_time` = Unix seconds, required). */
  usageTimeseries(params: UsageTimeseriesParams): Promise<UsageTimeseries> {
    return this.#get("/v2/customer/usage/timeseries", params);
  }

  /** `GET /v2/customer/metrics`: latency percentiles and error splits (`start_time` = Unix seconds, required). */
  metrics(params: MetricsParams): Promise<Metrics> {
    return this.#get("/v2/customer/metrics", params);
  }

  /** `GET /v2/customer/pricing`: the account's effective rows (custom-tier overrides included). */
  pricing(): Promise<CustomerPricing> {
    return this.#get("/v2/customer/pricing");
  }

  /** `GET /v2/customer/profile`: profile, tier (`tier_details.is_custom`), balance, allowlist. */
  profile(): Promise<Profile> {
    return this.#get("/v2/customer/profile");
  }

  /** `GET /v2/customer/model-allowlist`: the customer-wide scope list for non-superkey keys (null = unset). */
  modelAllowlist(): Promise<ModelAllowlist> {
    return this.#get("/v2/customer/model-allowlist");
  }

  /**
   * `PATCH /v2/customer/model-allowlist`: replaces the list (`null` clears it). Scopes are
   * `{mode}.{source}.{model}`. Partner tiers only; the superkey stays exempt.
   */
  async setModelAllowlist(list: string[] | null): Promise<ModelAllowlistUpdate> {
    return (await this.relay._http.request<ModelAllowlistUpdate>("PATCH", "/v2/customer/model-allowlist", { body: { model_allowlist: list } })).data;
  }
}
