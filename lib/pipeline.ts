import { parseJobText } from "./parsers/jobParser";
import type { CvParseResult } from "./parsers/cvParser";
import { generateJsonWithOllama } from "./llm/ollama";
import {
  calculateFitScore,
  collectConstraintSignalHints,
  extractExperienceOverrideFromConstraints,
  validateExperienceRequirement,
  type FitScoreResult,
} from "./scoring/fitScore";
import { loadStoredCvFromStorage } from "./storage/userCv";
import { loadUserConstraintsFromStorage } from "./storage/userConstraints";
import { loadUserPreferences } from "./storage/userPreferences";
import {
  CV_CONTEXT_LIMITS,
  DEFAULT_OLLAMA_MODEL,
  JOB_TEXT_LIMITS,
  OLLAMA_TIMEOUT_MS,
  SEMANTIC_HIGHLIGHT_LIMITS,
  SEMANTIC_SCORER_PROMPT_LIMITS,
} from "../config/constants";
import type {
  PipelineContext,
  PipelineDetailedResult,
  PipelineInput,
  PipelineOutput,
  ScoreComponents,
  SemanticHighlight,
} from "../types/pipeline";

export type {
  PipelineContext,
  PipelineDetailedResult,
  PipelineInput,
  PipelineOutput,
  ScoreComponents,
  SemanticHighlight,
} from "../types/pipeline";

function parseScoreComponents(raw: unknown): ScoreComponents | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const keys = [
    "base_semantic",
    "skill_overlap_delta",
    "experience_delta",
    "constraint_delta",
    "advantage_bonus",
  ] as const;
  const out: Partial<ScoreComponents> = {};
  for (const k of keys) {
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out[k] = Math.round(v);
  }
  return out as ScoreComponents;
}

function computeFitFromComponents(c: ScoreComponents): number {
  const sum =
    c.base_semantic +
    c.skill_overlap_delta +
    c.experience_delta +
    c.constraint_delta +
    c.advantage_bonus;
  return Math.max(0, Math.min(100, Math.round(sum)));
}

function patchBreakdownArithmeticAndFinal(
  breakdown: string,
  c: ScoreComponents,
  finalPct: number,
): string {
  const lines = breakdown.split(/\r?\n/);
  const arithBody = `${c.base_semantic} + (${c.skill_overlap_delta}) + (${c.experience_delta}) + (${c.constraint_delta}) + (${c.advantage_bonus}) = ${finalPct}`;
  const line6 = `6) Arithmetic: ${arithBody} (verified sum, clamped 0-100)`;
  const line7 = `7) Final Score: ${finalPct}%`;
  const out: string[] = [];
  let got6 = false;
  let got7 = false;
  for (const line of lines) {
    if (/^\s*6\)\s*Arithmetic:/i.test(line)) {
      out.push(line6);
      got6 = true;
    } else if (/^\s*7\)\s*Final\s*Score:/i.test(line)) {
      out.push(line7);
      got7 = true;
    } else {
      out.push(line);
    }
  }
  if (!got6) out.push(line6);
  if (!got7) out.push(line7);
  return out.join("\n");
}

function buildBreakdownFromScoreComponents(
  c: ScoreComponents,
  finalPct: number,
  matchedLower: string[],
  missingLower: string[],
  headNote?: string,
): string {
  const note = headNote ? `${headNote}\n` : "";
  const m = matchedLower.length ? matchedLower.join(", ") : "none";
  const mi = missingLower.length ? missingLower.join(", ") : "none";
  const fmt = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  return `${note}1) Base Skill Match Score (required-only semantic overlap): ${c.base_semantic}
2) Skill Overlap: ${fmt(c.skill_overlap_delta)}% (Matched: ${m}; Missing: ${mi})
3) Experience Match: ${fmt(c.experience_delta)}% (from score_components)
4) Constraint Adjustments (location, job type, work model): ${fmt(c.constraint_delta)}% (from score_components)
5) Advantage Bonuses (optional / nice-to-have only): ${c.advantage_bonus >= 0 ? "+" : ""}${c.advantage_bonus}%
6) Arithmetic: ${c.base_semantic} + (${c.skill_overlap_delta}) + (${c.experience_delta}) + (${c.constraint_delta}) + (${c.advantage_bonus}) = ${finalPct} (verified sum, clamped 0-100)
7) Final Score: ${finalPct}%`;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9.+#/-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
}

