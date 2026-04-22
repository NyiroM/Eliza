import type { ParserSource } from "../lib/llm/ollama";

export type WorkModel = "on-site" | "hybrid" | "remote" | "unknown";

export type JobTypeCategory =
  | "full-time"
  | "part-time"
  | "contract"
  | "temporary"
  | "volunteer"
  | "internship"
  | "unknown";

export type JobParseResult = {
  required_skills: string[];
  optional_skills: string[];
  estimated_salary: string | null;
  required_seniority: "junior" | "mid" | "senior" | "lead" | "unknown";
  /** Minimum years of experience stated in the posting, if any. */
  experience_years: number | null;
  /** Required or preferred education level, free text. */
  education: string | null;
  /** City, region, and/or country when stated (English). */
  job_location: string | null;
  work_model: WorkModel;
  job_type: JobTypeCategory;
  /** Listed perks (insurance, retirement, leave, etc.). */
  benefits: string[];
  /** Cultural / values commitments (DEI, sustainability, work-life balance, etc.). */
  commitments: string[];
  /** LLM notes on how extracted metadata aligns or conflicts with user_constraints (if any were provided). */
  metadata_constraint_notes: string[];
  parser_source: ParserSource;
  /** English text used for entity extraction (original or translated). */
  english_job_text: string;
  /** Heuristic skipped the translate LLM (job + CV detected English). */
  translation_skipped?: boolean;
};
