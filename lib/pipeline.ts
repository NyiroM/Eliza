import {
  formatCvCacheLabel,
  getCvParseCacheKey,
  readCvParseCache,
  writeCvParseCache,
} from "./cache/cvParseCache";
import { isBackendLlmVerboseLog } from "./logging/backendLlmVerbose";
import { extractRecentExperienceSection } from "./cv/experienceSectionSnippets";
import { applySkillSynonyms, buildSkillSynonymMap } from "./domain/skillSynonyms";
import { parseJobText } from "./parsers/jobParser";
import { parseCvText, type CvParseResult } from "./parsers/cvParser";
import { runCvMissingSkillsEvidencePass } from "./parsers/cvEvidencePass";
import { generateJsonWithOllamaStrict } from "./llm/ollama";
import {
  calculateFitScore,
  collectConstraintSignalHints,
  extractExperienceOverrideFromConstraints,
  validateExperienceRequirement,
  type FitScoreResult,
} from "./scoring/fitScore";
import { loadStoredCvFromStorage } from "./storage/userCv";
import { loadUserConstraintsFromStorage } from "./storage/userConstraints";
import { loadUserCorrectionsPromptBlock } from "./storage/userCorrections";
import { loadConstraintTacticsFromStorage } from "./storage/constraintTactics";
import { loadSkillSynonymsFromStorage } from "./storage/skillSynonyms";
import { loadUserPreferences } from "./storage/userPreferences";
import {
  CV_CONTEXT_LIMITS,
  DEFAULT_OLLAMA_MODEL,
  JOB_TEXT_LIMITS,
  SEMANTIC_HIGHLIGHT_LIMITS,
} from "../config/constants";

// Helper to safely coerce unknown to string[]
function strList(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
    : [];
}

type InterviewPrepRow = { question: string; cheat_sheet: string };

function interviewPrepFromUnknown(raw: unknown, max: number): InterviewPrepRow[] {
  if (!Array.isArray(raw)) return [];
  const out: InterviewPrepRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.question !== "string" || typeof o.cheat_sheet !== "string") continue;
    const question = o.question.trim();
    const cheat_sheet = o.cheat_sheet.trim();
    if (!question || !cheat_sheet) continue;
    out.push({ question, cheat_sheet });
    if (out.length >= max) break;
  }
  return out;
}
import type {
  JobSourceKind,
  PipelineDetailedResult,
  PipelineInput,
  PipelineOutput,
  ScoreComponents,
  SemanticHighlight,
} from "../types/pipeline";
import { runSalaryOracle } from "./salary-oracle";
import {
  buildConstraintTacticHints,
  inferFallbackConstraintVetoWithTactics,
  shouldSuppressHardVetoForTactics,
} from "./pipeline/constraintVetoTactics";
import { buildSemanticFitScoreReviewPrompt } from "./prompts/semanticFitScoreReviewPrompt";
import type { StoredConstraintTactics } from "./storage/constraintTactics";

