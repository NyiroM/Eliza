// lib/parsers/cvEvidencePass.ts
import { generateJsonWithOllamaStrict } from "../llm/ollama";
import { CV_EVIDENCE_PASS_LIMITS } from "../../config/constants";

export type CvEvidencePassResult = {
  /** Required skills the CV text explicitly supports (lowercase). */
  confirmed_skills: string[];
  source: "llm" | "skipped";
};

/**
 * Short second pass: given baseline missing required skills, ask whether CV_TEXT
 * clearly evidences each (synonyms OK). Keeps max_tokens bounded via small list slice.
 */
export async function runCvMissingSkillsEvidencePass(params: {
  cvText: string;
  missingRequiredSkills: string[];
  model: string;
}): Promise<CvEvidencePassResult> {
  const missing = [...new Set(params.missingRequiredSkills.map((s) => s.trim().toLowerCase()))]
    .filter(Boolean)
    .slice(0, CV_EVIDENCE_PASS_LIMITS.maxMissingSkills);
  if (missing.length === 0) {
    return { confirmed_skills: [], source: "skipped" };
  }

  const cvSlice = params.cvText.slice(0, CV_EVIDENCE_PASS_LIMITS.cvTextChars);

  const prompt = `Return STRICT JSON only with keys in this order:
{"evidence_rationale":string,"confirmed_skills":string[]}

- evidence_rationale: 1-2 English sentences on how you scanned the CV for explicit mentions only.
- confirmed_skills: subset of MISSING_REQUIRED (below), lowercase, only skills clearly stated or clearly implied by the same tool/stack in CV_TEXT (e.g. job bullet "Built React dashboards" confirms "react"). Max ${missing.length} entries. If none: [].
- No extra keys. No markdown.

MISSING_REQUIRED: ${JSON.stringify(missing)}

CV_TEXT:
${cvSlice}`;

  type Payload = { evidence_rationale?: string; confirmed_skills?: unknown };
  const data = await generateJsonWithOllamaStrict<Payload>(prompt, {
    model: params.model,
    role: "extract_cv",
  });

  const raw = data.confirmed_skills;
  const allowed = new Set(missing);
  const confirmed: string[] = [];
  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (typeof x !== "string") continue;
      const s = x.trim().toLowerCase();
      if (s && allowed.has(s) && !confirmed.includes(s)) confirmed.push(s);
    }
  }
  return { confirmed_skills: confirmed, source: "llm" };
}
