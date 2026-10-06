/** @internal WebCrypto: the global on Node ≥ 19, Bun, Deno, Workers; `node:crypto`'s on Node 18 (no global there). */
export async function webCrypto(): Promise<Crypto> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.subtle) return c;
  const m = await import("node:crypto");
  return m.webcrypto as unknown as Crypto;
}

/** @internal A v4 UUID from WebCrypto (idempotency keys must be unguessable, never Math.random). */
export async function randomUUID(): Promise<string> {
  return (await webCrypto()).randomUUID();
}

/** @internal One path segment: percent-encoded, with the task-id colon kept literal. */
export const pathId = (id: string) => encodeURIComponent(id).replace(/%3A/gi, ":");
