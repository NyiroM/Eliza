// lib/cvSkills/suggestExtraSkillsFromCv.ts
import { CV_SKILL_SUGGEST_LIMITS, DEFAULT_OLLAMA_MODEL } from "../../config/constants";
import { generateJsonWithOllama } from "../llm/ollama";

type Payload = {
  rationale?: string;
  suggested_skills?: unknown;
};

function sanitizeSkillPhrases(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const t = item
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, CV_SKILL_SUGGEST_LIMITS.maxPhraseChars);
    if (!t) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

export type CvExtraSkillsSuggestResult = {
  phrases: string[];
  rationale: string;
};

/**
 * Propose additional technical skills grounded in CV text and not already in CURRENT_SKILLS.
 */
export async function suggestExtraSkillsFromCv(params: {
  cvText: string;
  currentSkills: readonly string[];
  model: string;
}): Promise<CvExtraSkillsSuggestResult> {
  const model = params.model.trim() || DEFAULT_OLLAMA_MODEL;
  const slice = params.cvText.slice(0, CV_SKILL_SUGGEST_LIMITS.cvTextChars);
  const skillsJson = JSON.stringify([...params.currentSkills].slice(0, 80));
  const max = CV_SKILL_SUGGEST_LIMITS.maxFromLlm;

  const prompt = `Return STRICT JSON only with keys in this order:
{"rationale":string,"suggested_skills":string[]}

Task: suggest up to ${max} additional technical skills for job matching.
Rules:
- Each string: lowercase, ASCII words separated by single spaces (e.g. "kubernetes", "machine learning", "node.js").
- Only skills clearly supported by CV_TEXT evidence or strongly implied adjacent to stated work; do not invent unrelated tools.
- Do not repeat anything in CURRENT_SKILLS (case-insensitive).
- Prefer concise tokens; no sentences, no buzzwords without technical meaning.
- If nothing defensible: suggested_skills [].

CURRENT_SKILLS: ${skillsJson}

CV_TEXT:
${slice}`;

  const fallback: Payload = { rationale: "", suggested_skills: [] };
  const llm = await generateJsonWithOllama<Payload>(prompt, fallback, {
    model,
    role: "extract_cv",
    num_predict: 1536,
  });
  const rationaleRaw =
    typeof llm.data?.rationale === "string" ? llm.data.rationale.trim().slice(0, 600) : "";
  return {
    phrases: sanitizeSkillPhrases(llm.data?.suggested_skills, max),
    rationale: rationaleRaw,
  };
}
