/**
 * Central configuration: defaults, timeouts, and size limits.
 * Import from here instead of scattering magic numbers across `lib/`.
 */

/** Default Ollama model tag when none is provided or discovery fails. */
export const DEFAULT_OLLAMA_MODEL = "deepseek-r1:8b";

/** Ollama client HTTP timeout (all `/api/*` calls): see `OLLAMA_TIMEOUT` in `lib/llm/ollama.ts`. */

/** Job text slicing limits for parsing and pipeline context. */
export const JOB_TEXT_LIMITS = {
  truncateForTranslation: 6000,
  languagePrepInputMax: 14_000,
  entityExtractionSlice: 16_000,
  combinedJobForScoring: 20_000,
} as const;

/** CV text shaping for the semantic scorer (pruning / context window). */
export const CV_CONTEXT_LIMITS = {
  prunedSkillsMax: 45,
  coreStoriesMax: 8,
  experienceSnippetsMaxChars: 2400,
  prunedBlockMaxChars: 4000,
  userProfileJoinMax: 8000,
  experienceLineMaxChars: 200,
  experienceSnippetLinesMin: 6,
} as const;

/** API validation (also documented in README). */
export const JOB_DESCRIPTION_MAX_CHARS = 100_000;
export const JOB_DESCRIPTION_MIN_CHARS = 20;
export const CV_PDF_MAX_BYTES = 12 * 1024 * 1024;
export const PREFERRED_LOCATION_MAX_CHARS = 500;
export const OLLAMA_MODEL_MAX_LEN = 128;

/** Semantic highlight payload shaping (LLM output → UI). */
export const SEMANTIC_HIGHLIGHT_LIMITS = {
  phraseMaxChars: 500,
  reasonMaxChars: 400,
  parseScanMax: 6,
  returnMax: 5,
} as const;

/** Truncation for the semantic scorer LLM prompt (token budget). */
export const SEMANTIC_SCORER_PROMPT_LIMITS = {
  cvSnippetChars: 3500,
  jobTextChars: 7000,
  jobMixChars: 3500,
} as const;

/**
 * English-first heuristic (no LLM): high-confidence English ⇒ skip translation;
 * ambiguous or clearly non-English ⇒ run automatic translation prep.
 * Tunables only — token patterns live next to `isLikelyEnglishText` in `jobParser.ts`.
 */
export const ENGLISH_DETECTION_SAMPLE_MAX_CHARS = 8000;

/** Weighted signal score at or above this ⇒ treat sample as English. */
export const ENGLISH_DETECTION_MIN_SCORE_SKIP_TRANSLATION = 18;

/** If German orthography appears in this prefix, prefer the translator path. */
export const ENGLISH_DETECTION_GERMAN_PROBE_MAX_CHARS = 3000;

/** Extra weight per job-vocabulary token match. */
export const ENGLISH_DETECTION_JOB_LEXEME_WEIGHT = 2;

/** Extra weight per strong phrase match (e.g. "key responsibilities"). */
export const ENGLISH_DETECTION_PHRASE_BONUS_WEIGHT = 2;

/** `ollama list` subprocess timeout (ms). */
export const OLLAMA_LIST_TIMEOUT_MS = 20_000;

/** Max stdout buffer for `ollama list` (bytes). */
export const OLLAMA_LIST_MAX_BUFFER_BYTES = 1024 * 1024;
