// Client-side cost estimate from the public `/v2/pricing` rows (F8). An ESTIMATE, never an invoice:
// the server bills from provider-reported usage, applies custom-tier overrides the public list never shows,
// and resolves tier keys with rules this file only mirrors.
import type { Relay } from "./client.js";
import { RelayError } from "./errors.js";
import type { Mode, Schema } from "./types.js";

type PricingRow = Schema<"PricingItem">;

/**
 * What a call used (or will use). Count fields follow the server's usage vocabulary (snake_case), so an
 * audit-style `usage` block can be passed straight in. Only the fields the model's billing type reads matter.
 */
export interface UsageInput {
  /** Pricing mode. Default `direct` (an `auto` request is served by direct whenever it is permitted). */
  mode?: Exclude<Mode, "auto">;
  // per_token
  input_tokens?: number;
  output_tokens?: number;
  /** Cached-read tokens: a subset of `input_tokens`. */
  cached_input_tokens?: number;
  /** Anthropic prompt-cache writes: subsets of `input_tokens`. */
  cache_write_5m_input_tokens?: number;
  cache_write_1h_input_tokens?: number;
  // per_image
  image_count?: number;
  /** Resolution key of a resolution-priced row (`1K`, `2K`, `4K`, `1024x1024`, …). */
  resolution_tier?: string;
  // per_second_video / per_second_audio
  duration_seconds?: number;
  /** Video: `std` | `pro` (Kling). */
  quality_mode?: string;
  /** Video: sound on/off (Kling `sound`, Seedance `generate_audio`, Motion-Control `keep_original_sound`). */
  sound?: boolean;
  /** Video: a reference input is present (Kling O1). */
  has_ref?: boolean;
  // per_character
  character_count?: number;
  // per_media_token
  media_input_tokens?: number;
  media_output_tokens?: number;
  // per_request (no live row uses it today; kept for rows that do)
  request_count?: number;
  /** Output hosting (`store_output`): `provider` is free; `relay1d|relay7d|relay30d` add a per-file fee. */
  store_output?: string;
  /** Upload retention (`POST /v2/files`): `relay1h` is free; `relay1d|relay7d|relay30d` add a per-file fee. */
  retention?: string;
  /** Files the storage fee applies to. Default: `image_count`, else 1. */
  file_count?: number;
}

export interface CostEstimate {
  /** Estimated USD. Not an invoice. */
  usd: number;
  /** How the number was built, e.g. `per_second_video: 5 s × $0.084 (std|silent)`. */
  basis: string;
}

const M = 1_000_000;
const money = (n: number) => `$${+n.toPrecision(6)}`;

/** The row's model name without its `source.` prefix (`video.KlingTeam/v3-T2V` → `KlingTeam/v3-T2V`). */
const rowName = (row: PricingRow) => row.model.slice(row.model.indexOf(".") + 1);

function findRow(rows: PricingRow[], model: string, mode: string): PricingRow | undefined {
  const inMode = rows.filter((r) => r.mode === mode);
  return inMode.find((r) => rowName(r) === model) ?? inMode.find((r) => r.model === model);
}

/** Mirrors the server's tier fallback: first matching candidate, then `default`, then the cheapest cell. */
function tierRate(map: Record<string, unknown> | null | undefined, candidates: (string | null | undefined)[]): { rate: number; key: string } | null {
  if (!map || Object.keys(map).length === 0) return null;
  for (const c of candidates) if (c && typeof map[c] === "number") return { rate: map[c] as number, key: c };
  if (typeof map.default === "number") return { rate: map.default, key: "default" };
  const [key, rate] = Object.entries(map)
    .filter((e): e is [string, number] => typeof e[1] === "number")
    .sort((a, b) => a[1] - b[1])[0] ?? [];
  return key == null ? null : { rate: rate!, key };
}

