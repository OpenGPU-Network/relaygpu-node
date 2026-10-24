import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Relay } from "../../src/client.js";
import { AuthenticationError, InsufficientCreditsError, ModelNotFoundError } from "../../src/errors.js";
import { VERSION } from "../../src/version.js";
import { KEY, MODELS, PRICING, detail } from "../fixtures/catalog.js";
import { json, mockFetch, relayError, type Recorded } from "./helpers.js";

const JWT = "a.b.c";
const base = "http://relay.test";
const TIERS = { tiers: [] };
const HEALTH = { status: "ok", version: "2", commit: "abc" };

/** The four catalog reads in one pass, on a client built from `opts`. */
async function readAll(opts: ConstructorParameters<typeof Relay>[0]) {
  const m = mockFetch(json(200, MODELS), detail("KlingTeam/v3-T2V"), json(200, PRICING), json(200, TIERS));
  const relay = new Relay({ baseUrl: base, fetch: m.fetch, ...opts });
  await relay.models.list();
  await relay.models.get("KlingTeam/v3-T2V");
  await relay.pricing.get();
  await relay.tiers.list();
  return m.calls;
}

describe("catalog reads carry the client's credential", () => {
  it("an apiKey client sends X-API-Key on /v2/models, /v2/models/{name}, /v2/pricing and /v2/tiers", async () => {
    const calls = await readAll({ apiKey: KEY });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v2/models", "/v2/models/KlingTeam/v3-T2V", "/v2/pricing", "/v2/tiers"]);
    for (const c of calls) {
      expect(c.headers["x-api-key"]).toBe(KEY);
      expect(c.headers.authorization).toBeUndefined();
    }
  });

  it("a jwt client sends Authorization: Bearer on the same four reads", async () => {
    const calls = await readAll({ jwt: JWT });
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.headers.authorization).toBe(`Bearer ${JWT}`);
      expect(c.headers["x-api-key"]).toBeUndefined();
    }
  });

  it("a client with no credential sends neither header", async () => {
    const calls = await readAll({});
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.headers["x-api-key"]).toBeUndefined();
      expect(c.headers.authorization).toBeUndefined();
    }
  });

  it("health, the task poll and the workflow run poll stay credential-free on a keyed client", async () => {
    const m = mockFetch(
      json(200, HEALTH),
      json(200, { task_id: "direct:t1", status: "completed", elapsed_seconds: 1 }),
      json(200, { run_id: "run_1", status: "completed" }),
    );
    const relay = new Relay({ apiKey: KEY, baseUrl: base, fetch: m.fetch });
    await relay.health();
    await relay.tasks.get("direct:t1");
    await relay.workflows.getRun("run_1");
    expect(m.calls.map((c) => new URL(c.url).pathname)).toEqual(["/v2/health", "/v2/tasks/direct:t1", "/v2/workflows/runs/run_1"]);
    for (const c of m.calls) {
      expect(c.headers["x-api-key"]).toBeUndefined();
      expect(c.headers.authorization).toBeUndefined();
    }
  });

  it("a 401 on a keyed models.list() is AuthenticationError; a 402 is InsufficientCreditsError", async () => {
    const m = mockFetch(relayError(401, "INVALID_API_KEY"), relayError(402, "INSUFFICIENT_CREDITS"));
    const relay = new Relay({ apiKey: KEY, baseUrl: base, fetch: m.fetch, retry: false });
    const e1 = await relay.models.list().catch((e) => e);
    expect(e1).toBeInstanceOf(AuthenticationError);
    expect(e1.status).toBe(401);
    const e2 = await relay.models.list().catch((e) => e);
    expect(e2).toBeInstanceOf(InsufficientCreditsError);
    expect(e2.status).toBe(402);
  });
});

describe("the models.get cache is per client", () => {
  it("a keyed and a keyless client over the same fetch do not share results", async () => {
    const name = "KlingTeam/v3-T2V";
    // Account-aware answer: the keyed call resolves, the keyless one is a 404 for the same name.
    const answer = (req: Recorded) => (req.headers["x-api-key"] ? detail(name) : detail("nope/nope"));
    const f = mockFetch(answer, answer);
    const keyed = new Relay({ apiKey: KEY, baseUrl: base, fetch: f.fetch });
    const keyless = new Relay({ baseUrl: base, fetch: f.fetch });
    const a = await keyed.models.get(name);
    expect(await keyless.models.get(name).catch((e) => e)).toBeInstanceOf(ModelNotFoundError);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].headers["x-api-key"]).toBe(KEY);
    expect(f.calls[1].headers["x-api-key"]).toBeUndefined();
    // each keeps its own entry: the keyed one is a hit, no third request
    expect(await keyed.models.get(name)).toBe(a);
    expect(f.calls).toHaveLength(2);
  });
});

describe("version", () => {
  it("VERSION matches package.json and rides the User-Agent", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
    const m = mockFetch(json(200, HEALTH));
    await new Relay({ baseUrl: base, fetch: m.fetch }).health();
    expect(m.calls[0].headers["user-agent"]).toBe(`relaygpu-node/${pkg.version}`);
  });
});
