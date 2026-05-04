// lib/discovery/searchKeywords.ts — comma split, dedupe, and phrase-widening ladder for discovery fetches.
/** Split discovery search box by commas; trim and drop empties. */
export function splitCommaSearchKeywords(raw: string): string[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [raw.trim() || "developer"];
}

/** Dedupe case-insensitive while preserving order. */
export function uniquePhrasesPreserveOrder(phrases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of phrases) {
    const t = p.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Broadening ladder: drop trailing tokens one at a time (e.g. "Solution Architect AI" →
 * "Solution Architect" → "Solution") so guest APIs can retry with shorter queries.
 */
export function buildWideningLadder(phrase: string): string[] {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out: string[] = [];
  for (let n = words.length; n >= 1; n -= 1) {
    const s = words.slice(0, n).join(" ");
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export function truncateHint(s: string, max = 220): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