function tokens(row: PricingRow, u: UsageInput, allowContextTier = true): { usd: number; basis: string } {
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cached = u.cached_input_tokens ?? 0;
  const w5 = u.cache_write_5m_input_tokens ?? 0;
  const w1 = u.cache_write_1h_input_tokens ?? 0;
  const long = allowContextTier && row.context_tier_threshold != null && input > row.context_tier_threshold;
  const r = (field: keyof PricingRow): number | null => {
    const v = (long ? (row[`${String(field)}_long` as keyof PricingRow] as number | null | undefined) : null) ?? (row[field] as number | null | undefined);
    return typeof v === "number" ? v : null;
  };
  const inRate = r("per_1m_input_tokens") ?? 0;
  const outRate = r("per_1m_output_tokens") ?? 0;
  const cacheRate = r("per_1m_cached_input_tokens");
  const parts: string[] = [];
  let usd: number;
  if (w5 > 0 || w1 > 0 || (cacheRate != null && cached > 0)) {
    const readRate = cacheRate ?? inRate;
    const fresh = Math.max(input - cached - w5 - w1, 0);
    usd = (fresh * inRate + cached * readRate + output * outRate) / M;
    parts.push(`${fresh} in × ${money(inRate)}/1M`, `${cached} cached × ${money(readRate)}/1M`);
    for (const [count, field, label] of [
      [w5, "per_1m_cache_write_5m_input_tokens", "5m-write"],
      [w1, "per_1m_cache_write_1h_input_tokens", "1h-write"],
    ] as const) {
      if (count > 0) {
        const rate = r(field) ?? inRate;
        usd += (count * rate) / M;
        parts.push(`${count} ${label} × ${money(rate)}/1M`);
      }
    }
  } else {
    usd = (input * inRate + output * outRate) / M;
    parts.push(`${input} in × ${money(inRate)}/1M`);
  }
  parts.push(`${output} out × ${money(outRate)}/1M`);
  return { usd, basis: `per_token${long ? " (long context)" : ""}: ${parts.join(" + ")}` };
}

function images(row: PricingRow, u: UsageInput): { usd: number; basis: string } {
  const count = u.image_count ?? 1;
  const res = row.per_image_resolution as Record<string, unknown> | null | undefined;
  if (res && Object.keys(res).length) {
    const t = tierRate(res, [u.resolution_tier]);
    if (!t) throw new RelayError({ message: `estimateCost: no usable per_image_resolution rate for ${row.model}` });
    return { usd: count * t.rate, basis: `per_image: ${count} × ${money(t.rate)} (${t.key})` };
  }
  const rate = row.per_image ?? 0;
  return { usd: count * rate, basis: `per_image: ${count} × ${money(rate)}` };
}

/** `resolution|quality|sound`, `quality|sound`, `quality|ref`, `resolution` — the server's candidate chain. */
function videoCandidates(u: UsageInput): (string | null)[] {
  const sound = u.sound == null ? null : u.sound ? "sound" : "silent";
  const ref = u.has_ref == null ? null : u.has_ref ? "w-ref" : "no-ref";
  const grid = u.quality_mode && sound ? `${u.quality_mode}|${sound}` : null;
  const refGrid = u.quality_mode && ref ? `${u.quality_mode}|${ref}` : null;
  return [u.resolution_tier && grid ? `${u.resolution_tier}|${grid}` : null, grid, refGrid, u.resolution_tier ?? null];
}

function mediaRate(v: unknown, u: UsageInput): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object") return tierRate(v as Record<string, unknown>, [u.sound == null ? null : u.sound ? "sound" : "silent"])?.rate ?? 0;
  return 0;
}

