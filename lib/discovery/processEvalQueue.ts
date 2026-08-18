// lib/discovery/processEvalQueue.ts
import type { DiscoveryProviderId, DiscoverySalaryForecastSnapshot } from "../../types/discovery";
import type { JobSourceKind, PipelineOutput, SalaryAnalysis, SalaryForecastDisplay } from "../../types/pipeline";
import { DEFAULT_OLLAMA_MODEL, DISCOVERY_FAILURE_MAX_ATTEMPTS } from "../../config/constants";
import { runPipelineDetailed } from "../pipeline";
import { addEvaluatedJobIds, loadEvaluatedJobIds } from "./evaluatedStore";
import { clearEvalFailure, pruneEvalFailures, recordEvalFailure } from "./evalFailureStore";
import { buildJobTextForPipeline } from "./jobText";
import { hydrateThinIndeedJobs } from "./refreshThinIndeedCatalog";
import { appendNewMatch } from "./matchesStore";
import { appendNonMatch } from "./nonMatchesStore";
import { loadDiscoverySettings } from "./settings";
import { discoveryEvalQuarterIndex, discoveryTerminalLog } from "./discoveryTerminalLog";
import {
  getEvalQueueActionableLength,
  getEvalQueueLength,
  returnToEvalQueue,
  takeFromEvalQueue,
} from "./evalQueue";
import {
  bumpDiscoveryProgressClock,
  defaultSessionLiveStats,
  type EvalQueueProgressMeta,
  progressAnalyzing,
  progressDraining,
  readDiscoveryProgress,
  setDiscoveryProgress,
} from "./progress";
import { scheduleEvalQueueResumeIfNeeded } from "./scheduleEvalQueueResume";
import { loadSuppressedFilter } from "./suppressedStore";
import { buildPipelineFailureNotMatchReason } from "./evalFailureReason";
import { textClaimsHardVeto } from "../pipeline/semanticVetoConsistency";

// Discovery card rationale: kept long enough for "Hays 2026 …  +X% hot-skills … heat very_hot
// … synthetic estimate (diag) Refined: …" without truncation; trimmed cleanly at the last
// sentence/word boundary so we never break mid-token.
const SALARY_FORECAST_SNAPSHOT_MAX = 360;

function truncateRationale(raw: string, limit: number): string {
  const s = raw.trim();
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const lastBoundary = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' · '), cut.lastIndexOf(') '));
  if (lastBoundary > limit * 0.6) return `${cut.slice(0, lastBoundary + 1).trim()}…`;
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

function truncateSalaryDisplay(d: SalaryForecastDisplay): SalaryForecastDisplay {
  return {
    estimate_headline: truncateRationale(d.estimate_headline, 240),
    low_confidence: d.low_confidence,
    source_from_posting: d.source_from_posting,
    benchmark_basis: d.benchmark_basis
      ? {
          discipline: d.benchmark_basis.discipline
            ? truncateRationale(d.benchmark_basis.discipline, 80)
            : null,
          seniority: truncateRationale(d.benchmark_basis.seniority, 36),
          position: truncateRationale(d.benchmark_basis.position, 140),
        }
      : null,
    floor_comparison: truncateRationale(d.floor_comparison, 260),
    supplement: d.supplement ? truncateRationale(d.supplement, SALARY_FORECAST_SNAPSHOT_MAX) : undefined,
  };
}

function salaryForecastSnapshot(s: SalaryAnalysis | null | undefined): DiscoverySalaryForecastSnapshot | undefined {
  if (!s) return undefined;
  return {
    match_status: s.match_status,
    source: s.source,
    rationale: truncateRationale(s.rationale, SALARY_FORECAST_SNAPSHOT_MAX),
    display: s.salary_forecast_display ? truncateSalaryDisplay(s.salary_forecast_display) : undefined,
  };
}

function jobSourceForProvider(p: DiscoveryProviderId): JobSourceKind {
  if (p === "indeed") return "discovery_indeed";
  if (p === "linkedin") return "discovery_linkedin";
  return "discovery_profession";
}

