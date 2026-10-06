import { APIConnectionError, APITimeoutError, errorFromResponse } from "./errors.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://relaygpu.com";
export const DEFAULT_TIMEOUT_MS = 600_000;

export interface RetryOptions {
  /** GET retries on 429/503 (honouring `Retry-After`). Default 3. */
  maxRateLimitRetries?: number;
  /** GET retries on 5xx / network error, and keyed-POST retries on 5xx / network error / timeout. Default 2. */
  maxRetries?: number;
  /** Longest `Retry-After` the client sleeps through before surfacing the error instead. Default 60 s. */
  maxRetryAfterMs?: number;
}

export interface ClientOptions {
  /** A Relay key (`relay_sk_…`), sent as `X-API-Key`. */
  apiKey?: string;
  /** A dashboard login JWT, sent as `Authorization: Bearer`. Never combined with `apiKey`. */
  jwt?: string;
  /** Default `https://relaygpu.com`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-attempt timeout. Default 10 min. */
  timeoutMs?: number;
  /** `false` disables every retry. */
  retry?: boolean | RetryOptions;
  defaultHeaders?: Record<string, string>;
}

export type Body = BodyInit | Uint8Array | null | undefined;

export interface RequestOptions {
  query?: Record<string, string | number | boolean | string[] | undefined | null>;
  /** JSON body (serialised) — or pass `rawBody`. */
  body?: unknown;
  rawBody?: Body;
  contentType?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Makes a POST retry-safe: sent as `Idempotency-Key`, and the POST is then retried on network
   * error / timeout / 5xx with the same key. Without it a POST is never retried.
   */
  idempotencyKey?: string;
  /** Skip the credential (keyless routes such as the task poll). */
  noAuth?: boolean;
}

export interface APIResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  requestId: string | null;
  /** `true` when a 202 replays an earlier submit with the same `Idempotency-Key`. */
  replayed: boolean;
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });


const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);

export class HttpClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #auth: Record<string, string>;
  readonly #retry: Required<RetryOptions> | null;
  readonly #defaultHeaders: Record<string, string>;

  constructor(opts: ClientOptions = {}) {
    if (opts.apiKey && opts.jwt) throw new TypeError("Relay: pass apiKey or jwt, not both");
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new TypeError("Relay: no global fetch; pass opts.fetch");
    this.#fetch = f.bind(globalThis);
    this.#auth = opts.apiKey ? { "X-API-Key": opts.apiKey } : opts.jwt ? { Authorization: `Bearer ${opts.jwt}` } : {};
    this.#retry =
      opts.retry === false
        ? null
        : { maxRateLimitRetries: 3, maxRetries: 2, maxRetryAfterMs: 60_000, ...(typeof opts.retry === "object" ? opts.retry : {}) };
    this.#defaultHeaders = opts.defaultHeaders ?? {};
  }

  /** Never reveal the credential when the client is logged or serialised. */
  toJSON() {
    return { baseUrl: this.baseUrl, timeoutMs: this.timeoutMs };
  }

  url(path: string, query?: RequestOptions["query"]): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k, x));
      else u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<APIResponse<T>> {
    const isGet = method === "GET" || method === "HEAD";
    const keyed = !isGet && opts.idempotencyKey != null;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `relaygpu-node/${VERSION}`,
      ...this.#defaultHeaders,
      ...(opts.noAuth ? {} : this.#auth),
      ...opts.headers,
    };
    if (opts.idempotencyKey != null) headers["Idempotency-Key"] = opts.idempotencyKey;
    let body: Body;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
      if (opts.contentType) headers["Content-Type"] = opts.contentType;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
    // A stream body can be sent once; it is never retried.
    const replayable = !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
    const url = this.url(path, opts.query);

    let rateLimitRetries = 0;
    let retries = 0;
    let inProgressRetried = false;
    for (;;) {
      let res: Response;
      try {
        res = await this.#send(url, method, headers, body, opts);
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        const r = this.#retry;
        if (r && (isGet || keyed) && replayable && retries < r.maxRetries) {
          await sleep(backoff(retries++), opts.signal);
          continue;
        }
        throw e;
      }
      if (res.ok) return parseOk<T>(res);

      const err = errorFromResponse(res.status, await readBody(res), res.headers);
      const r = this.#retry;
      if (!r || !replayable) throw err;
      const waitMs = err.retryAfter != null ? err.retryAfter * 1000 : null;
      if (waitMs != null && waitMs > r.maxRetryAfterMs) throw err;
      if (isGet && (res.status === 429 || res.status === 503) && rateLimitRetries < r.maxRateLimitRetries) {
        await sleep(waitMs ?? backoff(rateLimitRetries), opts.signal);
        rateLimitRetries++;
        continue;
      }
      if (keyed && res.status === 409 && err.code === "IDEMPOTENCY_IN_PROGRESS" && !inProgressRetried) {
        inProgressRetried = true;
        await sleep(waitMs ?? 1000, opts.signal);
        continue;
      }
      if ((isGet ? res.status !== 503 : keyed) && res.status >= 500 && retries < r.maxRetries) {
        await sleep(waitMs ?? backoff(retries++), opts.signal);
        continue;
      }
      throw err;
    }
  }

  async #send(url: string, method: string, headers: Record<string, string>, body: Body, opts: RequestOptions): Promise<Response> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onAbort = () => ctrl.abort(opts.signal!.reason);
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const init: RequestInit & { duplex?: "half" } = { method, headers, body: body as BodyInit | null | undefined, signal: ctrl.signal };
      if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) init.duplex = "half";
      return await this.#fetch(url, init);
    } catch (e) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? e;
      if (timedOut) throw new APITimeoutError({ message: `Request timed out after ${timeoutMs} ms: ${method} ${new URL(url).pathname}` });
      throw new APIConnectionError({ message: `Connection error: ${method} ${new URL(url).pathname}: ${(e as Error)?.message ?? e}` });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function parseOk<T>(res: Response): Promise<APIResponse<T>> {
  const ct = res.headers.get("content-type") ?? "";
  let data: unknown;
  if (res.status === 204) data = undefined;
  else if (ct.includes("json")) data = await res.json();
  else if (ct.startsWith("text/")) data = await res.text();
  else data = await res.arrayBuffer();
  return {
    data: data as T,
    status: res.status,
    headers: res.headers,
    requestId: res.headers.get("x-request-id"),
    replayed: res.headers.get("idempotency-replayed") === "true",
  };
}