export function selectStrengthHighlights(
  coreStories: string[],
  requiredSkills: string[],
): string[] {
  const requiredTokenSet = new Set(requiredSkills.map((skill) => skill.toLowerCase()));
  const requiredSkillsList = Array.from(requiredTokenSet);

  const scored = coreStories.map((story) => {
    const storyTokens = tokenize(story);
    let overlapCount = 0;
    for (const skill of requiredSkillsList) {
      if (storyTokens.has(skill)) {
        overlapCount += 1;
      }
    }
    return { story, overlapCount };
  });

  return scored
    .sort((a, b) => b.overlapCount - a.overlapCount)
    .map((item) => item.story)
    .slice(0, 3);
}

function constraintsMentionBenefitsOrCommitments(constraints: string[]): boolean {
  const s = constraints.join(" ").toLowerCase();
  if (!s.trim()) return false;
  return /\b(benefit|benefits|insurance|health\s*care|401k|401\(|pension|equity|stock|pto|vacation|leave|perk|wellness|compensation|package|parental|dental|vision|tuition|remote|hybrid|sustainab|diversit|inclusion|dei|culture|value|mission)\b/i.test(
    s,
  );
}

function buildJobBoardMetadataForScorer(
  meta: {
    job_location: string | null;
    work_model: string;
    job_type: string;
    benefits: string[];
    commitments: string[];
    metadata_constraint_notes: string[];
  },
  constraints: string[],
): Record<string, unknown> {
  const includeExtras = constraintsMentionBenefitsOrCommitments(constraints);
  const base: Record<string, unknown> = {
    job_location: meta.job_location,
    work_model: meta.work_model,
    job_type: meta.job_type,
    metadata_constraint_notes: meta.metadata_constraint_notes,
  };
  if (includeExtras) {
    base.benefits = meta.benefits;
    base.commitments = meta.commitments;
  }
  return base;
}

function extractCvExperienceSnippets(raw: string, maxChars: number): string {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const noise =
    /(@|linkedin\.com|github\.com|mailto:|tel:|^\+?[\d\s\-–]{10,}$|^\(?\+?\d|www\.)/i;
  const out: string[] = [];
  const lineMin = CV_CONTEXT_LIMITS.experienceSnippetLinesMin;
  const lineMax = CV_CONTEXT_LIMITS.experienceLineMaxChars + 20;
  const sliceCap = CV_CONTEXT_LIMITS.experienceLineMaxChars;
  for (const line of lines) {
    if (line.length < lineMin || line.length > lineMax) continue;
    if (noise.test(line)) continue;
    if (/^(phone|email|e-mail|address|cv|resume|curriculum vitae)\b/i.test(line)) continue;
    const looksRelevant =
      /^[-*•]\s/.test(line) ||
      /\b(20\d{2}|present|current|engineer|developer|manager|lead|consultant|analyst|director)\b/i.test(
        line,
      );
    if (looksRelevant || out.length < lineMin) out.push(line.slice(0, sliceCap));
    if (out.join("\n").length >= maxChars) break;
  }
  return out.join("\n").slice(0, maxChars);
}

function buildPrunedCvContext(raw: string, parsed: CvParseResult): string {
  const skillPart = parsed.skills.slice(0, CV_CONTEXT_LIMITS.prunedSkillsMax).join(", ");
  const storyPart = (parsed.core_stories ?? [])
    .slice(0, CV_CONTEXT_LIMITS.coreStoriesMax)
    .join(" | ");
  const exp = extractCvExperienceSnippets(raw, CV_CONTEXT_LIMITS.experienceSnippetsMaxChars);
  const chunks = [
    `skills: ${skillPart}`,
    `seniority: ${parsed.seniority_level}`,
    storyPart ? `core_stories: ${storyPart}` : "",
    exp ? `experience_lines:\n${exp}` : "",
  ].filter(Boolean);
  return chunks.join("\n").slice(0, CV_CONTEXT_LIMITS.prunedBlockMaxChars);
}

type SemanticFitReview = {
  vetoed: boolean;
  veto_reason: string | null;
  fit_score: number;
  mathematical_breakdown: string;
  narrative_summary: string;
  matched_skills: string[];
  missing_skills: string[];
  seniority_match: boolean;
  metadata_fit_badge: "Location Conflict" | "Preference Match" | null;
  vibe_warnings: string[];
  semantic_highlights: SemanticHighlight[];
  fit_score_reconciled_from_components: boolean;
};

function isCompleteMathematicalBreakdown(s: string): boolean {
  const t = s.trim();
  if (t.length < 80) return false;
  return (
    t.includes("Base Skill Match Score (required-only semantic overlap):") &&
    t.includes("Skill Overlap:") &&
    t.includes("Experience Match:") &&
    t.includes("Constraint Adjustments") &&
    t.includes("Advantage Bonuses") &&
    t.includes("Arithmetic:") &&
    /Final Score:\s*\d+\s*%/i.test(t)
  );
}

function parseSemanticHighlights(raw: unknown): SemanticHighlight[] {
  if (!Array.isArray(raw)) return [];
  const out: SemanticHighlight[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const phrase = typeof r.phrase === "string" ? r.phrase.trim() : "";
    const reason = typeof r.reason === "string" ? r.reason.trim() : "";
    const sent = r.sentiment === "positive" || r.sentiment === "negative" ? r.sentiment : null;
    if (!phrase || phrase.length < 2 || !sent || !reason) continue;
    out.push({
      phrase: phrase.slice(0, SEMANTIC_HIGHLIGHT_LIMITS.phraseMaxChars),
      sentiment: sent,
      reason: reason.slice(0, SEMANTIC_HIGHLIGHT_LIMITS.reasonMaxChars),
    });
    if (out.length >= SEMANTIC_HIGHLIGHT_LIMITS.parseScanMax) break;
  }
  return out.slice(0, SEMANTIC_HIGHLIGHT_LIMITS.returnMax);
}

function inferFallbackConstraintVeto(
  constraints: string[],
  jobLocation: string | null,
  jobTextEnglish: string,
): { vetoed: boolean; veto_reason: string | null } {
  const joined = constraints.join(" ").toLowerCase();
  if (!joined.trim()) return { vetoed: false, veto_reason: null };
  const loc = (jobLocation ?? "").toLowerCase();
  const job = jobTextEnglish.toLowerCase();
  const blob = `${loc} ${job}`;
  const constraintsExcludeThisRegion =
    /(?:don'?t|do not|hate|never|avoid|not)\s+(?:like\s+)?(?:working|work|to\s+work).{0,50}hungary|hate.{0,30}hungary|no\s+hungary/i.test(
      joined,
    );
  if (
    constraintsExcludeThisRegion &&
    /\bhungary\b|budapest|debrecen|szeged|miskolc\b/i.test(blob)
  ) {
    return {
      vetoed: true,
      veto_reason:
        "Veto: saved constraints rule out this region, but the role is located there (offline check while semantic scoring is unavailable).",
    };
  }
  return { vetoed: false, veto_reason: null };
}

function buildSchemaCompliantBreakdown(params: {
  fitScore: number;
  baseline: FitScoreResult;
  headNote?: string;
  constraintHints: string[];
  veto?: boolean;
}): string {
  const { fitScore, baseline, headNote, constraintHints, veto } = params;
  const b = Math.max(0, Math.min(100, baseline.fit_score));
  const f = Math.max(0, Math.min(100, fitScore));
  const matched = baseline.matched_skills.length ? baseline.matched_skills.join(", ") : "none";
  const missing = baseline.missing_skills.length ? baseline.missing_skills.join(", ") : "none";
  const hintLine =
    constraintHints.length > 0 ? ` (${constraintHints.slice(0, 3).join("; ")})` : "";
  const note = headNote ? `${headNote} ` : "";
  const arith = veto
    ? `Arithmetic: veto => 0 (literal baseline ref ${b}%)`
    : `Arithmetic: ${b} + 0 = ${f} (clamp 0-100)`;
  return `${note}1) Base Skill Match Score (required-only semantic overlap): ${b}
2) Skill Overlap: +0% (Matched: ${matched}; Missing: ${missing})
3) Experience Match: +0% (offline / literal baseline)
4) Constraint Adjustments (location, job type, work model): +0%${hintLine}
5) Advantage Bonuses (optional / nice-to-have only): +0%
6) ${arith}
7) Final Score: ${f}%`;
}

function buildSemanticScoringFallback(
  baseline: FitScoreResult,
  constraintHints: string[],
  vetoCheck: { vetoed: boolean; veto_reason: string | null },
): Record<string, unknown> {
  if (vetoCheck.vetoed) {
    return {
      vetoed: true,
      veto_reason: vetoCheck.veto_reason,
      fit_score: 0,
      mathematical_breakdown: buildSchemaCompliantBreakdown({
        fitScore: 0,
        baseline,
        headNote: `VETO: ${vetoCheck.veto_reason ?? "Hard constraint"}.`,
        constraintHints,
        veto: true,
      }),
      narrative_summary: "",
      matched_skills: baseline.matched_skills,
      missing_skills: baseline.missing_skills,
      seniority_match: baseline.seniority_match,
      metadata_fit_badge: "Location Conflict",
      vibe_warnings: [],
      semantic_highlights: [],
      score_components: {
        base_semantic: 0,
        skill_overlap_delta: 0,
        experience_delta: 0,
        constraint_delta: 0,
        advantage_bonus: 0,
      },
    };
  }
  const b0 = Math.max(0, Math.min(100, Math.round(baseline.fit_score)));
  return {
    vetoed: false,
    veto_reason: null,
    fit_score: baseline.fit_score,
    mathematical_breakdown: buildSchemaCompliantBreakdown({
      fitScore: baseline.fit_score,
      baseline,
      headNote: "Fallback: semantic scorer unavailable; literal overlap only.",
      constraintHints,
      veto: false,
    }),
    narrative_summary: "",
    matched_skills: baseline.matched_skills,
    missing_skills: baseline.missing_skills,
    seniority_match: baseline.seniority_match,
    metadata_fit_badge: null,
    vibe_warnings: [],
    semantic_highlights: [],
    score_components: {
      base_semantic: b0,
      skill_overlap_delta: 0,
      experience_delta: 0,
      constraint_delta: 0,
      advantage_bonus: 0,
    },
  };
}

function parseSemanticFitReviewPayload(
  data: unknown,
  baseline: FitScoreResult,
  offlineVeto: { vetoed: boolean; veto_reason: string | null },
): SemanticFitReview {
  const o = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};

  const strList = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
      : [];

  let vetoed = Boolean(o.vetoed);
  let vetoReason =
    typeof o.veto_reason === "string" && o.veto_reason.trim() ? o.veto_reason.trim() : null;

  if (!vetoed && offlineVeto.vetoed) {
    vetoed = true;
    vetoReason = offlineVeto.veto_reason;
  }

  let matched = strList(o.matched_skills);
  let missing = strList(o.missing_skills);
  if (matched.length === 0 && missing.length === 0) {
    matched = [...baseline.matched_skills];
    missing = [...baseline.missing_skills];
  }

  let fitScore =
    typeof o.fit_score === "number" && Number.isFinite(o.fit_score)
      ? Math.round(o.fit_score)
      : baseline.fit_score;
  if (vetoed) fitScore = 0;
  else fitScore = Math.max(0, Math.min(100, fitScore));

  const rawBreakdown =
    typeof o.mathematical_breakdown === "string" ? o.mathematical_breakdown.trim() : "";
  let breakdown = rawBreakdown;
  if (vetoed) {
    breakdown =
      rawBreakdown.length > 0
        ? rawBreakdown
        : `VETO: ${vetoReason ?? "Hard constraint violation."}\nFinal Score: 0%.`;
  } else if (!rawBreakdown || !isCompleteMathematicalBreakdown(rawBreakdown)) {
    breakdown = `Breakdown generation failed.\nLiteral baseline reference: ${baseline.fit_score}%.\nApplied fit score: ${fitScore}%.`;
  }

  const narrative =
    typeof o.narrative_summary === "string" && o.narrative_summary.trim().length > 0
      ? o.narrative_summary.trim()
      : "";

  const seniorityMatch =
    typeof o.seniority_match === "boolean" ? o.seniority_match : baseline.seniority_match;

  const badgeRaw = o.metadata_fit_badge;
  let badge: SemanticFitReview["metadata_fit_badge"] = null;
  if (badgeRaw === "Location Conflict" || badgeRaw === "Preference Match") {
    badge = badgeRaw;
  }
  if (vetoed && !badge) badge = "Location Conflict";

  const vibeWarnings = strList(o.vibe_warnings);
  const semanticHighlights = parseSemanticHighlights(o.semantic_highlights);

  const matchedLower = [...new Set(matched.map((s) => s.toLowerCase()))].sort();
  const missingLower = [...new Set(missing.map((s) => s.toLowerCase()))].sort();

  let fitScoreReconciled = false;
  const scoreComponents = parseScoreComponents(o.score_components);
  if (!vetoed && scoreComponents) {
    const llmDeclaredRaw =
      typeof o.fit_score === "number" && Number.isFinite(o.fit_score) ? Math.round(o.fit_score) : null;
    const llmDeclared = llmDeclaredRaw !== null ? Math.max(0, Math.min(100, llmDeclaredRaw)) : null;
    const canonical = computeFitFromComponents(scoreComponents);
    const hadComplete = isCompleteMathematicalBreakdown(breakdown);

    fitScore = canonical;
    fitScoreReconciled =
      llmDeclared !== null ? canonical !== llmDeclared : !hadComplete;

    if (hadComplete) {
      breakdown = patchBreakdownArithmeticAndFinal(breakdown, scoreComponents, fitScore);
    } else {
      breakdown = buildBreakdownFromScoreComponents(
        scoreComponents,
        fitScore,
        matchedLower,
        missingLower,
        "Regenerated from score_components (model breakdown was incomplete).",
      );
      fitScoreReconciled = true;
    }
  }

  return {
    vetoed,
    veto_reason: vetoReason,
    fit_score: fitScore,
    mathematical_breakdown: breakdown,
    narrative_summary: narrative,
    matched_skills: matchedLower,
    missing_skills: missingLower,
    seniority_match: seniorityMatch,
    metadata_fit_badge: badge,
    vibe_warnings: vibeWarnings,
    semantic_highlights: semanticHighlights,
    fit_score_reconciled_from_components: fitScoreReconciled,
  };
}

async function semanticFitScoreReviewWithLlm(params: {
  constraints: string[];
  preferredLocation: string | null;
  jobTextEnglish: string;
  combinedJobText: string;
  jobBoardMetadata: Record<string, unknown>;
  cvSkills: string[];
  coreStories: string[];
  cvSnippet: string;
  baseline: FitScoreResult;
  constraintHints: string[];
  model: string;
}): Promise<{ review: SemanticFitReview; source: "llm" | "fallback" }> {
  const offlineVeto = inferFallbackConstraintVeto(
    params.constraints,
    typeof params.jobBoardMetadata.job_location === "string"
      ? params.jobBoardMetadata.job_location
      : null,
    params.jobTextEnglish,
  );

  const fallbackPayload = buildSemanticScoringFallback(
    params.baseline,
    params.constraintHints,
    offlineVeto,
  );

  const preferredLocJson = JSON.stringify(params.preferredLocation ?? "");

  const metaNote =
    "benefits" in params.jobBoardMetadata || "commitments" in params.jobBoardMetadata
      ? ""
      : " (benefits/commitments omitted from metadata JSON to save tokens — not referenced in user constraints).";

  const prompt = `Task: fit JSON only. Keys: vetoed,veto_reason,fit_score,mathematical_breakdown,narrative_summary,matched_skills,missing_skills,seniority_match,metadata_fit_badge,vibe_warnings,semantic_highlights,score_components
All strings EN.

score_components (REQUIRED when vetoed=false): {base_semantic:int, skill_overlap_delta:int, experience_delta:int, constraint_delta:int, advantage_bonus:int}. Integers. Formula: fit_score = clamp(round(base_semantic + skill_overlap_delta + experience_delta + constraint_delta + advantage_bonus), 0, 100). advantage_bonus >= 0. You MUST set fit_score exactly equal to that sum after clamp.

semantic_highlights: 3-5 of {phrase,sentiment:"positive"|"negative",reason}. phrase = exact copy from JOB_TEXT below (short). Pick phrases that moved score most.

VETO: vetoed=true only hard constraint clash (e.g. user bans a country/region and the job is based there). fit_score=0, score_components all 0, veto_reason 1 EN sentence, breakdown ends Final Score: 0%. Else vetoed=false.

PREF_LOC_JSON: ${preferredLocJson} — non-empty: soft +2..+12 if align; empty: neutral unless constraints ban region.
Optional skills: bonus only, never penalty.
matched_skills/missing_skills: required-only; EN tokens OK.
vibe_warnings: [] or short EN flags (vague pay, crunch, etc.).
fit_score MUST equal the clamped sum of score_components and MUST match line 7 of mathematical_breakdown.

JOB_METADATA${metaNote}: ${JSON.stringify(params.jobBoardMetadata)}
CONSTRAINTS: ${JSON.stringify(params.constraints)} HINTS: ${JSON.stringify(params.constraintHints)}
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

  const llm = await generateJsonWithOllama<Record<string, unknown>>(
    prompt,
    fallbackPayload,
    { model: params.model, timeoutMs: OLLAMA_TIMEOUT_MS.semanticPipelineScore },
  );

  const review = parseSemanticFitReviewPayload(llm.data, params.baseline, offlineVeto);

  return { review, source: llm.source };
}

export async function runPipelineDetailed(
  input: PipelineInput,
): Promise<PipelineDetailedResult> {
  const model = input.model?.trim() || DEFAULT_OLLAMA_MODEL;
  const storedCv = await loadStoredCvFromStorage();
  if (!storedCv) {
    throw new Error("No stored CV found. Upload CV first.");
  }

  const storedConstraints = await loadUserConstraintsFromStorage();
  const constraints = storedConstraints.constraints;
  const userPrefs = await loadUserPreferences();
  let preferredLocationRaw = "";
  if (typeof input.preferred_location === "string") {
    preferredLocationRaw = input.preferred_location.trim();
  } else {
    preferredLocationRaw = (userPrefs.preferred_location ?? "").trim();
  }
  const preferredLocation = preferredLocationRaw.length > 0 ? preferredLocationRaw : null;

  const jobParsed = await parseJobText(
    input.job,
    model,
    constraints,
    undefined,
    storedCv.raw_text ?? "",
  );
  const combinedJobText = `${jobParsed.english_job_text}\n\n${input.job}`.slice(
    0,
    JOB_TEXT_LIMITS.combinedJobForScoring,
  );
  const cvParsed = storedCv.parsed;
  const userExperienceOverride = extractExperienceOverrideFromConstraints(constraints);
  const prunedCv = buildPrunedCvContext(storedCv.raw_text ?? "", cvParsed);

  const userProfileBlob = [
    ...cvParsed.skills,
    cvParsed.seniority_level,
    ...(cvParsed.core_stories ?? []),
    prunedCv,
  ]
    .join(" ")
    .slice(0, CV_CONTEXT_LIMITS.userProfileJoinMax);

  const score = calculateFitScore(
    cvParsed.skills,
    jobParsed.required_skills,
    jobParsed.optional_skills,
    cvParsed.seniority_level,
    jobParsed.required_seniority,
    {
      experience_years: validateExperienceRequirement(
        jobParsed.experience_years,
        combinedJobText,
      ),
      education: jobParsed.education,
    },
    userProfileBlob,
    userExperienceOverride,
  );

  const constraintHints = collectConstraintSignalHints(constraints, combinedJobText);

  const jobBoardMetadata = {
    job_location: jobParsed.job_location,
    work_model: jobParsed.work_model,
    job_type: jobParsed.job_type,
    benefits: jobParsed.benefits,
    commitments: jobParsed.commitments,
    metadata_constraint_notes: jobParsed.metadata_constraint_notes,
  };
  const jobBoardMetadataForScorer = buildJobBoardMetadataForScorer(jobBoardMetadata, constraints);

  const semantic = await semanticFitScoreReviewWithLlm({
    constraints,
    preferredLocation,
    jobTextEnglish: jobParsed.english_job_text,
    combinedJobText,
    jobBoardMetadata: jobBoardMetadataForScorer,
    cvSkills: cvParsed.skills,
    coreStories: cvParsed.core_stories ?? [],
    cvSnippet: prunedCv,
    baseline: score,
    constraintHints,
    model,
  });

  const summaryPieces: string[] = [];
  if (semantic.review.vetoed) {
    summaryPieces.push(`VETO: ${semantic.review.veto_reason ?? "Hard constraint violation."}`);
  }
  if (semantic.review.narrative_summary) {
    summaryPieces.push(semantic.review.narrative_summary);
  }
  const summary =
    summaryPieces.length > 0
      ? summaryPieces.join("\n\n")
      : "See mathematical_breakdown for how this score was derived.";

  const strengthHighlights = selectStrengthHighlights(
    cvParsed.core_stories,
    jobParsed.required_skills,
  );
  const analysisSource =
    cvParsed.parser_source === "llm" && jobParsed.parser_source === "llm"
      ? "llm"
      : "fallback";

  return {
    result: {
      fit_score: semantic.review.fit_score,
      matched_skills: semantic.review.matched_skills,
      missing_skills: semantic.review.missing_skills,
      strength_highlights: strengthHighlights,
      seniority_match: semantic.review.seniority_match,
      summary,
      mathematical_breakdown: semantic.review.mathematical_breakdown,
      vibe_warnings: semantic.review.vibe_warnings,
      semantic_highlights: semantic.review.semantic_highlights,
      constraint_veto: semantic.review.vetoed,
      extracted_entities: {
        required_skills: jobParsed.required_skills,
        optional_skills: jobParsed.optional_skills,
        experience_years:
          userExperienceOverride ??
          validateExperienceRequirement(jobParsed.experience_years, combinedJobText),
        education: jobParsed.education,
        job_location: jobParsed.job_location,
        work_model: jobParsed.work_model,
        job_type: jobParsed.job_type,
        benefits: jobParsed.benefits,
        commitments: jobParsed.commitments,
        metadata_constraint_notes: jobParsed.metadata_constraint_notes,
      },
      metadata_fit_badge: semantic.review.metadata_fit_badge,
      analysis_model: model,
      debug: {
        analysis_source: analysisSource,
        cv_parser_source: cvParsed.parser_source,
        job_parser_source: jobParsed.parser_source,
        constraints_source: semantic.source,
        fit_score_reconciled_from_components: semantic.review.fit_score_reconciled_from_components,
      },
    },
    context: {
      cv_text: storedCv.raw_text,
      core_stories: cvParsed.core_stories,
      required_skills: jobParsed.required_skills,
      job_text_english: jobParsed.english_job_text,
    },
  };
}

export async function runPipeline(input: PipelineInput): Promise<PipelineOutput> {
  const detailed = await runPipelineDetailed(input);
  return detailed.result;
}
