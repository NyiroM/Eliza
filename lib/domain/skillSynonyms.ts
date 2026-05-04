// lib/domain/skillSynonyms.ts
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
