// Binary inputs: what counts as a file, its media type, and the request-body walk that turns
// every file in a request into a link (an upload) or an inline base64 string.

/** Anything `files.upload` and the implicit upload accept. */
export type FileData = Blob | Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>;

/** Largest file `inlineImages` encodes into the body; a larger one is uploaded. */
export const INLINE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

export function isFileData(v: unknown): v is FileData {
  return (
    (typeof Blob !== "undefined" && v instanceof Blob) ||
    v instanceof Uint8Array ||
    v instanceof ArrayBuffer ||
    (typeof ReadableStream !== "undefined" && v instanceof ReadableStream)
  );
}

const isStream = (v: FileData): v is ReadableStream<Uint8Array> => typeof ReadableStream !== "undefined" && v instanceof ReadableStream;

/** `File.name` when the data carries one. */
export function fileNameOf(data: FileData): string | undefined {
  const name = (data as { name?: unknown }).name;
  return typeof name === "string" && name !== "" ? name : undefined;
}

function sizeOf(data: FileData): number | null {
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return null;
}

const ascii = (b: Uint8Array, at: number, s: string) => s.split("").every((c, i) => b[at + i] === c.charCodeAt(0));

/** The media type from the first bytes of a file; null when unrecognised. */
export function sniffMediaType(b: Uint8Array): string | null {
  if (b[0] === 0x89 && ascii(b, 1, "PNG")) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 0, "GIF8")) return "image/gif";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return "audio/wav";
  if (ascii(b, 4, "ftyp")) {
    if (ascii(b, 8, "qt  ")) return "video/quicktime";
    if (ascii(b, 8, "M4A ")) return "audio/mp4";
    return "video/mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (ascii(b, 0, "OggS")) return "audio/ogg";
  if (ascii(b, 0, "fLaC")) return "audio/flac";
  if (ascii(b, 0, "ID3") || (b[0] === 0xff && b.length > 1 && (b[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  return null;
}

const HEAD = 16;

/**
 * Resolves the media type (`explicit` → `Blob.type` → sniffed magic bytes) without consuming
 * the data: a stream is peeked and handed back as an equivalent stream.
 */
export async function resolveMediaType(data: FileData, explicit?: string): Promise<{ data: FileData; type: string | null }> {
  if (explicit) return { data, type: explicit };
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    if (data.type) return { data, type: data.type };
    return { data, type: sniffMediaType(new Uint8Array(await data.slice(0, HEAD).arrayBuffer())) };
  }
  if (data instanceof Uint8Array) return { data, type: sniffMediaType(data.subarray(0, HEAD)) };
  if (data instanceof ArrayBuffer) return { data, type: sniffMediaType(new Uint8Array(data, 0, Math.min(HEAD, data.byteLength))) };
  const { head, stream } = await peek(data as ReadableStream<Uint8Array>, HEAD);
  return { data: stream, type: sniffMediaType(head) };
}

/** Reads at least `n` bytes (or to the end) and returns them plus a stream that replays everything. */
async function peek(src: ReadableStream<Uint8Array>, n: number): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = src.getReader();
  const chunks: Uint8Array[] = [];
  let have = 0;
  let done = false;
  while (have < n) {
    const r = await reader.read();
    if (r.done) {
      done = true;
      break;
    }
    chunks.push(r.value);
    have += r.value.byteLength;
  }
  const head = new Uint8Array(Math.min(have, n));
  let off = 0;
  for (const c of chunks) {
    if (off >= head.length) break;
    const part = c.subarray(0, head.length - off);
    head.set(part, off);
    off += part.length;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const c of chunks) ctrl.enqueue(c);
      if (done) ctrl.close();
    },
    async pull(ctrl) {
      const r = await reader.read();
      if (r.done) ctrl.close();
      else ctrl.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head, stream };
}

async function bytesOf(data: FileData): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await new Response(data as BodyInit).arrayBuffer());
}

function base64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unknownTypeError(where: string): TypeError {
  return new TypeError(
    `Relay: cannot tell the media type of ${where}; pass contentType (image/*, video/* or audio/*) or a Blob with a type`,
  );
}

// ---- the request-body walk ----

export interface PrepareInputsOptions {
  /** Retention for implicit uploads. Default `relay1h` (free, quota'd). */
  upload?: { retention?: string };
  /** Send images ≤ 4 MB inline (base64) where the route's field accepts it, instead of uploading. */
  inlineImages?: boolean;
  signal?: AbortSignal;
  /** The route's request JSON Schema (`models.get(model).request_schema`); decides which fields take base64. */
  requestSchema?: Record<string, any> | null;
}

export type Uploader = (data: FileData, opts: { retention: string; filename?: string; signal?: AbortSignal }) => Promise<string>;

type SchemaNode = Record<string, any> | undefined;

const URL_KEY = /_urls?$/;
const B64_WORDS = /base64|data uri|data:[a-z]/i;
const DATA_URI_WORDS = /data uri|data:[a-z]/i;
const URL_WORDS = /\burls?\b/i;

function deref(node: SchemaNode, root: SchemaNode): SchemaNode {
  const ref = node?.$ref;
  if (typeof ref !== "string" || !root) return node;
  const name = ref.split("/").pop()!;
  return root.$defs?.[name] ?? root.definitions?.[name] ?? node;
}

/** The node and its `anyOf`/`oneOf`/`allOf` branches. */
function branches(node: SchemaNode, root: SchemaNode): Record<string, any>[] {
  const n = deref(node, root);
  if (!n) return [];
  return [n, ...[...(n.anyOf ?? []), ...(n.oneOf ?? []), ...(n.allOf ?? [])].map((b: SchemaNode) => deref(b, root)).filter((b): b is Record<string, any> => b != null)];
}

