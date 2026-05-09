// lib/discovery/dupeFingerprint.ts
import type { DiscoveredJob } from "../../types/discovery";

export type DupeSignals = {
  normTitle: string;
  normCompany: string | null;
  titleTokens: string[];
  simhash64_hex: string;
};

const STOPWORDS = new Set([
  "and",
  "or",
  "the",
  "a",
  "an",
  "of",
  "to",
  "for",
  "with",
  "in",
  "on",
  "at",
  "from",
  "by",
  "as",
  "role",
  "position",
  "job",
  "junior",
  "medior",
  "mid",
  "senior",
  "lead",
  "manager",
  "engineer",
]);

function normalizeTextBase(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeTitle(raw: string): string {
  const s = normalizeTextBase(raw);
  // Remove parenthetical noise frequently added by boards.
  return s.replace(/\b(remote|hybrid|onsite|on site|full time|part time|contract)\b/g, "").replace(/\s+/g, " ").trim();
}

export function normalizeCompany(raw: string | null | undefined): string | null {
  const s = typeof raw === "string" ? normalizeTextBase(raw) : "";
  if (!s) return null;
  const cleaned = s
    .replace(/\b(ltd|llc|inc|gmbh|kft|zrt|rt|plc|corp|co)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

export function tokenizeTitle(normTitle: string): string[] {
  const toks = normTitle
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && t.length <= 32)
    .filter((t) => !STOPWORDS.has(t));
  // Dedup but preserve order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of toks) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function titleTokenSimilarity(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union <= 0 ? 0 : inter / union;
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function popcnt32(x: number): number {
  // Hacker's Delight popcount
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function hammingDistance64Hex(aHex: string, bHex: string): number {
  const a = (aHex ?? "").trim().toLowerCase().padStart(16, "0");
  const b = (bHex ?? "").trim().toLowerCase().padStart(16, "0");
  if (!/^[0-9a-f]{16}$/.test(a) || !/^[0-9a-f]{16}$/.test(b)) return 64;
  const aHi = Number.parseInt(a.slice(0, 8), 16) >>> 0;
  const aLo = Number.parseInt(a.slice(8), 16) >>> 0;
  const bHi = Number.parseInt(b.slice(0, 8), 16) >>> 0;
  const bLo = Number.parseInt(b.slice(8), 16) >>> 0;
  return popcnt32((aHi ^ bHi) >>> 0) + popcnt32((aLo ^ bLo) >>> 0);
}

export function simhash64HexFromTokens(tokens: string[]): string {
  // 64-bit simhash using two 32-bit lanes (hi/lo).
  const v = new Array<number>(64).fill(0);
  for (const t of tokens) {
    // Cheap 64-bit-ish hash: two independent FNV32 lanes.
    const h1 = fnv1a32(t);
    const h2 = fnv1a32(`${t}|2`);
    for (let bit = 0; bit < 32; bit += 1) {
      v[bit] += (h1 & (1 << bit)) !== 0 ? 1 : -1;
    }
    for (let bit = 0; bit < 32; bit += 1) {
      v[32 + bit] += (h2 & (1 << bit)) !== 0 ? 1 : -1;
    }
  }

  let hi = 0;
  let lo = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if (v[bit] > 0) lo |= 1 << bit;
    if (v[32 + bit] > 0) hi |= 1 << bit;
  }
  const hiHex = (hi >>> 0).toString(16).padStart(8, "0");
  const loHex = (lo >>> 0).toString(16).padStart(8, "0");
  return `${hiHex}${loHex}`;
}

function normalizeDescriptionForSimhash(raw: string): string {
  // Keep it cheap: strip to alnum, collapse whitespace, cap size.
  return normalizeTextBase(raw).slice(0, 6000);
}

export function computeDupeSignals(job: Pick<DiscoveredJob, "title" | "company" | "description">): DupeSignals {
  const normTitle = normalizeTitle(job.title ?? "");
  const normCompany = normalizeCompany(job.company);
  const titleTokens = tokenizeTitle(normTitle);
  const descTokens = normalizeDescriptionForSimhash(job.description ?? "").split(" ").filter((t) => t.length >= 3);
  const combined = [...titleTokens, ...descTokens.slice(0, 180)];
  const simhash64_hex = simhash64HexFromTokens(combined.length > 0 ? combined : titleTokens);
  return { normTitle, normCompany, titleTokens, simhash64_hex };
}

