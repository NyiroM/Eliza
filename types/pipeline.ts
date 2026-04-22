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

export type PipelineOutput = {
  fit_score: number;
  matched_skills: string[];
  missing_skills: string[];
  strength_highlights: string[];
  seniority_match: boolean;
  summary: string;
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
  /** LLM step-by-step score math (required when semantic scoring runs). */
  mathematical_breakdown: string;
  /** Hiring-post vagueness / risk signals from vibe scan (non-blocking). */
  vibe_warnings: string[];
  /** Job-text phrases that most influenced the score (for UI highlighter). */
  semantic_highlights: SemanticHighlight[];
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
