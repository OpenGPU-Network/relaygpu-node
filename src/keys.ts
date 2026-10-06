import { pathId } from "./util.js";
import type { Relay } from "./client.js";
import { KeyNotFoundError } from "./errors.js";
import type { OperationResponse, Schema, operations } from "./types.js";

export type KeyList = OperationResponse<"customer_keys_list">;
export type ApiKey = Schema<"KeyResponse">;
export type KeyListParams = NonNullable<operations["customer_keys_list"]["parameters"]["query"]>;
export type CreateKeyParams = Schema<"CreateKeyRequest">;
export type CreatedKey = OperationResponse<"customer_keys_create", 201>;
export type UpdateKeyParams = Schema<"UpdateKeyRequest">;
export type KeyTopup = OperationResponse<"customer_keys_topup">;
export type KeyPromotion = OperationResponse<"customer_keys_promote">;
/** The spec leaves these bodies untyped (`200: unknown`). */
export type KeyMutationResult = Record<string, unknown>;

const keyPath = (keyId: string) => `/v2/customer/keys/${pathId(keyId)}`;

/**
 * API key management. Auth: a dashboard JWT, or a partner superkey (custom tiers); anything else gets the
 * server's 403. Address keys by `key_id`, never by secret (a secret in a path answers 400).
 */
export class Keys {
  constructor(private readonly relay: Relay) {}

  /** `GET /v2/customer/keys`: newest first, secrets masked. Page with `starting_after` = `next_cursor`. */
  async list(params: KeyListParams = {}): Promise<KeyList> {
    return (await this.relay._http.request<KeyList>("GET", "/v2/customer/keys", { query: params })).data;
  }

  /** Every key matching `params`, following `next_cursor` across pages. */
  async *listAll(params: Omit<KeyListParams, "starting_after"> = {}): AsyncGenerator<ApiKey, void, undefined> {
    let cursor: string | null | undefined;
    for (;;) {
      const page = await this.list({ ...params, starting_after: cursor ?? undefined });
      yield* page.keys;
      if (!page.has_more || !page.next_cursor) return;
      cursor = page.next_cursor;
    }
  }

  /**
   * `POST /v2/customer/keys`. The response's `key` is the full secret and is returned **only here**,
   * once; store it now (every later response masks it). The first key on a custom tier becomes the
   * superkey (`is_superkey: true`). `key_budget` is custom-tier only (403 otherwise). Never retried
   * (a retry could mint twice).
   */
  async create(params: CreateKeyParams): Promise<CreatedKey> {
    return (await this.relay._http.request<CreatedKey>("POST", "/v2/customer/keys", { body: params })).data;
  }

  /**
   * One key by `key_id`. The API has no get-one route, so this pages `GET /v2/customer/keys` and matches
   * `key_id`; absent → `KeyNotFoundError` (code `KEY_NOT_FOUND`, raised client-side, `status` null).
   */
  async get(keyId: string): Promise<ApiKey> {
    for await (const k of this.listAll({ limit: 1000 })) if (k.key_id === keyId) return k;
    throw new KeyNotFoundError({ message: `Key not found: ${keyId}`, code: "KEY_NOT_FOUND" });
  }

  /** `PATCH /v2/customer/keys/{key_id}`: send only what changes; `restrictions` is replaced, not merged. */
  async update(keyId: string, patch: UpdateKeyParams): Promise<KeyMutationResult> {
    return (await this.relay._http.request<KeyMutationResult>("PATCH", keyPath(keyId), { body: patch })).data;
  }

  /** Renames a key (names are unique per customer; 400 on duplicate). */
  rename(keyId: string, name: string): Promise<KeyMutationResult> {
    return this.update(keyId, { name });
  }

  /** `POST …/revoke`. Reversible with {@link Keys.unrevoke}. */
  async revoke(keyId: string): Promise<KeyMutationResult> {
    return (await this.relay._http.request<KeyMutationResult>("POST", `${keyPath(keyId)}/revoke`)).data;
  }

  /** `POST …/unrevoke`. */
  async unrevoke(keyId: string): Promise<KeyMutationResult> {
    return (await this.relay._http.request<KeyMutationResult>("POST", `${keyPath(keyId)}/unrevoke`)).data;
  }

  /** `DELETE /v2/customer/keys/{key_id}`: permanent; the key must be revoked first. */
  async delete(keyId: string): Promise<KeyMutationResult> {
    return (await this.relay._http.request<KeyMutationResult>("DELETE", keyPath(keyId))).data;
  }

  /** `POST …/topup`: atomically adds `amount` USD to the key's `key_budget` (custom tiers; uncapped → amount). */
  async topup(keyId: string, amount: number): Promise<KeyTopup> {
    return (await this.relay._http.request<KeyTopup>("POST", `${keyPath(keyId)}/topup`, { body: { amount } })).data;
  }

  /** `POST …/promote`: makes the key the superkey. JWT only server-side (a superkey gets 403). */
  async promote(keyId: string): Promise<KeyPromotion> {
    return (await this.relay._http.request<KeyPromotion>("POST", `${keyPath(keyId)}/promote`)).data;
  }
}
