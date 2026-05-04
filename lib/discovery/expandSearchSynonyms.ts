// lib/discovery/expandSearchSynonyms.ts — Ollama-backed synonym phrases per user keyword (soft fallback).
import { generateJsonWithOllama } from "../llm/ollama";
import { uniquePhrasesPreserveOrder } from "./searchKeywords";

type KwRow = { keyword?: string; synonyms?: string[]; hungarian?: string[] };
type SynonymPayload = { by_keyword?: KwRow[] };

const EMPTY: SynonymPayload = { by_keyword: [] };

function looksMostlyLatinAscii(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  const hu = t.replace(/[\s0-9.,;:_\-/+#'"()]/g, "");
  if (!hu) return false;
  let ascii = 0;
  for (const ch of hu) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
  }
  return ascii / hu.length > 0.65;
}

/**
 * Uses local Ollama to add synonyms per keyword plus 1–2 Hungarian job-title equivalents when the
 * keyword is primarily English/Latin (Hungarian market optimization for Profession.hu & local boards).
 */
export async function expandDiscoveryPhrasesWithOllama(
  baseKeywords: string[],
  model: string,
): Promise<string[]> {
  const bases = baseKeywords.map((k) => k.trim()).filter(Boolean);
  if (bases.length === 0) return ["developer"];

  const prompt = `You help job-board discovery in Hungary and internationally.

For each keyword below:
1) Propose 2–3 short alternative job-title search phrases (synonyms or closely related role titles). Same language as the keyword when sensible. Max 72 characters each.
2) If the keyword is primarily English (Latin letters, typical international job English), also add exactly 1–2 Hungarian job-title search equivalents that Hungarian job sites use (e.g. Presales → "Műszaki értékesítő", Solution Architect → "Rendszertervező" or "IT architekt"). If the keyword is already mostly Hungarian, set hungarian to [].

Keywords JSON: ${JSON.stringify(bases)}

Return ONLY valid JSON of this exact shape:
{"by_keyword":[{"keyword":"<exact string from input>","synonyms":["..."],"hungarian":["..."]}]}

Include one object per input keyword; "keyword" must match the input string exactly.`;

  const { data, source } = await generateJsonWithOllama<SynonymPayload>(prompt, EMPTY, {
    model,
    role: "analysis",
    num_predict: 1200,
    temperature: 0.15,
  });

  const rows = Array.isArray(data.by_keyword) ? data.by_keyword : [];
  const ordered: string[] = [];

  for (let i = 0; i < bases.length; i += 1) {
    const bk = bases[i];
    ordered.push(bk);
    const row =
      rows.find(
        (r) => typeof r.keyword === "string" && r.keyword.trim().toLowerCase() === bk.toLowerCase(),
      ) ?? (i < rows.length ? rows[i] : undefined);
    const syns = Array.isArray(row?.synonyms) ? row.synonyms : [];
    for (const s of syns) {
      if (typeof s === "string" && s.trim()) ordered.push(s.trim().slice(0, 120));
    }
    const hu = Array.isArray(row?.hungarian) ? row.hungarian : [];
    if (looksMostlyLatinAscii(bk)) {
      for (const h of hu) {
        if (typeof h === "string" && h.trim()) ordered.push(h.trim().slice(0, 120));
      }
    }
  }

  const merged = uniquePhrasesPreserveOrder(ordered);
  if (source === "fallback" && merged.length <= bases.length) {
    return uniquePhrasesPreserveOrder(bases);
  }
  return merged.length > 0 ? merged : bases;
}
