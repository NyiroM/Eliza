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

/** Server-computed facts prepended to the scorer prompt so the model does not re-infer years/location from prose alone. */
export type SemanticFitDecisionBrief = {
  job_location: string | null;
  /** Dashboard job-search geography (same as PREF_LOC_JSON); compare to job_location for tactic-driven veto vs soft penalty. */
  preferred_work_location: string | null;
  work_model: string;
  job_type: string;
  job_experience_years: number | null;
  candidate_experience_years_hint: number | null;
  baseline_fit_score: number;
  constraints_count: number;
};

export type BuildSemanticFitScoreReviewPromptParams = {
  constraints: string[];
  preferredLocation: string | null;
  decisionBrief: SemanticFitDecisionBrief;
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

DECISION_BRIEF (server-computed — trust for experience_delta, location/work_model framing, preferred_work_location vs job_location geography check, and baseline numeric anchor; do not contradict job_experience_years or baseline_fit_score unless you cite JOB_TEXT/CONSTRAINTS evidence): ${JSON.stringify(params.decisionBrief)}

CRITICAL_GAPS: ${JSON.stringify(missingLower)}.
TRANSFERABLE_SKILLS (unused superpowers): ${JSON.stringify(irrelevantExtraSkills)}.

CONSTRAINTS_VS_CRITICAL_GAPS (mandatory): Before final missing_skills, narrative_summary, one_sentence_summary, or semantic_highlights, re-read CONSTRAINTS. If the user explicitly satisfies a requirement listed in CRITICAL_GAPS (e.g. Category B / driving licence / license, languages, certifications, work authorization, willingness to travel or relocate), treat it as met: remove that token from output missing_skills when allowed by the ≤2-removals-from-BASELINE rule; cite a short quoted substring from CONSTRAINTS in mathematical_breakdown line 2. Never describe that item as the main weakness or "critical gap". When CONSTRAINTS and CRITICAL_GAPS conflict, CONSTRAINTS win.

CONSTRAINT_ORDER_FOR_CLASHES: For veto and gap wording use this order: (1) CONSTRAINTS + HINTS, (2) JOB_TEXT, (3) BASELINE m/m. Do not veto or spotlight a "gap" that (1) already resolves.

AFFIRMATIVE_CONSTRAINTS: Phrases like "I have/own/hold/obtained", "I am certified", "willing to", "open to", "fluent in" in CONSTRAINTS state user facts — not bans. Do not misread them as the user lacking the same capability.

NEGATION_SOFT_CHECK: Treat CONSTRAINTS as an exclusion only when they clearly reject something the job actually requires (quote both). If the job does not require what the user rejected, do not invent a veto or gap.

CONSTRAINT_TACTICS (per-domain): ${JSON.stringify(params.tactics.tactics)}. Keys: location | remote_zone | compensation. Values: default | strong_preference. For strong_preference on a domain, never set vetoed=true for clashes that are only about that domain — apply a large negative constraint_delta (typically -15..-40) instead. default = normal veto rules (hard veto allowed when the clash is only about that domain).

DASHBOARD_GEOGRAPHY (same policy shape as remote_zone, but for city/region vs dashboard preference): When DECISION_BRIEF.preferred_work_location is non-empty, you MUST compare it to DECISION_BRIEF.job_location and to JOB_TEXT (office base, régió, site coverage, relocation). Use the trimmed substring before the first comma as the primary user place token (e.g. "Budapest" from "Budapest, Hungary"). Establish the job's primary geography the same way you would for remote_zone policy (explicit bases, "based in", regional titles). Treat as aligned (no geography-domain penalty; small positive constraint_delta allowed): same city; obvious same-metro commuter synonyms; or work_model remote with no incompatible residence rule that contradicts the user's region. Treat as material mismatch: different named city/region for required on-site/hybrid base vs the user's primary token (e.g. Budapest vs Kecskemét region). On material mismatch follow tactics.location exactly like remote_zone: if tactics.location is default → vetoed=true, fit_score=0, veto_reason one EN sentence with quoted evidence from JOB_TEXT or DECISION_BRIEF.job_location plus quoted preferred_work_location substring; metadata_fit_badge "Location Conflict". If tactics.location is strong_preference → vetoed=false, large negative constraint_delta (-15..-40), metadata_fit_badge "Location Conflict", cite both sides in mathematical_breakdown line 4. If preferred_work_location is null/empty, skip this geography-domain block (PREF_LOC_JSON alignment bonus stays neutral as before).
USER_SKILL_SYNONYMS (server already canonicalized lists; use for narrative and gap notes only): ${params.skillSynonymsPromptJson}

VETO (decide first): vetoed=true on any hard constraint clash (e.g. user bans a country/region and the job is based there, OR user explicitly excludes a required skill), subject to CONSTRAINT_TACTICS. fit_score=0, score_components all 0, veto_reason one clear EN sentence naming the exact conflict; veto_reason MUST include a short quoted substring from JOB_TEXT or CONSTRAINTS (ASCII double quotes) proving the clash. breakdown ends Final Score: 0%. Else vetoed=false.

score_components (REQUIRED when vetoed=false): {base_semantic:int, skill_overlap_delta:int, experience_delta:int, constraint_delta:int, advantage_bonus:int}. Integers. Formula: fit_score = clamp(round(base_semantic + skill_overlap_delta + experience_delta + constraint_delta + advantage_bonus), 0, 100). advantage_bonus >= 0. You MUST set fit_score exactly equal to that sum after clamp.

one_sentence_summary: In addition to mathematical_breakdown, provide one concise English sentence for the user naming the single most important factor (e.g. "Great skill match but rejected due to contract type" or "Perfect seniority and location match"). This is not the math — it is the human headline.

semantic_highlights: 3-5 of {phrase,sentiment:"positive"|"negative",reason}. phrase = exact copy from JOB_TEXT below (short). Pick phrases that moved score most.

CRITICAL GAPS & TRANSFERABLE SKILLS: For each missing_skill, if the candidate has highly adjacent skills (e.g., missing "Scripting" but has "System Integration" or "R&D"), include a short note in the reason field: "Transferable from [adjacent skill] background". Do NOT move such skills to irrelevant_extra_skills; keep them in missing_skills with the note.

PREF_LOC_JSON: ${preferredLocJson} — When non-empty and DECISION_BRIEF.preferred_work_location matches: apply soft +2..+12 constraint_delta bonus only if DASHBOARD_GEOGRAPHY treats job as aligned with the user's primary place token; if DASHBOARD_GEOGRAPHY is a material mismatch, do not apply this positive bonus (handle via tactics.location instead). Empty: neutral unless CONSTRAINTS ban a region.
JOB_STRUCT (from extraction — use for experience_delta, seniority_match, and advantage_bonus; advantage_bonus only for CV evidence vs optional_skills; do not invent skills): ${JSON.stringify(params.jobStructForScorer)}
Optional skills (JOB_STRUCT.optional_skills): bonus only in advantage_bonus, never penalty in missing_skills.
matched_skills/missing_skills: required-only; EN tokens OK. Stay aligned with BASELINE m/m: at most 2 additions and 2 removals per list versus baseline matched_skills and baseline missing_skills; every add/remove must be justified by an exact span from JOB_TEXT or by a quoted substring from CONSTRAINTS when CONSTRAINTS_VS_CRITICAL_GAPS applies (cite briefly in mathematical_breakdown lines 2–3). If unsure, keep the same tokens as BASELINE (lowercased).
vibe_warnings: [] or short EN flags (vague pay, crunch, etc.).
fit_score MUST equal the clamped sum of score_components and MUST match line 7 of mathematical_breakdown.
Do NOT infer social isolation from a city name alone. "Work with people" is a social/role preference, not a location conflict, unless role is explicitly solitary (e.g., forest ranger, lighthouse keeper).

JOB_METADATA${metaNote}: ${JSON.stringify({ ...params.jobBoardMetadata, optional_skills: params.jobStructForScorer.optional_skills })}
CONSTRAINTS: ${JSON.stringify(params.constraints)} HINTS: ${JSON.stringify(params.constraintHints)}

LOGISTICS_AND_PHYSICAL_REQUIREMENTS (common-sense deduction): When the job posting states a physical or logistical requirement (examples: willingness to travel, driving licence, mobility, frequent site visits, on-site presence, regional coverage), apply normal professional inference from the CV. If past job titles and concrete duties strongly imply the requirement is met — e.g. area sales, field service, on-site commissioning, multi-site or multi-region delivery work when the posting expects travel or driving — treat that requirement as satisfied for scoring. Do not apply negative constraint_delta and do not keep the item in missing_skills solely because an exact keyword (e.g. "driving licence") is absent when the employment history clearly establishes equivalent capability. If CONSTRAINTS explicitly affirm the same requirement (e.g. user states they hold the required license), treat it as satisfied even without that keyword on the CV. Cite CONSTRAINTS or CV pattern briefly in mathematical_breakdown / narrative instead of treating it as a hard gap.

CONSTRAINTS_REPEAT_NEAR_CV (same strings as CONSTRAINTS later — reconcile with CV_PRUNED; user-stated facts count like CV mentions for CONSTRAINTS_VS_CRITICAL_GAPS): ${JSON.stringify(params.constraints)}
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