export type {
  JobSourceKind,
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

export function buildJobBoardMetadataForScorer(
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

export function buildPrunedCvContext(raw: string, parsed: CvParseResult): string {
  const skillPart = parsed.skills.slice(0, CV_CONTEXT_LIMITS.prunedSkillsMax).join(", ");
  const storyPart = (parsed.core_stories ?? [])
    .slice(0, CV_CONTEXT_LIMITS.coreStoriesMax)
    .join(" | ");
  const recent = extractRecentExperienceSection(
    raw,
    CV_CONTEXT_LIMITS.recentExperienceSectionMaxChars,
  );
  const exp = extractCvExperienceSnippets(raw, CV_CONTEXT_LIMITS.experienceSnippetsMaxChars);
  const chunks = [
    `skills: ${skillPart}`,
    `seniority: ${parsed.seniority_level}`,
    storyPart ? `core_stories: ${storyPart}` : "",
    recent ? `recent_experience_section:\n${recent}` : "",
    exp ? `experience_lines:\n${exp}` : "",
  ].filter(Boolean);
  return chunks.join("\n").slice(0, CV_CONTEXT_LIMITS.prunedBlockMaxChars);
}

function applyTacticsVetoRelaxation(
  review: SemanticFitReview,
  baseline: FitScoreResult,
  tactics: StoredConstraintTactics,
): SemanticFitReview {
  if (!review.vetoed || !review.veto_reason) return review;
  if (!shouldSuppressHardVetoForTactics(review.veto_reason, tactics)) return review;
  const note =
    "[Constraint policy: hard veto downgraded to soft scoring for this category.]\n\n";
  const matchedLower = [...new Set((baseline.matched_skills ?? []).map((s) => s.toLowerCase()))].sort();
  const missingLower = [...new Set((baseline.missing_skills ?? []).map((s) => s.toLowerCase()))].sort();
  const cvSkillsSet = new Set((baseline.matched_skills ?? []).map((s) => s.toLowerCase()));
  const requiredSkillsSet = new Set(missingLower);
  const irrelevantExtraSkills: string[] = [];
  for (const cvSkill of cvSkillsSet) {
    if (!requiredSkillsSet.has(cvSkill)) irrelevantExtraSkills.push(cvSkill);
  }
  irrelevantExtraSkills.sort();
  return {
    ...review,
    vetoed: false,
    veto_reason: null,
    fit_score: baseline.fit_score,
    matched_skills: matchedLower,
    missing_skills: missingLower,
    irrelevant_extra_skills: irrelevantExtraSkills,
    mathematical_breakdown:
      note +
      (review.mathematical_breakdown?.trim().length
        ? review.mathematical_breakdown
        : `Literal baseline reference: ${baseline.fit_score}%.`),
    metadata_fit_badge: null,
    fit_score_reconciled_from_components: false,
  };
}

type SemanticFitReview = {
  vetoed: boolean;
  veto_reason: string | null;
  fit_score: number;
  mathematical_breakdown: string;
  one_sentence_summary: string;
  narrative_summary: string;
  matched_skills: string[];
  missing_skills: string[];
  irrelevant_extra_skills: string[];
  interview_prep: Array<{ question: string; cheat_sheet: string }>;
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

function detectNoCodeConstraint(constraints: string[]): boolean {
  return constraints.some((constraint) =>
    /\b(no[-\s]?code|cannot code|can't code|i cannot code|non[-\s]?coding)\b/i.test(constraint),
  );
}

function detectProgrammingRequirement(
  requiredSkills: string[],
  jobText: string,
): string | null {
  const programmingSkills = [
    "python",
    "java",
    "javascript",
    "typescript",
    "c",
    "c++",
    "c#",
    "go",
    "rust",
    "ruby",
    "php",
    "kotlin",
    "swift",
  ];
  const requiredSet = new Set(requiredSkills.map((s) => s.toLowerCase()));
  for (const skill of programmingSkills) {
    if (requiredSet.has(skill) || new RegExp(`\\b${skill.replace(/[+]/g, "\\+")}\\b`, "i").test(jobText)) {
      return skill.toUpperCase();
    }
  }
  return null;
}

function normalizeConstraintText(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9+#/.\-\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function hasNegativeConstraintSignal(value: string): boolean {
  return /\b(no|cannot|can't|do not|don't|excluding|exclude|without|avoid|not)\b/i.test(value);
}

function detectUniversalNegativeConstraintConflict(
  constraints: string[],
  requiredItems: string[],
): string | null {
  if (!constraints.length || !requiredItems.length) return null;
  const required = [...new Set(requiredItems.map((s) => s.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );

  for (const constraint of constraints) {
    if (!hasNegativeConstraintSignal(constraint)) continue;
    const normalizedConstraint = normalizeConstraintText(constraint);

    for (const skill of required) {
      const normalizedSkill = normalizeConstraintText(skill).trim();
      if (normalizedSkill.length < 2) continue;

      if (normalizedConstraint.includes(` ${normalizedSkill} `)) {
        return skill;
      }

      const skillTokens = normalizedSkill.split(" ").filter((t) => t.length > 1);
      if (skillTokens.length > 1) {
        const allTokensPresent = skillTokens.every((token) =>
          normalizedConstraint.includes(` ${token} `),
        );
        if (allTokensPresent) return skill;
      }
    }
  }
  return null;
}

function buildHardVetoReview(
  baseline: FitScoreResult,
  reason: string,
): SemanticFitReview {
  return {
    vetoed: true,
    veto_reason: reason,
    fit_score: 0,
    mathematical_breakdown: `VETO: ${reason}\nFinal Score: 0%.`,
    one_sentence_summary: reason,
    narrative_summary: reason,
    matched_skills: [...new Set((baseline.matched_skills ?? []).map((s) => s.toLowerCase()))].sort(),
    missing_skills: [...new Set((baseline.missing_skills ?? []).map((s) => s.toLowerCase()))].sort(),
    irrelevant_extra_skills: [],
    interview_prep: [],
    seniority_match: baseline.seniority_match,
    metadata_fit_badge: null,
    vibe_warnings: [],
    semantic_highlights: [],
    fit_score_reconciled_from_components: false,
  };
}

export function parseSemanticFitReviewPayload(
  data: unknown,
  baseline: FitScoreResult,
  offlineVeto: { vetoed: boolean; veto_reason: string | null },
): SemanticFitReview {
  const o = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};

  let vetoed = Boolean(o.vetoed);
  let vetoReason =
    typeof o.veto_reason === "string" && o.veto_reason.trim() ? o.veto_reason.trim() : null;

  if (!vetoed && offlineVeto.vetoed) {
    vetoed = true;
    vetoReason = offlineVeto.veto_reason;
  }

  const matched = strList(o.matched_skills);
  const missing = strList(o.missing_skills);

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

  let oneSentence =
    typeof o.one_sentence_summary === "string" ? o.one_sentence_summary.trim() : "";
  if (!oneSentence && narrative) {
    const first = narrative.split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
    if (first.length > 12) oneSentence = first;
  }
  if (!oneSentence) {
    oneSentence = "Open Match analysis below for the full numeric breakdown.";
  }
  oneSentence = oneSentence.slice(0, 400);

  const seniorityMatch =
    typeof o.seniority_match === "boolean" ? o.seniority_match : baseline.seniority_match;

  const badgeRaw = o.metadata_fit_badge;
  let badge: SemanticFitReview["metadata_fit_badge"] = null;
  if (badgeRaw === "Location Conflict" || badgeRaw === "Preference Match") {
    badge = badgeRaw;
  }
  if (vetoed && !badge && /location|region|country|city/i.test(vetoReason ?? "")) {
    badge = "Location Conflict";
  }

  const vibeWarnings = strList(o.vibe_warnings);
  const semanticHighlights = parseSemanticHighlights(o.semantic_highlights);

  // Compute lowercase skill sets for prompt and downstream use
  const matchedLower = [...new Set(matched.map((s) => s.toLowerCase()))].sort();
  const missingLower = [...new Set(missing.map((s) => s.toLowerCase()))].sort();

  // Parse interview prep if present
  const interviewPrep = interviewPrepFromUnknown(o.interview_prep, 3);

  // Compute irrelevant_extra_skills: skills present in CV but not required by job
  const cvSkillsSet = new Set((baseline.matched_skills ?? []).map((s) => s.toLowerCase()));
  const requiredSkillsSet = new Set(missingLower);
  const irrelevantExtraSkills: string[] = [];
  for (const cvSkill of cvSkillsSet) {
    if (!requiredSkillsSet.has(cvSkill)) {
      irrelevantExtraSkills.push(cvSkill);
    }
  }
  irrelevantExtraSkills.sort();

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
    one_sentence_summary: oneSentence,
    narrative_summary: narrative,
    matched_skills: matchedLower,
    missing_skills: missingLower,
    irrelevant_extra_skills: irrelevantExtraSkills,
    interview_prep: interviewPrep,
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
  jobStructForScorer: {
    required_skills: string[];
    optional_skills: string[];
    required_seniority: string;
    experience_years: number | null;
    education: string | null;
  };
  cvSkills: string[];
  coreStories: string[];
  cvSnippet: string;
  baseline: FitScoreResult;
  constraintHints: string[];
  model: string;
  correctionsBlock: string;
  tactics: StoredConstraintTactics;
  skillSynonymsPromptJson: string;
  role?: "analysis" | "extract_cv" | "creative_coach" | "creative_rewrite";
}): Promise<SemanticFitReview> {
  const offlineVeto = inferFallbackConstraintVetoWithTactics(
    params.constraints,
    typeof params.jobBoardMetadata.job_location === "string"
      ? params.jobBoardMetadata.job_location
      : null,
    params.jobTextEnglish,
    params.tactics,
  );

  const prompt = buildSemanticFitScoreReviewPrompt({
    constraints: params.constraints,
    preferredLocation: params.preferredLocation,
    jobTextEnglish: params.jobTextEnglish,
    combinedJobText: params.combinedJobText,
    jobBoardMetadata: params.jobBoardMetadata,
    jobStructForScorer: params.jobStructForScorer,
    cvSkills: params.cvSkills,
    coreStories: params.coreStories,
    cvSnippet: params.cvSnippet,
    baseline: params.baseline,
    constraintHints: params.constraintHints,
    tactics: params.tactics,
    skillSynonymsPromptJson: params.skillSynonymsPromptJson,
  });

  if (isBackendLlmVerboseLog()) {
    console.log("[Backend] Sending prompt to Ollama... (semantic fit scoring)");
  }
  const data = await generateJsonWithOllamaStrict<Record<string, unknown>>(prompt, {
    model: params.model,
    role: params.role ?? "analysis",
    ...(params.correctionsBlock.trim()
      ? { systemAppend: params.correctionsBlock.trim() }
      : {}),
  });

  return parseSemanticFitReviewPayload(data, params.baseline, offlineVeto);
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

  const correctionsBlock = await loadUserCorrectionsPromptBlock();
  const storedSynonyms = await loadSkillSynonymsFromStorage();
  const synonymMap = buildSkillSynonymMap(storedSynonyms.pairs);
  const synonymPairsForPrompt = storedSynonyms.pairs.slice(0, 28);
  const constraintTactics = await loadConstraintTacticsFromStorage();

  const rawCvText = storedCv.raw_text ?? "";
  const cacheKey = getCvParseCacheKey(rawCvText, model);
  const cacheLabel = formatCvCacheLabel(storedCv.source_filename ?? null, cacheKey);
  let cvParsed: CvParseResult;
  const cachedCv = await readCvParseCache(cacheKey, rawCvText, model);
  if (cachedCv) {
    cvParsed = cachedCv;
    if (isBackendLlmVerboseLog()) {
      console.log(`[Cache] CV parse hit for "${cacheLabel}"`);
    }
  } else {
    if (isBackendLlmVerboseLog()) {
      console.log(`[Cache] CV parse miss for "${cacheLabel}" — running cvParser`);
    }
    cvParsed = await parseCvText(rawCvText, model);
    await writeCvParseCache(cacheKey, rawCvText, model, cvParsed, storedCv.source_filename ?? null);
  }
  cvParsed = {
    ...cvParsed,
    skills: applySkillSynonyms(cvParsed.skills, synonymMap),
  };

  const jobParsed = await parseJobText(
    input.job,
    model,
    constraints,
    undefined,
    storedCv.raw_text ?? "",
    {
      strictLlm: true,
      ...(constraints.length > 0 && correctionsBlock.trim()
        ? { userCorrectionsAppend: correctionsBlock.trim() }
        : {}),
    },
  );
  const isEnglish = jobParsed.translation_skipped === true;
  if (isEnglish === undefined || isEnglish === null) {
    console.warn("[Backend] Language detection returned null/undefined; defaulting to English");
    jobParsed.translation_skipped = true;
    jobParsed.english_job_text = input.job;
  }
  if (isBackendLlmVerboseLog()) {
    console.log(
      `[Backend] Language detection result: ${isEnglish ? "English" : "Translating..."}`,
    );
  }

  jobParsed.required_skills = applySkillSynonyms(jobParsed.required_skills, synonymMap);
  jobParsed.optional_skills = applySkillSynonyms(jobParsed.optional_skills, synonymMap);

  const combinedJobText = `${jobParsed.english_job_text}\n\n${input.job}`.slice(
    0,
    JOB_TEXT_LIMITS.combinedJobForScoring,
  );
  const experienceYearsForScoring = validateExperienceRequirement(
    jobParsed.experience_years,
    combinedJobText,
  );
  const userExperienceOverride = extractExperienceOverrideFromConstraints(constraints);
  let prunedCv = buildPrunedCvContext(storedCv.raw_text ?? "", cvParsed);

  let userProfileBlob = [
    ...cvParsed.skills,
    cvParsed.seniority_level,
    ...(cvParsed.core_stories ?? []),
    prunedCv,
  ]
    .join(" ")
    .slice(0, CV_CONTEXT_LIMITS.userProfileJoinMax);

  let score = calculateFitScore(
    cvParsed.skills,
    jobParsed.required_skills,
    jobParsed.optional_skills,
    cvParsed.seniority_level,
    jobParsed.required_seniority,
    {
      experience_years: experienceYearsForScoring,
      education: jobParsed.education,
    },
    userProfileBlob,
    userExperienceOverride,
  );

  let cvEvidencePass: { confirmed_skills: string[]; source: "llm" | "skipped" } = {
    confirmed_skills: [],
    source: "skipped",
  };
  if (score.missing_skills.length > 0) {
    const ev = await runCvMissingSkillsEvidencePass({
      cvText: rawCvText,
      missingRequiredSkills: score.missing_skills,
      model,
    });
    cvEvidencePass = { confirmed_skills: ev.confirmed_skills, source: ev.source };
    if (ev.confirmed_skills.length > 0) {
      cvParsed = {
        ...cvParsed,
        skills: applySkillSynonyms([...cvParsed.skills, ...ev.confirmed_skills], synonymMap),
      };
      prunedCv = buildPrunedCvContext(storedCv.raw_text ?? "", cvParsed);
      userProfileBlob = [
        ...cvParsed.skills,
        cvParsed.seniority_level,
        ...(cvParsed.core_stories ?? []),
        prunedCv,
      ]
        .join(" ")
        .slice(0, CV_CONTEXT_LIMITS.userProfileJoinMax);
      score = calculateFitScore(
        cvParsed.skills,
        jobParsed.required_skills,
        jobParsed.optional_skills,
        cvParsed.seniority_level,
        jobParsed.required_seniority,
        {
          experience_years: experienceYearsForScoring,
          education: jobParsed.education,
        },
        userProfileBlob,
        userExperienceOverride,
      );
    }
  }

  const constraintHints = [
    ...buildConstraintTacticHints(constraintTactics),
    ...collectConstraintSignalHints(constraints, combinedJobText),
  ];

  const jobBoardMetadata = {
    job_location: jobParsed.job_location,
    work_model: jobParsed.work_model,
    job_type: jobParsed.job_type,
    benefits: jobParsed.benefits,
    commitments: jobParsed.commitments,
    metadata_constraint_notes: jobParsed.metadata_constraint_notes,
  };
  const jobBoardMetadataForScorer = buildJobBoardMetadataForScorer(jobBoardMetadata, constraints);

  const hardRequirementsForVeto = [
    ...jobParsed.required_skills,
    jobParsed.required_seniority,
    jobParsed.education ?? "",
    jobParsed.work_model,
    jobParsed.job_type,
  ].filter((v) => typeof v === "string" && v.trim().length > 0 && v.toLowerCase() !== "unknown");

  const universalConstraintConflict = detectUniversalNegativeConstraintConflict(
    constraints,
    hardRequirementsForVeto,
  );
  const noCodeConstraint = detectNoCodeConstraint(constraints);
  const requiredProgrammingSkill = detectProgrammingRequirement(
    jobParsed.required_skills,
    combinedJobText,
  );
  const hardVetoReason =
    universalConstraintConflict
      ? `Vetoed: You explicitly excluded "${universalConstraintConflict}", but it is a required condition for this role.`
      : noCodeConstraint && requiredProgrammingSkill
      ? `Vetoed: This role requires ${requiredProgrammingSkill}, which you explicitly excluded.`
      : null;

  let semanticReview = hardVetoReason
    ? buildHardVetoReview(score, hardVetoReason)
    : await semanticFitScoreReviewWithLlm({
        constraints,
        preferredLocation,
        jobTextEnglish: jobParsed.english_job_text,
        combinedJobText,
        jobBoardMetadata: jobBoardMetadataForScorer,
        jobStructForScorer: {
          required_skills: jobParsed.required_skills,
          optional_skills: jobParsed.optional_skills,
          required_seniority: jobParsed.required_seniority,
          experience_years: experienceYearsForScoring,
          education: jobParsed.education,
        },
        cvSkills: cvParsed.skills,
        coreStories: cvParsed.core_stories ?? [],
        cvSnippet: prunedCv,
        baseline: score,
        constraintHints,
        model,
        correctionsBlock,
        tactics: constraintTactics,
        skillSynonymsPromptJson: JSON.stringify(synonymPairsForPrompt).slice(0, 1500),
        role: "analysis",
      });

  if (!hardVetoReason) {
    semanticReview = applyTacticsVetoRelaxation(semanticReview, score, constraintTactics);
  }

  // Run Salary Oracle (resilient)
  let salaryOracleResult: Awaited<ReturnType<typeof runSalaryOracle>> = { salary_analysis: null };
  try {
    salaryOracleResult = await runSalaryOracle({
      jobText: input.job,
      jobParsed,
      constraints,
      model,
      preferredCurrency: userPrefs.preferred_currency,
    });
  } catch (err) {
    console.error('[Pipeline] Salary Oracle failed:', err);
  }

  const summaryPieces: string[] = [];
  if (semanticReview.vetoed) {
    summaryPieces.push(`VETO: ${semanticReview.veto_reason ?? "Hard constraint violation."}`);
  }
  if (semanticReview.narrative_summary) {
    summaryPieces.push(semanticReview.narrative_summary);
  }
  const summary =
    summaryPieces.length > 0
      ? summaryPieces.join("\n\n")
      : semanticReview.one_sentence_summary;

  const strengthHighlights = selectStrengthHighlights(
    cvParsed.core_stories,
    jobParsed.required_skills,
  );
  const analysisSource =
    cvParsed.parser_source === "llm" && jobParsed.parser_source === "llm"
      ? "llm"
      : "fallback";

  // Attach salary analysis (defensive: fallback to null if missing)
  const salary_analysis = salaryOracleResult?.salary_analysis ?? null;

  const interview_prep = interviewPrepFromUnknown(semanticReview.interview_prep, 3);

  const jobSource: JobSourceKind = input.job_source ?? "manual";

  return {
    result: {
      job_source: jobSource,
      fit_score: semanticReview.fit_score,
      matched_skills: semanticReview.matched_skills,
      missing_skills: semanticReview.missing_skills,
      strength_highlights: strengthHighlights,
      seniority_match: semanticReview.seniority_match,
      summary,
      one_sentence_summary: semanticReview.one_sentence_summary,
      mathematical_breakdown: semanticReview.mathematical_breakdown,
      vibe_warnings: semanticReview.vibe_warnings,
      semantic_highlights: semanticReview.semantic_highlights,
      constraint_veto: semanticReview.vetoed,
      match_strength: semanticReview.vetoed ? "Vetoed" : "Normal",
      salary_analysis,
      extracted_entities: {
        required_skills: jobParsed.required_skills,
        optional_skills: jobParsed.optional_skills,
        experience_years: userExperienceOverride ?? experienceYearsForScoring,
        education: jobParsed.education,
        job_location: jobParsed.job_location,
        work_model: jobParsed.work_model,
        job_type: jobParsed.job_type,
        benefits: jobParsed.benefits,
        commitments: jobParsed.commitments,
        metadata_constraint_notes: jobParsed.metadata_constraint_notes,
      },
      metadata_fit_badge: semanticReview.metadata_fit_badge,
      analysis_model: model,
      interview_prep,
      irrelevant_extra_skills: semanticReview.irrelevant_extra_skills,
      debug: {
        analysis_source: analysisSource,
        cv_parser_source: cvParsed.parser_source,
        job_parser_source: jobParsed.parser_source,
        constraints_source: "llm",
        fit_score_reconciled_from_components: semanticReview.fit_score_reconciled_from_components,
        cv_evidence_pass: cvEvidencePass,
        constraint_tactics_snapshot: constraintTactics.tactics as Record<string, string>,
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
