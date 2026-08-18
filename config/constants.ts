/**
 * Central configuration: defaults, timeouts, and size limits.
 * Import from here instead of scattering magic numbers across `lib/`.
 */

/**
 * Default Ollama model tag when none is provided or discovery fails (dashboard can override
 * via user preferences). `gemma3n:e4b` is a real, lightweight, schema-tuned Gemma tag; the
 * previous `gemma4:e4b` value is not a valid Ollama model and always failed the install check.
 */
export const DEFAULT_OLLAMA_MODEL = "gemma3n:e4b";

/** Ollama client HTTP timeout (all `/api/*` calls): see `OLLAMA_TIMEOUT` in `lib/llm/ollama.ts`. */

/** Job text slicing limits for parsing and pipeline context. */
export const JOB_TEXT_LIMITS = {
  truncateForTranslation: 6000,
  languagePrepInputMax: 14_000,
  entityExtractionSlice: 16_000,
  // Reduced from 20_000 to keep the semantic fit prompt (sliced to jobMixChars below) lean —
  // long Gemma prompts have repeatedly broken JSON output mid-generation (position ~2300–2400).
  combinedJobForScoring: 12_000,
} as const;

/** CV text shaping for the semantic scorer (pruning / context window). */
export const CV_CONTEXT_LIMITS = {
  prunedSkillsMax: 45,
  coreStoriesMax: 8,
  experienceSnippetsMaxChars: 1800,
  /** Work-experience region after section header (parallel to heuristic experience_lines). */
  recentExperienceSectionMaxChars: 2200,
  prunedBlockMaxChars: 4000,
  userProfileJoinMax: 8000,
  experienceLineMaxChars: 200,
  experienceSnippetLinesMin: 6,
} as const;

/** Second-pass CV evidence LLM (missing skills only). */
export const CV_EVIDENCE_PASS_LIMITS = {
  maxMissingSkills: 14,
  cvTextChars: 12_000,
  /** Max JSON length for CONSTRAINTS array injected into the evidence prompt. */
  constraintsJsonMaxChars: 4000,
} as const;

/** Shape USER_SKILL_SYNONYMS in the semantic scorer prompt without mid-JSON truncation. */
export const SEMANTIC_SCORER_SYNONYM_PROMPT_LIMITS = {
  maxPairs: 28,
  maxFieldChars: 80,
} as const;

/** LLM synonym suggestions after CV upload (pending user approval). */
export const SKILL_SYNONYM_SUGGEST_LIMITS = {
  maxPairsFromLlm: 16,
  cvTextChars: 10_000,
  maxPendingStored: 48,
} as const;

/** AI skill phrase suggestions (Analysis; pending until user approves into CV skills list). */
export const CV_SKILL_SUGGEST_LIMITS = {
  maxFromLlm: 14,
  cvTextChars: 10_000,
  maxPendingStored: 48,
  maxPhraseChars: 80,
  maxSkillsStored: 200,
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

/**
 * Truncation for the semantic scorer LLM prompt (token budget).
 * Trimmed from {cvSnippet:3500, jobText:7000, jobMix:3500} after Gemma-family models
 * truncated JSON output near char ~2300 on long postings — keeps total prompt under
 * the model's effective context window (Gemma 3 e4b sliding-window base is 8192).
 */
export const SEMANTIC_SCORER_PROMPT_LIMITS = {
  cvSnippetChars: 2800,
  jobTextChars: 5000,
  jobMixChars: 2800,
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

/**
 * First pipeline batch size after each discovery fetch (remaining jobs stay in eval queue).
 * Each job runs the full Ollama veto pipeline — this dominates wall time after fetch.
 * Set `ELIZA_DISCOVERY_SYNC_EVAL_BATCH=0` to skip in-sync analysis (fetch only; drain via process-queue).
 * While providers are still fetching, new listings are evaluated one-at-a-time unless
 * `ELIZA_DISCOVERY_EVAL_DURING_FETCH=0`.
 */
const _syncEval = parseInt(process.env.ELIZA_DISCOVERY_SYNC_EVAL_BATCH ?? "", 10);
export const DISCOVERY_SYNC_EVAL_BATCH = Number.isFinite(_syncEval)
  ? Math.min(20, Math.max(0, _syncEval))
  : 2;

/**
 * Default batch for POST /api/discovery/process-queue (each round). Override with `ELIZA_DISCOVERY_QUEUE_DRAIN_BATCH`.
 */
const _drainBatch = parseInt(process.env.ELIZA_DISCOVERY_QUEUE_DRAIN_BATCH ?? "", 10);
export const DISCOVERY_QUEUE_DRAIN_BATCH = Number.isFinite(_drainBatch)
  ? Math.min(20, Math.max(1, _drainBatch))
  : 4;

/**
 * Discovery pipeline failure handling: how many attempts before a job is treated as
 * evaluated (written to non-matches with the error), and the cooldown between retries
 * within the same drain. Override with `ELIZA_DISCOVERY_FAILURE_MAX_ATTEMPTS` and
 * `ELIZA_DISCOVERY_FAILURE_COOLDOWN_MS`.
 */
const _failMax = parseInt(process.env.ELIZA_DISCOVERY_FAILURE_MAX_ATTEMPTS ?? "", 10);
export const DISCOVERY_FAILURE_MAX_ATTEMPTS = Number.isFinite(_failMax)
  ? Math.min(10, Math.max(1, _failMax))
  : 3;

const _failCooldown = parseInt(process.env.ELIZA_DISCOVERY_FAILURE_COOLDOWN_MS ?? "", 10);
export const DISCOVERY_FAILURE_COOLDOWN_MS = Number.isFinite(_failCooldown)
  ? Math.max(0, _failCooldown)
  : 30 * 60 * 1000;

/**
 * How many trailing `jobs.jsonl` rows sync uses when merging the evaluation backlog.
 * Keep aligned with the default reevaluate catalog window (`loadDiscoveredJobsAll`) so older
 * unevaluated rows are not invisible to sync-only queueing.
 */
export const DISCOVERY_SYNC_BACKLOG_MAX_JOBS = 5000;

/**
 * HTTP timeout for discovery source fetches (LinkedIn guest, Indeed/Profession detail enrich, Profession list).
 * Override with `ELIZA_DISCOVERY_HTTP_FETCH_TIMEOUT_MS`, or legacy `ELIZA_LINKEDIN_GUEST_FETCH_TIMEOUT_MS`.
 */
const _discHttpMs = parseInt(
  process.env.ELIZA_DISCOVERY_HTTP_FETCH_TIMEOUT_MS ?? process.env.ELIZA_LINKEDIN_GUEST_FETCH_TIMEOUT_MS ?? "",
  10,
);
export const DISCOVERY_HTTP_FETCH_TIMEOUT_MS = Number.isFinite(_discHttpMs)
  ? Math.min(120_000, Math.max(8_000, _discHttpMs))
  : 45_000;

/** @deprecated Use {@link DISCOVERY_HTTP_FETCH_TIMEOUT_MS} (same value). */
export const LINKEDIN_GUEST_FETCH_TIMEOUT_MS = DISCOVERY_HTTP_FETCH_TIMEOUT_MS;

/** `ollama list` subprocess timeout (ms). */
export const OLLAMA_LIST_TIMEOUT_MS = 20_000;

/** Max stdout buffer for `ollama list` (bytes). */
export const OLLAMA_LIST_MAX_BUFFER_BYTES = 1024 * 1024;