function base(row: PricingRow, u: UsageInput): { usd: number; basis: string } {
  switch (row.billing_type) {
    case "per_token":
      return tokens(row, u);
    case "per_image":
      return images(row, u);
    case "per_image_plus_tokens": {
      const a = images(row, u);
      const b = tokens(row, u, false);
      return { usd: a.usd + b.usd, basis: `${a.basis} + ${b.basis}` };
    }
    case "per_character": {
      const n = u.character_count ?? 0;
      const rate = row.per_1k_characters ?? 0;
      return { usd: (n * rate) / 1000, basis: `per_character: ${n} chars × ${money(rate)}/1K` };
    }
    case "per_second_audio": {
      const s = u.duration_seconds ?? 0;
      const rate = row.per_second_audio ?? 0;
      return { usd: s * rate, basis: `per_second_audio: ${s} s × ${money(rate)}` };
    }
    case "per_second_video": {
      const s = u.duration_seconds ?? 0;
      const t = tierRate(row.per_second_video as Record<string, unknown> | null, videoCandidates(u));
      if (!t) throw new RelayError({ message: `estimateCost: no usable per_second_video rate for ${row.model}` });
      return { usd: s * t.rate, basis: `per_second_video: ${s} s × ${money(t.rate)} (${t.key})` };
    }
    case "per_media_token": {
      const i = u.media_input_tokens ?? 0;
      const o = u.media_output_tokens ?? 0;
      const ri = mediaRate(row.per_1m_media_input_tokens, u);
      const ro = mediaRate(row.per_1m_media_output_tokens, u);
      return { usd: (i * ri + o * ro) / M, basis: `per_media_token: ${i} in × ${money(ri)}/1M + ${o} out × ${money(ro)}/1M` };
    }
    case "per_request": {
      const n = u.request_count ?? 1;
      const rate = (row as Record<string, unknown>).per_request;
      if (typeof rate !== "number") throw new RelayError({ message: `estimateCost: per_request row for ${row.model} carries no rate` });
      return { usd: n * rate, basis: `per_request: ${n} × ${money(rate)}` };
    }
    default:
      throw new RelayError({ message: `estimateCost: billing type "${row.billing_type}" of ${row.model} is not known to this SDK version` });
  }
}

function storageFee(storage: Schema<"MediaStoragePricing"> | null | undefined, sku: string | undefined, free: string, files: number, label: string) {
  if (!sku || sku === free) return null;
  const rate = storage ? (storage as Record<string, unknown>)[sku] : undefined;
  if (typeof rate !== "number") {
    const offered = storage ? Object.keys(storage).filter((k) => k !== "unit") : [];
    throw new RelayError({ message: `estimateCost: ${label} "${sku}" is not offered (media_storage: ${offered.length ? offered.join(", ") : "none"})` });
  }
  return { usd: files * rate, basis: `${label} ${sku}: ${files} file × ${money(rate)}` };
}

/**
 * Estimates the USD cost of a call from `GET /v2/pricing` (the only network call). An estimate, never an invoice:
 * the bill comes from provider-reported usage and any custom-tier pricing your account carries.
 * Throws a `RelayError` for a model with no row in the mode, an unknown billing type or an unoffered storage SKU.
 */
export async function estimateCost(relay: Relay, model: string, usage: UsageInput): Promise<CostEstimate> {
  const pricing = await relay.pricing.get();
  const mode = usage.mode ?? "direct";
  const row = findRow(pricing.pricing, model, mode);
  if (!row) throw new RelayError({ message: `estimateCost: no ${mode} pricing row for "${model}" in /v2/pricing` });
  const parts = [base(row, usage)];
  const files = usage.file_count ?? usage.image_count ?? 1;
  for (const fee of [
    storageFee(pricing.media_storage, usage.store_output, "provider", files, "store_output"),
    storageFee(pricing.media_storage, usage.retention, "relay1h", files, "retention"),
  ]) {
    if (fee) parts.push(fee);
  }
  const usd = parts.reduce((s, p) => s + p.usd, 0);
  return { usd: Math.round(usd * 1e8) / 1e8, basis: parts.map((p) => p.basis).join(" + ") };
}
