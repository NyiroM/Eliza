// lib/discovery/keywordSync.ts — manual + approved suggestions only (no Ollama during sync).
import type { DiscoveryKeywordSuggestion, DiscoverySettings } from "../../types/discovery";
import { uniquePhrasesPreserveOrder } from "./searchKeywords";

export function normalizeKeywordPhrase(s: string): string {
  return s.normalize("NFC").trim();
}

export function sanitizeKeywordSuggestions(raw: unknown): DiscoveryKeywordSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: DiscoveryKeywordSuggestion[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const o = row as { phrase?: unknown; status?: unknown; source_keyword?: unknown };
    const phrase = typeof o.phrase === "string" ? normalizeKeywordPhrase(o.phrase).slice(0, 160) : "";
    if (!phrase) continue;
    const st = o.status;
    const status: DiscoveryKeywordSuggestion["status"] =
      st === "approved" || st === "rejected" || st === "suggested" ? st : "suggested";
    const source_keyword =
      typeof o.source_keyword === "string" ? normalizeKeywordPhrase(o.source_keyword).slice(0, 160) : undefined;
    out.push({ phrase, status, ...(source_keyword ? { source_keyword } : {}) });
  }
  return out.slice(0, 100);
}

/** Append an approved AI phrase into the comma-separated search box (deduped). */
export function mergeApprovedPhraseIntoSearchKeywords(currentSearchKeywords: string, phrase: string): string {
  const normalized = normalizeKeywordPhrase(phrase);
  if (!normalized) return currentSearchKeywords;
  const existing = currentSearchKeywords
    .split(",")
    .map((s) => normalizeKeywordPhrase(s))
    .filter((s) => s.length > 0);
  const merged = uniquePhrasesPreserveOrder([...existing, normalized]);
  return merged.join(", ");
}

/** Merge legacy `approved` rows into the search box and drop them from the list (in-memory; persists on next save). */
export function migrateApprovedSuggestionsIntoSearchKeywords(settings: DiscoverySettings): DiscoverySettings {
  const list = settings.keyword_suggestions ?? [];
  const approved = list.filter((s) => s.status === "approved");
  if (approved.length === 0) return settings;
  let search_keywords = settings.search_keywords ?? "";
  for (const row of approved) {
    search_keywords = mergeApprovedPhraseIntoSearchKeywords(search_keywords, row.phrase);
  }
  const keyword_suggestions = list.filter((s) => s.status !== "approved");
  return { ...settings, search_keywords, keyword_suggestions };
}

/** Phrases used for discovery fetch: comma-split search keywords box only. */
export function getKeywordsForSync(settings: DiscoverySettings): string[] {
  const manualRaw = settings.search_keywords?.trim() ?? "";
  const manualParts = manualRaw
    .split(",")
    .map((s) => normalizeKeywordPhrase(s))
    .filter((s) => s.length > 0);
  return uniquePhrasesPreserveOrder(manualParts);
}