function vetoHeadlineFromPipelineOutput(r: PipelineOutput): string | null {
  const summary = (r.summary ?? "").trim();
  const fromSummary = summary.match(/^VETO:\s*([\s\S]+?)(?:\n\n|$)/)?.[1]?.trim();
  if (fromSummary) return fromSummary;
  const line = (r.one_sentence_summary ?? "").trim();
  if (!line) return null;
  return line.replace(/^veto(ed)?:\s*/i, "").trim() || line;
}

function pipelineLooksVetoed(r: PipelineOutput): boolean {
  return (
    r.constraint_veto === true ||
    r.match_strength === "Vetoed" ||
    textClaimsHardVeto(r.one_sentence_summary) ||
    textClaimsHardVeto(r.summary)
  );
}

/** User-facing line(s) for storage and Dashboard (non-match list). */
function buildNotMatchReason(r: PipelineOutput, threshold: number): string {
  const vetoed = pipelineLooksVetoed(r);
  const score = typeof r.fit_score === "number" ? r.fit_score : null;
  const below = score === null || score < threshold;

  const parts: string[] = [];
  if (vetoed) {
    const headline = vetoHeadlineFromPipelineOutput(r);
    if (headline) {
      parts.push(/^(rejected|veto)/i.test(headline) ? headline : `Veto: ${headline}`);
    } else parts.push("Did not pass the veto (hard constraints or listing marked Vetoed).");
  }
  if (below && !vetoed) {
    if (score === null) parts.push("No numeric fit score reached your match threshold.");
    else parts.push(`Fit score ${score}% is below your ${threshold}% match threshold.`);
  }
  if (parts.length === 0) parts.push("Did not qualify as a new match.");
  return parts.join(" ");
}

export type ProcessEvalQueueOpts = {
  model: string;
  preferred_location?: string | null;
  maxItems: number;
  /** When true, use "draining" phase label (queue continuation). */
  draining?: boolean;
  /** Skip progress finalize + in-process drain timer (caller still holds sync lock). */
  deferCompletion?: boolean;
};

export type ProcessEvalQueueResult = {
  processed: number;
  new_high_matches: number;
  jobs_evaluated: number;
  queue_remaining: number;
  /** Items that could run now (excludes failure-cooldown-only rows). */
  actionable_remaining: number;
  /** Jobs whose pipeline run failed this round but will retry next sync. */
  failures_pending_retry: number;
  /** Jobs whose pipeline run failed and reached max attempts (non_matches.jsonl + evaluated_ids). */
  failures_permanent: number;
};

/**
 * Runs full Veto pipeline on the next `maxItems` queued jobs (highest heuristic priority first).
 * Rows that strictly pass `!constraint_veto && fit_score >= threshold` increment `new_high_matches`
 * and are appended to new_matches.jsonl. Other successful evaluations, and jobs that hit the
 * pipeline-failure attempt cap, are appended to non_matches.jsonl (never silent).
 */
