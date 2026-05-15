// lib/domain/skillSynonyms.ts
import { SEMANTIC_SCORER_SYNONYM_PROMPT_LIMITS } from "../../config/constants";

/** JSON array of {from,to} for the semantic scorer — capped by pair count and field length so the string is never truncated mid-object. */
export function serializeSynonymPairsForPrompt(
  pairs: ReadonlyArray<{ from: string; to: string }>,
): string {
  const { maxPairs, maxFieldChars } = SEMANTIC_SCORER_SYNONYM_PROMPT_LIMITS;
  const trimmed = pairs.slice(0, maxPairs).map(({ from, to }) => {
    const f = from.trim();
    const t = to.trim();
    return {
      from: f.length > maxFieldChars ? `${f.slice(0, maxFieldChars)}…` : f,
      to: t.length > maxFieldChars ? `${t.slice(0, maxFieldChars)}…` : t,
    };
  });
  return JSON.stringify(trimmed);
}

/** Build lookup: normalized alias (lowercase trim) → canonical skill token (lowercase). */
export function buildSkillSynonymMap(
  pairs: ReadonlyArray<{ from: string; to: string }>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const { from, to } of pairs) {
    const a = from.trim().toLowerCase();
    const c = to.trim().toLowerCase();
    if (!a || !c) continue;
    m.set(a, c);
  }
  return m;
}

/** Apply synonym canonicalization; dedupe by canonical form. */
export function applySkillSynonyms(skills: string[], synonymMap: Map<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of skills) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    const canon = (synonymMap.get(key) ?? key).trim().toLowerCase();
    if (!canon || seen.has(canon)) continue;
    seen.add(canon);
    out.push(canon);
  }
  return out;
}
