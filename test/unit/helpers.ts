// Offline fetch mock: queue responses, record every request.
export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Reply = Response | Error | ((req: Recorded) => Response | Promise<Response>);

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function relayError(status: number, code: string | null, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return json(status, { detail: extra.detail ?? `boom ${code}`, error: { code, type: null, source: null, message: `boom ${code}`, request_id: "req_test", ...extra } }, headers);
}

export function mockFetch(...replies: Reply[]) {
  const calls: Recorded[] = [];
  const queue = [...replies];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    let body: unknown = init.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* raw */ }
    }
    const rec: Recorded = { method: init.method ?? "GET", url: String(input), headers, body };
    calls.push(rec);
    const next = queue.shift();
    if (!next) throw new Error(`mockFetch: no reply queued for ${rec.method} ${rec.url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(rec) : next;
  }) as typeof fetch;
  return { fetch: fn, calls };
}
