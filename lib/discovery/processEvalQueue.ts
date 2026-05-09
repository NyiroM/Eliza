// lib/discovery/processEvalQueue.ts
import type { DiscoveryProviderId, DiscoverySalaryForecastSnapshot } from "../../types/discovery";
import type { JobSourceKind, PipelineOutput, SalaryAnalysis } from "../../types/pipeline";
import { DEFAULT_OLLAMA_MODEL, DISCOVERY_FAILURE_MAX_ATTEMPTS } from "../../config/constants";
import { runPipelineDetailed } from "../pipeline";
import { addEvaluatedJobIds, loadEvaluatedJobIds } from "./evaluatedStore";
import { clearEvalFailure, pruneEvalFailures, recordEvalFailure } from "./evalFailureStore";
import { buildJobTextForPipeline } from "./jobText";
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
import { progressAnalyzing, progressDraining } from "./progress";
import { loadSuppressedFilter } from "./suppressedStore";

function salaryForecastSnapshot(s: SalaryAnalysis | null | undefined): DiscoverySalaryForecastSnapshot | undefined {
  if (!s) return undefined;
  return {
    match_status: s.match_status,
    source: s.source,
    rationale: s.rationale.trim().slice(0, 240),
  };
}

function jobSourceForProvider(p: DiscoveryProviderId): JobSourceKind {
  if (p === "indeed") return "discovery_indeed";
  if (p === "linkedin") return "discovery_linkedin";
  return "discovery_profession";
}

/** User-facing line(s) for storage and Dashboard (non-match list). */
function buildNotMatchReason(r: PipelineOutput, threshold: number): string {
  const vetoed = r.constraint_veto === true || r.match_strength === "Vetoed";
  const score = typeof r.fit_score === "number" ? r.fit_score : null;
  const below = score === null || score < threshold;

  const parts: string[] = [];
  if (vetoed) {
    const line = (r.one_sentence_summary ?? r.summary ?? "").trim();
    if (line) parts.push(`Veto: ${line}`);
    else parts.push("Did not pass the veto (hard constraints or listing marked Vetoed).");
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
  /** Jobs whose pipeline run failed and reached max attempts (now in evaluated_ids.json). */
  failures_permanent: number;
};

/**
 * Runs full Veto pipeline on the next `maxItems` queued jobs (highest heuristic priority first).
 * Rows that strictly pass `!constraint_veto && fit_score >= threshold` increment `new_high_matches`
 * and are appended to new_matches.jsonl. Other successful evaluations are appended to non_matches.jsonl.
 */
export async function processEvalQueue(opts: ProcessEvalQueueOpts): Promise<ProcessEvalQueueResult> {
  const settings = await loadDiscoverySettings();
  const threshold = Math.min(100, Math.max(0, settings.match_notify_threshold_percent));
  const model = opts.model.trim() || DEFAULT_OLLAMA_MODEL;
  const evaluated = await loadEvaluatedJobIds();
  const suppressedFilter = await loadSuppressedFilter();
  for (const id of suppressedFilter.ids) evaluated.add(id);
  const batch = await takeFromEvalQueue(opts.maxItems, evaluated, suppressedFilter);

  let newHighMatches = 0;
  let processed = 0;
  let failuresPendingRetry = 0;
  let failuresPermanent = 0;
  const completedIds: string[] = [];

  const total = batch.length;
  const phase = opts.draining ? "draining" : "analyzing";
  discoveryTerminalLog(
    total === 0
      ? `phase=eval_batch_start mode=${phase} batch=0 maxItems=${opts.maxItems} (queue empty or nothing due)`
      : `phase=eval_batch_start mode=${phase} batch=${total} maxItems=${opts.maxItems}`,
  );

  for (let i = 0; i < batch.length; i += 1) {
    const job = batch[i];
    const idx = i + 1;
    const msg = `Analyzing job ${idx}/${total} (${job.provider}) — ${job.title.slice(0, 48)}${job.title.length > 48 ? "…" : ""}`;
    if (opts.draining) {
      await progressDraining(idx, total, msg);
    } else {
      await progressAnalyzing(idx, total, msg);
    }
    if (discoveryEvalQuarterIndex(idx, total)) {
      discoveryTerminalLog(`phase=eval_progress mode=${phase} job=${idx}/${total} provider=${job.provider}`);
    }

    try {
      const jobText = await buildJobTextForPipeline(job);
      const detailed = await runPipelineDetailed({
        job: jobText,
        model,
        job_source: jobSourceForProvider(job.provider),
        ...(opts.preferred_location !== undefined ? { preferred_location: opts.preferred_location } : {}),
      });
      processed += 1;
      completedIds.push(job.id);
      await clearEvalFailure(job.id);
      const r = detailed.result;
      const strictWinner =
        r.constraint_veto !== true &&
        r.match_strength !== "Vetoed" &&
        typeof r.fit_score === "number" &&
        r.fit_score >= threshold;

      if (strictWinner) {
        newHighMatches += 1;
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
        const fitScore = typeof r.fit_score === "number" ? r.fit_score : 0;
        await appendNonMatch({
          job_id: job.id,
          provider: job.provider,
          company: job.company ?? null,
          title: job.title,
          url: job.url,
          fit_score: fitScore,
          constraint_veto: Boolean(r.constraint_veto),
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
      } else {
        // Push the job back so it can be retried after the cooldown window.
        await returnToEvalQueue([job]);
        failuresPendingRetry += 1;
      }
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
  discoveryTerminalLog(
    `phase=eval_batch_done mode=${phase} evaluated=${processed} high_matches=${newHighMatches} queue_remaining=${queue_remaining} actionable=${actionable_remaining} retry=${failuresPendingRetry} permanent_fail=${failuresPermanent}`,
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
