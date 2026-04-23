/**
 * Shared pipeline API and semantic-scoring types (dashboard + `/api/pipeline`).
 */

export type ScoreComponents = {
  base_semantic: number;
  skill_overlap_delta: number;
  experience_delta: number;
  constraint_delta: number;
  advantage_bonus: number;
};

export type SemanticHighlight = {
  phrase: string;
  sentiment: "positive" | "negative";
  reason: string;
};

export type PipelineInput = {
  job: string;
  /** Ollama model tag used for all LLM stages in this run. */
  model?: string;
  /**
   * If set (including ""), used for this run: non-empty = preferred place; empty = open to any location.
   * If omitted (undefined), falls back to saved dashboard preference from storage.
   */
  preferred_location?: string | null;
};

export type SalaryAnalysis = {
  /** Hays role label matched (e.g., "Automation Engineer"). */
  hays_matched_label?: string;
  /** Confidence 0–1 in the match. */
  confidence_score: number;
  /** Low confidence flag (e.g., ambiguous title). */
  low_confidence?: boolean;
  /** Estimated minimum gross monthly salary (HUF). */
  estimated_min: number;
  /** Estimated maximum gross monthly salary (HUF). */
  estimated_max: number;
  /** Estimated typical (modus) gross monthly salary (HUF). */
  estimated_modus: number;
  /** Comparison vs user floor. */
  match_status: "above_limit" | "borderline" | "below_limit";
  /** Short rationale for the user. */
  rationale: string;
  /** Where salary came from: posted ad or benchmark lookup. */
  source: "posted" | "market_benchmark";
  /** ISO currency code used by this analysis. */
  currency: "USD" | "EUR" | "GBP" | "HUF" | "PLN" | "JPY";
  /** Structured base salary for compensation split. */
  base_salary: {
    estimated_min: number;
    estimated_max: number;
    estimated_modus: number;
    basis: "gross" | "net";
  };
  /** True when bonus/commission/incentive signals are present. */
  bonus_detected: boolean;
  /** Qualitative benefits indicators (cafeteria, equity, insurance, etc.). */
  benefits_value: string | null;
  /** Estimated net from gross when normalization is needed. */
  normalized_net_estimate?: number;
  /** Currency used for floor comparison and normalized display. */
  comparison_currency: "USD" | "EUR" | "GBP" | "HUF" | "PLN" | "JPY";
  /** Normalized min/max/modus in comparison_currency. */
  normalized_estimated_min: number;
  normalized_estimated_max: number;
  normalized_estimated_modus: number;
  /** True when normalized values differ from original posting currency. */
  conversion_applied: boolean;
  /** Baseline rate used for normalization, e.g. "1 EUR = 400 HUF". */
  exchange_rate_used?: string;
};

export type InterviewPrepItem = {
  question: string;
  cheat_sheet: string;
};

export type PipelineOutput = {
  fit_score: number;
  matched_skills: string[];
  missing_skills: string[];
  strength_highlights: string[];
  seniority_match: boolean;
  summary: string;
  /** Single headline sentence for the user (most important factor). */
  one_sentence_summary: string;
  /** Model name used for this analysis (from client or default). */
  analysis_model: string;
  extracted_entities: {
    required_skills: string[];
    optional_skills: string[];
    experience_years: number | null;
    education: string | null;
    job_location: string | null;
    work_model: string;
    job_type: string;
    benefits: string[];
    commitments: string[];
    metadata_constraint_notes: string[];
  };
  /** Badge from location / work-model / job-type fit vs constraints, or benefits match. */
  metadata_fit_badge: "Location Conflict" | "Preference Match" | null;
  /** Hard veto: score forced to 0% by constraint violation. */
  constraint_veto: boolean;
  /** Optional high-level label for output state. */
  match_strength?: "Vetoed" | "Normal";
  /** LLM step-by-step score math (required when semantic scoring runs). */
  mathematical_breakdown: string;
  /** Hiring-post vagueness / risk signals from vibe scan (non-blocking). */
  vibe_warnings: string[];
  /** Job-text phrases that most influenced the score (for UI highlighter). */
  semantic_highlights: SemanticHighlight[];
  /** Skills present in CV but not required by job (user’s unused superpowers). */
  irrelevant_extra_skills?: string[];
  /** Hays-2026 salary analysis for the role. */
  salary_analysis?: SalaryAnalysis | null;
  /** Interview prep: 3 targeted questions + Cheat Sheet answers based on critical gaps and transferable skills. */
  interview_prep?: InterviewPrepItem[];
  debug: {
    analysis_source: "llm" | "fallback";
    cv_parser_source: "llm" | "fallback";
    job_parser_source: "llm" | "fallback";
    constraints_source: "llm" | "fallback";
    /** True when fit_score was aligned to the sum of structured score_components. */
    fit_score_reconciled_from_components: boolean;
  };
};

export type PipelineContext = {
  cv_text: string;
  core_stories: string[];
  required_skills: string[];
  /** English job text used for extraction and generation. */
  job_text_english: string;
};

export type PipelineDetailedResult = {
  result: PipelineOutput;
  context: PipelineContext;
};
