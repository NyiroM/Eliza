// lib/prompts/semanticFitScoreReviewPrompt.ts
// Shared user prompt for semantic fit LLM review (same text as production `semanticFitScoreReviewWithLlm`).

import { SEMANTIC_SCORER_PROMPT_LIMITS } from "../../config/constants";
import type { FitScoreResult } from "../../types/scoring";
import type { StoredConstraintTactics } from "../storage/constraintTactics";

function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
    : [];
}

export type SemanticFitJobStructForPrompt = {
  required_skills: string[];
  optional_skills: string[];
  required_seniority: string;
  experience_years: number | null;
  education: string | null;
};

export type BuildSemanticFitScoreReviewPromptParams = {
  constraints: string[];
  preferredLocation: string | null;
  jobTextEnglish: string;
  combinedJobText: string;
  jobBoardMetadata: Record<string, unknown>;
  jobStructForScorer: SemanticFitJobStructForPrompt;
  cvSkills: string[];
  coreStories: string[];
  cvSnippet: string;
  baseline: FitScoreResult;
  constraintHints: string[];
  tactics: StoredConstraintTactics;
  skillSynonymsPromptJson: string;
};

/**
 * Builds the exact user prompt sent to Ollama for semantic fit scoring (production parity).
 */
export function buildSemanticFitScoreReviewPrompt(params: BuildSemanticFitScoreReviewPromptParams): string {
  const preferredLocJson = JSON.stringify(params.preferredLocation ?? "");

  const metaNote =
    "benefits" in params.jobBoardMetadata || "commitments" in params.jobBoardMetadata
      ? ""
      : " (benefits/commitments omitted from metadata JSON to save tokens — not referenced in user constraints).";

  const missing = strList(params.baseline.missing_skills ?? []);
  const missingLower = [...new Set(missing.map((s) => s.toLowerCase()))].sort();
  const cvSkillsSet = new Set((params.baseline.matched_skills ?? []).map((s) => s.toLowerCase()));
  const requiredSkillsSet = new Set(missingLower);
  const irrelevantExtraSkills: string[] = [];
  for (const cvSkill of cvSkillsSet) {
    if (!requiredSkillsSet.has(cvSkill)) {
      irrelevantExtraSkills.push(cvSkill);
    }
  }
  irrelevantExtraSkills.sort();

  return `Task: fit JSON only. Output keys in this exact order (logic and veto before narrative):
vetoed, veto_reason, score_components, fit_score, mathematical_breakdown, one_sentence_summary, narrative_summary, matched_skills, missing_skills, irrelevant_extra_skills, interview_prep, seniority_match, metadata_fit_badge, vibe_warnings, semantic_highlights
All strings EN.

CRITICAL_GAPS: ${JSON.stringify(missingLower)}.
TRANSFERABLE_SKILLS (unused superpowers): ${JSON.stringify(irrelevantExtraSkills)}.

CONSTRAINT_TACTICS (per-domain): ${JSON.stringify(params.tactics.tactics)}. Keys: location | remote_zone | compensation. Values: default | strong_preference. For strong_preference on a domain, never set vetoed=true for clashes that are only about that domain — apply a large negative constraint_delta (typically -15..-40) instead. default = normal veto rules.
USER_SKILL_SYNONYMS (server already canonicalized lists; use for narrative and gap notes only): ${params.skillSynonymsPromptJson}

VETO (decide first): vetoed=true on any hard constraint clash (e.g. user bans a country/region and the job is based there, OR user explicitly excludes a required skill), subject to CONSTRAINT_TACTICS. fit_score=0, score_components all 0, veto_reason one clear EN sentence naming the exact conflict; veto_reason MUST include a short quoted substring from JOB_TEXT or CONSTRAINTS (ASCII double quotes) proving the clash. breakdown ends Final Score: 0%. Else vetoed=false.

score_components (REQUIRED when vetoed=false): {base_semantic:int, skill_overlap_delta:int, experience_delta:int, constraint_delta:int, advantage_bonus:int}. Integers. Formula: fit_score = clamp(round(base_semantic + skill_overlap_delta + experience_delta + constraint_delta + advantage_bonus), 0, 100). advantage_bonus >= 0. You MUST set fit_score exactly equal to that sum after clamp.

one_sentence_summary: In addition to mathematical_breakdown, provide one concise English sentence for the user naming the single most important factor (e.g. "Great skill match but rejected due to contract type" or "Perfect seniority and location match"). This is not the math — it is the human headline.

semantic_highlights: 3-5 of {phrase,sentiment:"positive"|"negative",reason}. phrase = exact copy from JOB_TEXT below (short). Pick phrases that moved score most.

CRITICAL GAPS & TRANSFERABLE SKILLS: For each missing_skill, if the candidate has highly adjacent skills (e.g., missing "Scripting" but has "System Integration" or "R&D"), include a short note in the reason field: "Transferable from [adjacent skill] background". Do NOT move such skills to irrelevant_extra_skills; keep them in missing_skills with the note.

PREF_LOC_JSON: ${preferredLocJson} — non-empty: soft +2..+12 if align; empty: neutral unless constraints ban region.
JOB_STRUCT (from extraction — use for experience_delta, seniority_match, and advantage_bonus; advantage_bonus only for CV evidence vs optional_skills; do not invent skills): ${JSON.stringify(params.jobStructForScorer)}
Optional skills (JOB_STRUCT.optional_skills): bonus only in advantage_bonus, never penalty in missing_skills.
matched_skills/missing_skills: required-only; EN tokens OK. Stay aligned with BASELINE m/m: at most 2 additions and 2 removals per list versus baseline matched_skills and baseline missing_skills; every add/remove must be justified by an exact span from JOB_TEXT (cite briefly in mathematical_breakdown lines 2–3). If unsure, keep the same tokens as BASELINE (lowercased).
vibe_warnings: [] or short EN flags (vague pay, crunch, etc.).
fit_score MUST equal the clamped sum of score_components and MUST match line 7 of mathematical_breakdown.
Do NOT infer social isolation from a city name alone. "Work with people" is a social/role preference, not a location conflict, unless role is explicitly solitary (e.g., forest ranger, lighthouse keeper).

JOB_METADATA${metaNote}: ${JSON.stringify({ ...params.jobBoardMetadata, optional_skills: params.jobStructForScorer.optional_skills })}
CONSTRAINTS: ${JSON.stringify(params.constraints)} HINTS: ${JSON.stringify(params.constraintHints)}

LOGISTICS_AND_PHYSICAL_REQUIREMENTS (common-sense deduction): When the job posting states a physical or logistical requirement (examples: willingness to travel, driving licence, mobility, frequent site visits, on-site presence, regional coverage), apply normal professional inference from the CV. If past job titles and concrete duties strongly imply the requirement is met — e.g. area sales, field service, on-site commissioning, multi-site or multi-region delivery work when the posting expects travel or driving — treat that requirement as satisfied for scoring. Do not apply negative constraint_delta and do not keep the item in missing_skills solely because an exact keyword (e.g. "driving licence") is absent when the employment history clearly establishes equivalent capability. Cite the implied pattern briefly in mathematical_breakdown / narrative instead of treating it as a hard gap.

CV_SKILLS: ${JSON.stringify(params.cvSkills)} CV_STORIES: ${JSON.stringify(params.coreStories.slice(0, 6))}
CV_PRUNED:
${params.cvSnippet.slice(0, SEMANTIC_SCORER_PROMPT_LIMITS.cvSnippetChars)}
BASELINE m/m: ${JSON.stringify(params.baseline.matched_skills)}/${JSON.stringify(params.baseline.missing_skills)} sen_lit:${params.baseline.seniority_match}
JOB_TEXT:
${params.jobTextEnglish.slice(0, SEMANTIC_SCORER_PROMPT_LIMITS.jobTextChars)}
JOB_MIX:
${params.combinedJobText.slice(0, SEMANTIC_SCORER_PROMPT_LIMITS.jobMixChars)}

mathematical_breakdown — REQUIRED 7 lines, EXACT prefixes in order:
1) Base Skill Match Score (required-only semantic overlap): <n>
2) Skill Overlap: +/-X% (Matched: ...; Missing: ... or Missing: none)
3) Experience Match: +/-Y% (<reason>)
4) Constraint Adjustments (location, job type, work model): +/-Z% (<reasons>)
5) Advantage Bonuses (optional / nice-to-have only): +W%
6) Arithmetic: a + b - c ... = N (0-100 clamp)
7) Final Score: N%  (N===fit_score===sum(score_components))

metadata_fit_badge: "Location Conflict"|"Preference Match"|null
JSON only.`;
}
