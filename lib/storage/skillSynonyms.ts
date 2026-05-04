// lib/storage/skillSynonyms.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SKILL_SYNONYM_SUGGEST_LIMITS } from "../../config/constants";

const STORAGE_DIR = path.join(process.cwd(), "storage");
const SKILL_SYNONYMS_PATH = path.join(STORAGE_DIR, "skill_synonyms.json");

export type SkillSynonymPair = { from: string; to: string };

export type StoredSkillSynonyms = {
  pairs: SkillSynonymPair[];
  /** LLM-proposed pairs awaiting user approval (not used by pipeline until approved). */
  pending_suggestions: SkillSynonymPair[];
  updated_at: string;
};

const EMPTY: StoredSkillSynonyms = {
  pairs: [],
  pending_suggestions: [],
  updated_at: new Date(0).toISOString(),
};

function parsePairList(raw: unknown): SkillSynonymPair[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillSynonymPair[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const from = typeof r.from === "string" ? r.from.trim() : "";
    const to = typeof r.to === "string" ? r.to.trim() : "";
    if (!from || !to) continue;
    out.push({ from, to });
  }
  return out;
}

function pairKey(from: string, to: string): string {
  return `${from.trim().toLowerCase()}|${to.trim().toLowerCase()}`;
}

export async function loadSkillSynonymsFromStorage(): Promise<StoredSkillSynonyms> {
  try {
    const content = await readFile(SKILL_SYNONYMS_PATH, "utf-8");
    const parsed = JSON.parse(content) as Partial<StoredSkillSynonyms>;
    const pairs = parsePairList(parsed.pairs);
    const pending_suggestions = parsePairList(parsed.pending_suggestions);
    return {
      pairs,
      pending_suggestions,
      updated_at:
        typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function saveSkillSynonymsToStorage(data: StoredSkillSynonyms): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
  const normalized: StoredSkillSynonyms = {
    pairs: data.pairs.slice(0, 200),
    pending_suggestions: data.pending_suggestions.slice(0, SKILL_SYNONYM_SUGGEST_LIMITS.maxPendingStored),
    updated_at: data.updated_at,
  };
  await writeFile(SKILL_SYNONYMS_PATH, JSON.stringify(normalized, null, 2), "utf-8");
}

/** Append new pending suggestions; dedupes against existing pairs and pending. Returns new pending count. */
export async function appendPendingSynonymSuggestions(
  incoming: SkillSynonymPair[],
): Promise<{ pending_count: number; added: number }> {
  const cur = await loadSkillSynonymsFromStorage();
  const used = new Set<string>();
  for (const p of cur.pairs) used.add(pairKey(p.from, p.to));
  for (const p of cur.pending_suggestions) used.add(pairKey(p.from, p.to));

  let added = 0;
  const nextPending = [...cur.pending_suggestions];
  for (const p of incoming) {
    const k = pairKey(p.from, p.to);
    if (used.has(k)) continue;
    used.add(k);
    nextPending.push({ from: p.from.trim(), to: p.to.trim() });
    added += 1;
    if (nextPending.length >= SKILL_SYNONYM_SUGGEST_LIMITS.maxPendingStored) break;
  }

  await saveSkillSynonymsToStorage({
    pairs: cur.pairs,
    pending_suggestions: nextPending,
    updated_at: new Date().toISOString(),
  });
  return { pending_count: nextPending.length, added };
}

export async function approvePendingSynonymIndices(indices: number[]): Promise<StoredSkillSynonyms> {
  const cur = await loadSkillSynonymsFromStorage();
  const idxSet = new Set(indices.filter((i) => Number.isInteger(i) && i >= 0));
  if (idxSet.size === 0) return cur;

  const toMove: SkillSynonymPair[] = [];
  const stay: SkillSynonymPair[] = [];
  for (let i = 0; i < cur.pending_suggestions.length; i += 1) {
    if (idxSet.has(i)) toMove.push(cur.pending_suggestions[i]);
    else stay.push(cur.pending_suggestions[i]);
  }

  const pairKeys = new Set(cur.pairs.map((p) => pairKey(p.from, p.to)));
  const mergedPairs = [...cur.pairs];
  for (const p of toMove) {
    const k = pairKey(p.from, p.to);
    if (!pairKeys.has(k)) {
      pairKeys.add(k);
      mergedPairs.push({ from: p.from.trim(), to: p.to.trim() });
    }
  }

  const next: StoredSkillSynonyms = {
    pairs: mergedPairs.slice(0, 200),
    pending_suggestions: stay.slice(0, SKILL_SYNONYM_SUGGEST_LIMITS.maxPendingStored),
    updated_at: new Date().toISOString(),
  };
  await saveSkillSynonymsToStorage(next);
  return next;
}

export async function approveAllPendingSynonyms(): Promise<StoredSkillSynonyms> {
  const cur = await loadSkillSynonymsFromStorage();
  const indices = cur.pending_suggestions.map((_, i) => i);
  return approvePendingSynonymIndices(indices);
}

export async function dismissPendingSynonymIndices(indices: number[]): Promise<StoredSkillSynonyms> {
  const cur = await loadSkillSynonymsFromStorage();
  const idxSet = new Set(indices.filter((i) => Number.isInteger(i) && i >= 0));
  if (idxSet.size === 0) return cur;
  const stay = cur.pending_suggestions.filter((_, i) => !idxSet.has(i));
  const next: StoredSkillSynonyms = {
    ...cur,
    pending_suggestions: stay,
    updated_at: new Date().toISOString(),
  };
  await saveSkillSynonymsToStorage(next);
  return next;
}

export async function dismissAllPendingSynonyms(): Promise<StoredSkillSynonyms> {
  const cur = await loadSkillSynonymsFromStorage();
  const next: StoredSkillSynonyms = {
    ...cur,
    pending_suggestions: [],
    updated_at: new Date().toISOString(),
  };
  await saveSkillSynonymsToStorage(next);
  return next;
}