function propertySchema(node: SchemaNode, key: string, root: SchemaNode): SchemaNode {
  for (const b of branches(node, root)) if (b.properties?.[key]) return b.properties[key];
  return undefined;
}

function itemSchema(node: SchemaNode, root: SchemaNode): SchemaNode {
  for (const b of branches(node, root)) if (b.items) return b.items;
  return undefined;
}

function describe(node: SchemaNode, root: SchemaNode): string {
  return branches(node, root)
    .flatMap((b) => [b.description, b.items?.description])
    .filter((d): d is string => typeof d === "string")
    .join(" ");
}

interface Field {
  key: string;
  schema: SchemaNode;
  /** An array item inherits the array field's description ("Each item is raw base64 or a data URI"). */
  inherited?: string;
}

/** How a field takes a file: a link, base64 (raw or data URI), or both. */
function fieldRule(f: Field, root: SchemaNode) {
  const desc = `${describe(f.schema, root)} ${f.inherited ?? ""}`;
  const urlKey = URL_KEY.test(f.key);
  const b64 = B64_WORDS.test(desc);
  return {
    url: urlKey || URL_WORDS.test(desc),
    base64: b64,
    // A *_url field takes a URL-shaped string, so a data URI; a plain "base64 string" field gets raw base64.
    dataUri: b64 && (urlKey || DATA_URI_WORDS.test(desc)),
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== "object" || v === null) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

function containsFile(v: unknown): boolean {
  if (isFileData(v)) return true;
  if (Array.isArray(v)) return v.some(containsFile);
  if (isPlainObject(v)) return Object.values(v).some(containsFile);
  return false;
}

/**
 * Returns a copy of `input` in which every file (Blob / Uint8Array / ArrayBuffer / ReadableStream)
 * is replaced by a string the route accepts:
 * - a `*_url` / `*_urls` field, or a field whose schema says it takes a URL → uploaded, replaced by its link;
 * - with `inlineImages`, an image ≤ 4 MB in a field whose schema says it takes base64 → inlined
 *   (a data URI for URL-shaped fields and fields that name data URIs, raw base64 otherwise);
 * - a field that takes base64 only (no URL) → always inlined, whatever the size;
 * - anything else → TypeError.
 * One upload per distinct file object per call. A body without files makes no calls.
 */
export async function prepareInputs<T extends Record<string, unknown>>(input: T, opts: PrepareInputsOptions, upload: Uploader): Promise<T> {
  if (!containsFile(input)) return { ...input };
  const root = opts.requestSchema ?? undefined;
  const retention = opts.upload?.retention ?? "relay1h";
  const uploads = new Map<FileData, Promise<string>>();
  const inlined = { uri: new Map<FileData, Promise<string>>(), raw: new Map<FileData, Promise<string>>() };

  const doUpload = (data: FileData) => {
    let p = uploads.get(data);
    if (!p) {
      p = upload(data, { retention, filename: fileNameOf(data), signal: opts.signal });
      uploads.set(data, p);
    }
    return p;
  };

  const doInline = (data: FileData, type: string, dataUri: boolean) => {
    const byForm = dataUri ? inlined.uri : inlined.raw;
    let p = byForm.get(data);
    if (!p) {
      p = bytesOf(data).then((b) => (dataUri ? `data:${type};base64,${base64(b)}` : base64(b)));
      byForm.set(data, p);
    }
    return p;
  };

  const check = (f: Field) => {
    const rule = fieldRule(f, root);
    if (!rule.url && !rule.base64) {
      throw new TypeError(
        `Relay: field "${f.key}" holds file data but takes neither a URL nor base64` +
          (root ? "" : "; only *_url / *_urls fields are uploaded without the route's request schema"),
      );
    }
    return rule;
  };

  const onFile = async (data: FileData, f: Field): Promise<string> => {
    const rule = check(f);
    if (!rule.base64) return doUpload(data);
    if (!rule.url) {
      // base64-only: inlining is the only way in, whatever the size (a stream is read into memory).
      const type = isStream(data) ? null : (await resolveMediaType(data)).type;
      if (rule.dataUri && !type) throw unknownTypeError(`field "${f.key}"`);
      return doInline(data, type ?? "application/octet-stream", rule.dataUri);
    }
    const size = sizeOf(data); // null for a stream: never inlined
    if (opts.inlineImages && size != null && size <= INLINE_IMAGE_MAX_BYTES) {
      const { type } = await resolveMediaType(data);
      if (type?.startsWith("image/")) return doInline(data, type, rule.dataUri);
    }
    return doUpload(data);
  };

  const walk = async (v: unknown, f: Field, onLeaf: (data: FileData, f: Field) => unknown): Promise<unknown> => {
    if (isFileData(v)) return onLeaf(v, f);
    if (Array.isArray(v)) {
      const item: Field = { key: f.key, schema: itemSchema(f.schema, root), inherited: `${describe(f.schema, root)} ${f.inherited ?? ""}` };
      const out: unknown[] = [];
      for (const x of v) out.push(await walk(x, item, onLeaf));
      return out;
    }
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        out[k] = containsFile(x) ? await walk(x, { key: k, schema: propertySchema(f.schema, k, root) }, onLeaf) : x;
      }
      return out;
    }
    return v;
  };

  const top: Field = { key: "", schema: root };
  await walk(input, top, (_, f) => check(f)); // refuse a misplaced file before the first upload
  return (await walk(input, top, onFile)) as T;
}
