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
  /** User profile lines; explicit claims can confirm MISSING_REQUIRED same as CV_TEXT. */
  constraints?: string[];
}): Promise<CvEvidencePassResult> {
  const missing = [...new Set(params.missingRequiredSkills.map((s) => s.trim().toLowerCase()))]
    .filter(Boolean)
    .slice(0, CV_EVIDENCE_PASS_LIMITS.maxMissingSkills);
  if (missing.length === 0) {
    return { confirmed_skills: [], source: "skipped" };
  }

  const cvSlice = params.cvText.slice(0, CV_EVIDENCE_PASS_LIMITS.cvTextChars);
  const constraintLines = (params.constraints ?? []).map((s) => s.trim()).filter(Boolean);
  const constraintsJson =
    constraintLines.length > 0
      ? JSON.stringify(constraintLines).slice(0, CV_EVIDENCE_PASS_LIMITS.constraintsJsonMaxChars)
      : "";
  const constraintsBlock =
    constraintsJson.length > 0
      ? `CONSTRAINTS (user profile — explicit ownership claims here may confirm MISSING_REQUIRED when the wording clearly states the candidate has/holds/is certified in/willing to use that capability; map to the exact MISSING_REQUIRED token):
${constraintsJson}`
      : "";

  const prompt = `Return STRICT JSON only with keys in this order:
{"evidence_rationale":string,"confirmed_skills":string[]}

- evidence_rationale: 1-2 English sentences on how you scanned CV_TEXT${constraintsBlock ? " and CONSTRAINTS" : ""} for explicit mentions only.
- confirmed_skills: subset of MISSING_REQUIRED (below), lowercase. Include a token only if (a) CV_TEXT clearly states or clearly implies it by the same tool/stack (e.g. job bullet "Built React dashboards" confirms "react"), OR (b) CONSTRAINTS explicitly claim the same capability with clear ownership (e.g. "I have react", "Category B driving licence", "fluent english", "certified in SAP") and the token aligns with a MISSING_REQUIRED entry (normalize spelling to the MISSING_REQUIRED string). Max ${missing.length} entries. If none: [].
- No extra keys. No markdown.

MISSING_REQUIRED: ${JSON.stringify(missing)}

${constraintsBlock ? `${constraintsBlock}\n\n` : ""}CV_TEXT:
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
