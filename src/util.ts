/** @internal WebCrypto: the global on Node ≥ 19, Bun, Deno, Workers; `node:crypto`'s on Node 18 (no global there). */
let crypto_: Promise<Crypto> | undefined;
export function webCrypto(): Promise<Crypto> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return (crypto_ ??= c?.subtle ? Promise.resolve(c) : import("node:crypto").then((m) => m.webcrypto as unknown as Crypto));
}

/** @internal A v4 UUID from WebCrypto (idempotency keys must be unguessable, never Math.random). */
export async function randomUUID(): Promise<string> {
  return (await webCrypto()).randomUUID();
}

/** @internal One path segment: percent-encoded, with the task-id colon kept literal. */
export const pathId = (id: string) => encodeURIComponent(id).replace(/%3A/gi, ":");

type NodeBuffer = { from(b: ArrayBufferLike | string, a?: number | string, c?: number): Uint8Array & { toString(enc: string): string } };
const nodeBuffer = () => (globalThis as { Buffer?: NodeBuffer }).Buffer;

/** @internal Bytes → base64 (Buffer fast path on Node, chunked btoa elsewhere). */
export function bytesToBase64(bytes: Uint8Array): string {
  const B = nodeBuffer();
  if (B) return B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** @internal base64 → bytes; null when it is not base64. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
