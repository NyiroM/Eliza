// lib/skillSynonyms/suggestFromCv.ts
import { generateJsonWithOllama } from "../llm/ollama";
import { DEFAULT_OLLAMA_MODEL, SKILL_SYNONYM_SUGGEST_LIMITS } from "../../config/constants";
import type { SkillSynonymPair } from "../storage/skillSynonyms";

type SuggestPayload = {
  rationale?: string;
  suggested_pairs?: unknown;
};

/** Compact key for matching (ignore spaces, hyphens, dots). */
function compactSkillKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Aligns `to` with SKILLS_LIST when compact strings match; drops obvious run-on `to` values
 * (no word breaks while `from` has phrases) when no list match exists.
 */
function alignSynonymTo(fromRaw: string, toRaw: string, skills: readonly string[]): string | null {
  const fromLc = fromRaw.trim().toLowerCase().replace(/\s+/g, " ");
  const to = toRaw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!fromLc || !to) return null;

  const indexed = skills.map((s) => {
    const raw = s.trim().toLowerCase().replace(/\s+/g, " ");
    return { raw, c: compactSkillKey(s) };
  });

  const toC = compactSkillKey(to);
  for (const { raw, c } of indexed) {
    if (c && c === toC) return raw;
  }
  const fromC = compactSkillKey(fromLc);
  for (const { raw, c } of indexed) {
    if (c && c === fromC) return raw;
  }

  const fromHasWordBreak = /[\s-]/.test(fromRaw.trim());
  const toHasWordBreak = /[\s.-]/.test(to);
  const looksConcatenated =
    fromHasWordBreak &&
    !toHasWordBreak &&
    to.replace(/\./g, "").length >= 8;

  if (looksConcatenated) return null;

  return to;
}

function sanitizeSuggestedPairs(
  raw: unknown,
  max: number,
  skills: readonly string[],
): SkillSynonymPair[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillSynonymPair[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const from = typeof r.from === "string" ? r.from.trim() : "";
    const toRaw = typeof r.to === "string" ? r.to.trim() : "";
    if (!from || !toRaw || from.length > 120 || toRaw.length > 120) continue;
    const to = alignSynonymTo(from, toRaw, skills);
    if (to === null) continue;
    if (from.toLowerCase().replace(/\s+/g, " ") === to) continue;
    out.push({ from, to });
    if (out.length >= max) break;
  }
  return out;
}

export type CvSynonymSuggestResult = {
  pairs: SkillSynonymPair[];
  /** Short model explanation for the UI (may be empty). */
  rationale: string;
};

/**
 * Propose alias → canonical skill pairs grounded in CV text and the extracted skills list
 * (for pending user approval; not applied until merged into storage).
 */
export async function suggestSkillSynonymPairsFromCv(params: {
  cvText: string;
  skills: string[];
  model: string;
}): Promise<CvSynonymSuggestResult> {
  const model = params.model.trim() || DEFAULT_OLLAMA_MODEL;
  const slice = params.cvText.slice(0, SKILL_SYNONYM_SUGGEST_LIMITS.cvTextChars);
  const skillsJson = JSON.stringify(params.skills.slice(0, 80));
  const max = SKILL_SYNONYM_SUGGEST_LIMITS.maxPairsFromLlm;

  const prompt = `Return STRICT JSON only with keys in this order:
{"rationale":string,"suggested_pairs":Array<{from:string,to:string}>}

Task: suggest up to ${max} skill synonym pairs for ATS/job matching.
Each pair:
- "from" = spelling or phrase as it appears in CV_TEXT (may include spaces, e.g. "Machine Vision", "FPV drone").
- "to" = canonical skill phrase in the SAME style as SKILLS_LIST: lowercase, use ASCII spaces BETWEEN words (e.g. "machine vision", "react", "node.js"). Never glue separate words into one run-on string (wrong: "machinevision", "internetprotocolvideo"; right: "machine vision", "ip video" or another spaced phrase that matches SKILLS_LIST when possible).
Rules:
- Whenever possible set "to" to the exact string of the matching skill from SKILLS_LIST (same wording, lowercase).
- Ground every pair in CV_TEXT or SKILLS_LIST evidence; do not invent tools not present.
- Prefer common variants (abbreviations, dots, version-less form) that map to one canonical skill phrase.
- "from" and "to" must differ when compared case-insensitively with spaces normalized.
- If nothing useful: suggested_pairs [].
- English skill tokens preferred for "to".

SKILLS_LIST: ${skillsJson}

CV_TEXT:
${slice}`;

  const fallback: SuggestPayload = { rationale: "", suggested_pairs: [] };
  const llm = await generateJsonWithOllama<SuggestPayload>(prompt, fallback, {
    model,
    role: "extract_cv",
    num_predict: 2048,
  });
  const rationaleRaw =
    typeof llm.data?.rationale === "string" ? llm.data.rationale.trim().slice(0, 600) : "";
  return {
    pairs: sanitizeSuggestedPairs(llm.data?.suggested_pairs, max, params.skills),
    rationale: rationaleRaw,
  };
}