export async function processEvalQueue(opts: ProcessEvalQueueOpts): Promise<ProcessEvalQueueResult> {
  const settings = await loadDiscoverySettings();
  const threshold = Math.min(100, Math.max(0, settings.match_notify_threshold_percent));
  const model = opts.model.trim() || DEFAULT_OLLAMA_MODEL;
  const evaluated = await loadEvaluatedJobIds();
  const suppressedFilter = await loadSuppressedFilter();
  for (const id of suppressedFilter.ids) evaluated.add(id);
  const prevForWave = await readDiscoveryProgress();
  const sWave = prevForWave.sessionLiveStats ?? defaultSessionLiveStats();
  const queueBeforeTake = await getEvalQueueLength();
  const batchBaseJobs = sWave.jobsEvaluated;
  const grandFromPrev =
    typeof prevForWave.evalSessionGrandTotal === "number" && prevForWave.evalSessionGrandTotal > 0
      ? prevForWave.evalSessionGrandTotal
      : batchBaseJobs + queueBeforeTake;
  const evalSessionGrandTotal = Math.max(1, grandFromPrev);
  const queueMeta: EvalQueueProgressMeta = {
    evalSessionGrandTotal,
    evalBatchBaseJobsEvaluated: batchBaseJobs,
  };

  const batch = await takeFromEvalQueue(opts.maxItems, evaluated, suppressedFilter);
  if (batch.some((j) => j.provider === "indeed")) {
    const hydrated = await hydrateThinIndeedJobs(batch);
    if (hydrated.length > 0) {
      discoveryTerminalLog(`phase=eval_indeed_hydrate n=${hydrated.length}`);
    }
  }

  let newHighMatches = 0;
  let processed = 0;
  let failuresPendingRetry = 0;
  let failuresPermanent = 0;
  const completedIds: string[] = [];

  const total = batch.length;
  const leftoverAfterTake = await getEvalQueueLength();
  const evalRunStartedAt = prevForWave.evalLane?.eval_run_started_at ?? new Date().toISOString();
  let runningEvaluated = prevForWave.evalLane?.jobs_evaluated ?? sWave.jobsEvaluated;
  let runningHigh = prevForWave.evalLane?.high_matches ?? sWave.newHighMatches;
  let timedJobs = prevForWave.evalLane?.timed_jobs ?? 0;
  let timedJobsMs = prevForWave.evalLane?.timed_jobs_ms ?? 0;
  const phase = opts.draining ? "draining" : "analyzing";
  discoveryTerminalLog(
    total === 0
      ? `phase=eval_batch_start mode=${phase} batch=0 maxItems=${opts.maxItems} (queue empty or nothing due)`
      : `phase=eval_batch_start mode=${phase} batch=${total} maxItems=${opts.maxItems}`,
  );

  if (total === 0) {
    await setDiscoveryProgress({
      evalLane: {
        status: "waiting",
        jobs_evaluated: runningEvaluated,
        queue_remaining: leftoverAfterTake,
        high_matches: runningHigh,
        timed_jobs: timedJobs,
        timed_jobs_ms: timedJobsMs,
      },
    });
  }

  for (let i = 0; i < batch.length; i += 1) {
    const job = batch[i];
    const idx = i + 1;
    const msg = `Analyzing job ${idx}/${total} (${job.provider}) — ${job.title.slice(0, 48)}${job.title.length > 48 ? "…" : ""}`;
    const jobStartedAt = new Date().toISOString();
    const jobStartedMs = Date.now();
    const evalPatch = {
      status: "running" as const,
      jobs_evaluated: runningEvaluated,
      queue_remaining: leftoverAfterTake + (total - i),
      high_matches: runningHigh,
      current_title: job.title,
      current_provider: job.provider,
      job_started_at: jobStartedAt,
      eval_run_started_at: evalRunStartedAt,
      timed_jobs: timedJobs,
      timed_jobs_ms: timedJobsMs,
    };
    if (opts.draining) {
      await progressDraining(idx, total, msg, queueMeta, evalPatch);
    } else {
      await progressAnalyzing(idx, total, msg, queueMeta, evalPatch);
    }
    if (discoveryEvalQuarterIndex(idx, total)) {
      discoveryTerminalLog(`phase=eval_progress mode=${phase} job=${idx}/${total} provider=${job.provider}`);
    }

    const progressHeartbeatMs = 45_000;
    const heartbeat = setInterval(() => {
      void bumpDiscoveryProgressClock();
    }, progressHeartbeatMs);
    try {
      const prepared = await buildJobTextForPipeline(job);
      if (prepared.stillThin) {
        processed += 1;
        runningEvaluated += 1;
        completedIds.push(job.id);
        await clearEvalFailure(job.id);
        await appendNonMatch({
          job_id: job.id,
          provider: job.provider,
          company: job.company ?? null,
          title: job.title,
          url: job.url,
          fit_score: 0,
          constraint_veto: false,
          evaluated_at: new Date().toISOString(),
          one_sentence_summary: "Job description too short to score after the detail-page fetch.",
          not_match_reason:
            "Listing stayed title-only after detail enrich, so it was not scored as a high match.",
        });
        continue;
      }
      const detailed = await runPipelineDetailed({
        job: prepared.text,
        model,
        job_source: jobSourceForProvider(job.provider),
        ...(opts.preferred_location !== undefined ? { preferred_location: opts.preferred_location } : {}),
      });
      processed += 1;
      runningEvaluated += 1;
      completedIds.push(job.id);
      await clearEvalFailure(job.id);
      const r = detailed.result;
      const vetoed = pipelineLooksVetoed(r);
      const strictWinner =
        !vetoed &&
        typeof r.fit_score === "number" &&
        r.fit_score >= threshold;

      if (strictWinner) {
        newHighMatches += 1;
        runningHigh += 1;
        await appendNewMatch({
          job_id: job.id,
          provider: job.provider,
          company: job.company ?? null,
          title: job.title,
          url: job.url,
          fit_score: r.fit_score,
          constraint_veto: Boolean(r.constraint_veto),
          evaluated_at: new Date().toISOString(),
          one_sentence_summary: r.one_sentence_summary,
          salary_forecast: salaryForecastSnapshot(r.salary_analysis ?? null),
        });
      } else {
        const fitScore = vetoed ? 0 : typeof r.fit_score === "number" ? r.fit_score : 0;
        await appendNonMatch({
          job_id: job.id,
          provider: job.provider,
          company: job.company ?? null,
          title: job.title,
          url: job.url,
          fit_score: fitScore,
          constraint_veto: vetoed,
          evaluated_at: new Date().toISOString(),
          one_sentence_summary: r.one_sentence_summary?.trim() || undefined,
          not_match_reason: buildNotMatchReason(r, threshold),
          salary_forecast: salaryForecastSnapshot(r.salary_analysis ?? null),
        });
      }
    } catch (e) {
      const msgErr = e instanceof Error ? e.message : String(e);
      if (msgErr.includes("No stored CV")) {
        await returnToEvalQueue([job, ...batch.slice(i + 1)]);
        break;
      }
      console.error("[discovery] eval queue item failed", job.id, msgErr);
      const attempts = await recordEvalFailure(job.id, msgErr);
      if (attempts >= DISCOVERY_FAILURE_MAX_ATTEMPTS) {
        completedIds.push(job.id);
        failuresPermanent += 1;
        runningEvaluated += 1;
        await appendNonMatch({
          job_id: job.id,
          provider: job.provider,
          company: job.company ?? null,
          title: job.title,
          url: job.url,
          fit_score: 0,
          constraint_veto: false,
          evaluated_at: new Date().toISOString(),
          one_sentence_summary: "Pipeline evaluation failed after retries.",
          not_match_reason: buildPipelineFailureNotMatchReason(attempts, msgErr),
        });
      } else {
        // Push the job back so it can be retried after the cooldown window.
        await returnToEvalQueue([job]);
        failuresPendingRetry += 1;
      }
    } finally {
      clearInterval(heartbeat);
      timedJobs += 1;
      timedJobsMs += Math.max(0, Date.now() - jobStartedMs);
      const qDisk = await getEvalQueueLength();
      const stillInBatch = total - i - 1;
      const queueLeft = qDisk + stillInBatch;
      await setDiscoveryProgress({
        sessionLiveStats: {
          jobsEvaluated: runningEvaluated,
          newHighMatches: runningHigh,
          queueRemaining: queueLeft,
        },
        evalLane: {
          jobs_evaluated: runningEvaluated,
          high_matches: runningHigh,
          queue_remaining: queueLeft,
          timed_jobs: timedJobs,
          timed_jobs_ms: timedJobsMs,
          status: queueLeft > 0 ? "running" : "waiting",
          ...(queueLeft > 0
            ? {}
            : { current_title: undefined, current_provider: undefined, job_started_at: undefined }),
        },
      });
    }
  }

  if (completedIds.length > 0) {
    await addEvaluatedJobIds(completedIds);
    await pruneEvalFailures(new Set(completedIds));
  }

  const [queue_remaining, actionable_remaining] = await Promise.all([
    getEvalQueueLength(),
    getEvalQueueActionableLength(),
  ]);

  // Always finalize progress at the end of a batch — otherwise the last "Analyzing N/N" line
  // sticks on disk forever, which both confuses the dashboard ("looks frozen") and prevents
  // the client-side auto-resume from firing after a restart (it only triggers on phase="queueing").
  if (opts.deferCompletion) {
    discoveryTerminalLog(
      `phase=eval_batch_done mode=${phase} evaluated=${processed} high_matches=${newHighMatches} queue_remaining=${queue_remaining} actionable=${actionable_remaining} retry=${failuresPendingRetry} permanent_fail=${failuresPermanent} deferred=1`,
    );
    return {
      processed,
      new_high_matches: newHighMatches,
      jobs_evaluated: processed,
      queue_remaining,
      actionable_remaining,
      failures_pending_retry: failuresPendingRetry,
      failures_permanent: failuresPermanent,
    };
  }

  if (queue_remaining === 0) {
    const prev = await readDiscoveryProgress();
    if (prev.fetchLane?.status === "running") {
      await setDiscoveryProgress({
        phase: "fetching",
        message: prev.message?.trim() || "Fetching remaining sources…",
        evalLane: {
          status: "waiting",
          jobs_evaluated: prev.evalLane?.jobs_evaluated ?? prev.sessionLiveStats?.jobsEvaluated ?? 0,
          queue_remaining: 0,
          high_matches: prev.evalLane?.high_matches ?? prev.sessionLiveStats?.newHighMatches ?? 0,
          current_title: undefined,
          current_provider: undefined,
          job_started_at: undefined,
        },
      });
    } else {
      await setDiscoveryProgress({
        evalLane: {
          status: "done",
          jobs_evaluated: prev.evalLane?.jobs_evaluated ?? prev.sessionLiveStats?.jobsEvaluated ?? 0,
          queue_remaining: 0,
          high_matches: prev.evalLane?.high_matches ?? prev.sessionLiveStats?.newHighMatches ?? 0,
          current_title: undefined,
          current_provider: undefined,
          job_started_at: undefined,
        },
      });
    }
  } else if (actionable_remaining === 0) {
    // Queue has rows but they are all in failure cooldown — drain is genuinely waiting.
    const prev = await readDiscoveryProgress();
    const s = prev.sessionLiveStats ?? defaultSessionLiveStats();
    await setDiscoveryProgress({
      phase: "queueing",
      message: `${queue_remaining} job(s) remain in the eval queue but are in pipeline failure retry cooldown — nothing runs until the cooldown window passes. Use drain again later or check Ollama logs.`,
      sessionLiveStats: { ...s, queueRemaining: queue_remaining },
      step_started_at: new Date().toISOString(),
    });
  } else if (total > 0) {
    // Batch finished, more actionable rows remain — flip back to the "awaiting drain"
    // message so the client auto-resume can pick up if this round was the last one or
    // if the server is killed between drain rounds.
    const prev = await readDiscoveryProgress();
    const s = prev.sessionLiveStats ?? defaultSessionLiveStats();
    await setDiscoveryProgress({
      phase: "queueing",
      message: `${queue_remaining} job(s) queued for deep analysis — continuing in the background…`,
      sessionLiveStats: { ...s, queueRemaining: queue_remaining },
      step_started_at: new Date().toISOString(),
    });
  }

  discoveryTerminalLog(
    `phase=eval_batch_done mode=${phase} evaluated=${processed} high_matches=${newHighMatches} queue_remaining=${queue_remaining} actionable=${actionable_remaining} retry=${failuresPendingRetry} permanent_fail=${failuresPermanent}`,
  );

  await scheduleEvalQueueResumeIfNeeded({
    model,
    preferred_location: opts.preferred_location,
    queueRemaining: queue_remaining,
    actionableRemaining: actionable_remaining,
  });

  return {
    processed,
    new_high_matches: newHighMatches,
    jobs_evaluated: processed,
    queue_remaining,
    actionable_remaining,
    failures_pending_retry: failuresPendingRetry,
    failures_permanent: failuresPermanent,
  };
}
