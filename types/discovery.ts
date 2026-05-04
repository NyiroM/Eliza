/**
 * Discovery Hub: provider sync, local storage, and high-match rows.
 */

export type DiscoveryProviderId = "indeed" | "linkedin" | "profession";

export type DiscoveryProviderState = {
  auto: boolean;
  last_run_at: string | null;
  /** Raw listing rows returned this fetch (capped by sync max, often 28). */
  last_jobs_found: number;
  /** New rows actually added to the local catalog this fetch (deduped vs existing + batch). */
  last_jobs_new_to_catalog: number;
  last_error: string | null;
  /** Short UI hint from last sync (e.g. zero-hit broadening, HTTP 403). */
  last_search_hint: string | null;
};

export type DiscoveryKeywordSuggestionStatus = "suggested" | "approved" | "rejected";

export type DiscoveryKeywordSuggestion = {
  phrase: string;
  status: DiscoveryKeywordSuggestionStatus;
  /** Manual keyword this row was generated from (Ollama suggest flow). */
  source_keyword?: string;
};

export type DiscoverySettings = {
  auto_sync_interval_minutes: number;
  match_notify_threshold_percent: number;
  /** Comma-separated phrases used on sync (typed and/or appended when you approve AI suggestions). */
  search_keywords: string;
  /** AI-generated phrases pending review; approving copies into `search_keywords` and removes the row. */
  keyword_suggestions: DiscoveryKeywordSuggestion[];
  providers: Record<DiscoveryProviderId, DiscoveryProviderState>;
};

export type DiscoveredJob = {
  id: string;
  provider: DiscoveryProviderId;
  title: string;
  company: string | null;
  url: string;
  description: string;
  discovered_at: string;
};

export type DiscoveryMatchRow = {
  job_id: string;
  provider: DiscoveryProviderId;
  title: string;
  url: string;
  fit_score: number;
  constraint_veto: boolean;
  evaluated_at: string;
  one_sentence_summary?: string;
};

/** Evaluated listing that did not qualify for New matches (veto and/or below threshold). */
export type DiscoveryNonMatchRow = {
  job_id: string;
  provider: DiscoveryProviderId;
  title: string;
  url: string;
  fit_score: number;
  constraint_veto: boolean;
  evaluated_at: string;
  /** AI headline for the listing (same role as on matches). */
  one_sentence_summary?: string;
  /** Plain explanation of why this row is not under New matches. */
  not_match_reason: string;
};

export type DiscoverySyncResult = {
  ok: boolean;
  /** When false, e.g. no search keywords configured. */
  blocked?: string;
  locked?: boolean;
  providers_run: DiscoveryProviderId[];
  jobs_added: number;
  jobs_evaluated: number;
  new_high_matches: number;
  /** Jobs still waiting for pipeline (deep analysis) after this run. */
  queue_remaining: number;
  errors: Partial<Record<DiscoveryProviderId, string>>;
  /** Per-provider count of fetched jobs whose ids were already known (existing jobs.jsonl or this batch). */
  duplicates_skipped?: Partial<Record<DiscoveryProviderId, number>>;
  /** Jobs that failed the pipeline this run but will retry next sync. */
  failures_pending_retry?: number;
  /** Jobs that failed the pipeline and have hit the max retry budget. */
  failures_permanent?: number;
};

/** Cumulative counters for the current sync/drain (shown in Live progress). */
export type DiscoverySessionLiveStats = {
  newJobsAdded: number;
  jobsEvaluated: number;
  newHighMatches: number;
  queueRemaining: number;
};

export type DiscoveryProgressState = {
  phase: "idle" | "fetching" | "queueing" | "analyzing" | "draining";
  provider?: DiscoveryProviderId;
  analysisIndex?: number;
  analysisTotal?: number;
  message: string;
  updatedAt: string;
  /** Current seed phrase index (1-based) within this provider’s capped seed list. */
  fetchKeywordIndex?: number;
  fetchKeywordTotal?: number;
  /** Truncated phrase text for UI/log. */
  fetchPhrase?: string;
  /** Full comma-separated keyword list length (Search keywords). */
  keywordsInListTotal?: number;
  /** How many seed phrases this provider run will try (≤ ELIZA_DISCOVERY_MAX_SEED_PHRASES). */
  fetchSeedsTotal?: number;
  /** ms spent on the last completed seed phrase fetch. */
  fetchPhraseDurationMs?: number;
  sessionLiveStats?: DiscoverySessionLiveStats;
};

export type DiscoveryProcessQueueResult = {
  ok: boolean;
  locked?: boolean;
  processed: number;
  new_high_matches: number;
  queue_remaining: number;
  jobs_evaluated: number;
  failures_pending_retry?: number;
  failures_permanent?: number;
};
