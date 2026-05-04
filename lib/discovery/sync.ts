// lib/discovery/sync.ts
import { DEFAULT_OLLAMA_MODEL, DISCOVERY_SYNC_EVAL_BATCH } from "../../config/constants";
import type { DiscoveredJob, DiscoveryProviderId, DiscoverySyncResult } from "../../types/discovery";
import { appendDiscoveredJobs, loadDiscoveredJobIds, loadDiscoveredJobsTail } from "./jobStore";
import { getKeywordsForSync } from "./keywordSync";
import { loadDiscoverySettings, patchProviderState, saveDiscoverySettings } from "./settings";
import { getEvalQueueLength, mergeIntoEvalQueue, pruneEvalQueue } from "./evalQueue";
import { loadEvaluatedJobIds } from "./evaluatedStore";
import { processEvalQueue } from "./processEvalQueue";
import {
  clearDiscoveryProgress,
  defaultSessionLiveStats,
  progressAwaitingClientDrain,
  progressFetching,
  progressQueueing,
  readDiscoveryProgress,
  setDiscoveryProgress,
} from "./progress";
import { discoveryTerminalLog } from "./discoveryTerminalLog";
import {
  DISCOVERY_MAX_SEED_PHRASES_EFFECTIVE,
  fetchJobsForProviderResilient,
} from "./resilientProviderFetch";
import { uniquePhrasesPreserveOrder } from "./searchKeywords";

const PROVIDER_LOG_LABEL: Record<DiscoveryProviderId, string> = {
  indeed: "Indeed",
  linkedin: "LinkedIn",
  profession: "Profession.hu",
};

export type DiscoverySyncOptions = {
  providers: DiscoveryProviderId[];
  model?: string;
  preferred_location?: string | null;
};

export async function runDiscoverySync(opts: DiscoverySyncOptions): Promise<DiscoverySyncResult> {
  await clearDiscoveryProgress().catch(() => {});
  let settings = await loadDiscoverySettings();
  const model = opts.model?.trim() || DEFAULT_OLLAMA_MODEL;

  const errors: Partial<Record<DiscoveryProviderId, string>> = {};
  const duplicatesSkipped: Partial<Record<DiscoveryProviderId, number>> = {};
  let jobsAdded = 0;
  const existing = await loadDiscoveredJobIds();
  const newJobsBuffer: DiscoveredJob[] = [];

  try {
    const orderedPhrases = uniquePhrasesPreserveOrder(getKeywordsForSync(settings));
    if (orderedPhrases.length === 0) {
      discoveryTerminalLog("phase=blocked reason=no_keywords");
      await clearDiscoveryProgress().catch(() => {});
      return {
        ok: false,
        blocked: "Add at least one comma-separated search keyword before syncing (or approve a suggestion).",
        providers_run: [...opts.providers],
        jobs_added: 0,
        jobs_evaluated: 0,
        new_high_matches: 0,
        queue_remaining: 0,
        errors: {},
      };
    }
    await progressQueueing(
      "Preparing keywords from Search keywords (Ollama expansion disabled during sync)…",
      true,
    );
    const heuristicBlob = orderedPhrases.join(", ");
    discoveryTerminalLog(
      `phase=fetch_start providers=${opts.providers.join(",")} keyword_phrases=${orderedPhrases.length} seeds_per_provider=${DISCOVERY_MAX_SEED_PHRASES_EFFECTIVE}`,
    );

    for (const pid of opts.providers) {
      const providerWallMs = Date.now();
      await progressFetching(
        pid,
        `${PROVIDER_LOG_LABEL[pid]}: starting fetch (${DISCOVERY_MAX_SEED_PHRASES_EFFECTIVE} seed phrase(s) of ${orderedPhrases.length} in Search keywords)…`,
      );
      const { jobs, error, hint } = await fetchJobsForProviderResilient(pid, orderedPhrases, 28, {
        keywordsInListTotal: orderedPhrases.length,
        onPhrase: async (prov, ev) => {
          if (ev.kind === "start") {
            discoveryTerminalLog(
              `phase=fetch_keyword_start provider=${prov} seed=${ev.seedIndex1Based}/${ev.seedsTotal} keywords_in_list=${ev.keywordsInListTotal} phrase="${ev.phrase.slice(0, 72)}${ev.phrase.length > 72 ? "…" : ""}"`,
            );
            const short = ev.phrase.length > 56 ? `${ev.phrase.slice(0, 56)}…` : ev.phrase;
            await setDiscoveryProgress({
              phase: "fetching",
              provider: prov,
              fetchKeywordIndex: ev.seedIndex1Based,
              fetchKeywordTotal: ev.seedsTotal,
              fetchPhrase: ev.phrase,
              keywordsInListTotal: ev.keywordsInListTotal,
              fetchSeedsTotal: ev.seedsTotal,
              message: `${PROVIDER_LOG_LABEL[prov]} · phrase ${ev.seedIndex1Based}/${ev.seedsTotal} in this source’s pass — “${short}” · ${ev.keywordsInListTotal} phrase(s) in Search keywords`,
            });
            return;
          }
          const short = ev.phrase.length > 56 ? `${ev.phrase.slice(0, 56)}…` : ev.phrase;
          await setDiscoveryProgress({
            phase: "fetching",
            provider: prov,
            fetchKeywordIndex: ev.seedIndex1Based,
            fetchKeywordTotal: ev.seedsTotal,
            fetchPhrase: ev.phrase,
            keywordsInListTotal: ev.keywordsInListTotal,
            fetchSeedsTotal: ev.seedsTotal,
            fetchPhraseDurationMs: ev.durationMs,
            message: `${PROVIDER_LOG_LABEL[prov]} · finished “${short}” in ${(ev.durationMs / 1000).toFixed(1)}s — ${ev.uniqueCount} unique listing(s) for this source so far · ${ev.keywordsInListTotal} phrase(s) in Search keywords`,
          });
        },
      });

      if (error && jobs.length === 0) {
        errors[pid] = error;
        settings = patchProviderState(settings, pid, {
          last_run_at: new Date().toISOString(),
          last_jobs_found: 0,
          last_jobs_new_to_catalog: 0,
          last_error: error,
          last_search_hint: hint ?? null,
        });
        discoveryTerminalLog(
          `phase=fetch_done provider=${pid} wall_ms=${Date.now() - providerWallMs} jobs=0 new=0 dup=0 error=${error.slice(0, 120)}${error.length > 120 ? "…" : ""}`,
        );
        continue;
      }

      const fresh = jobs.filter((j) => !existing.has(j.id) && !newJobsBuffer.some((x) => x.id === j.id));
      const skipped = jobs.length - fresh.length;
      if (skipped > 0) {
        duplicatesSkipped[pid] = (duplicatesSkipped[pid] ?? 0) + skipped;
      }
      for (const j of fresh) {
        existing.add(j.id);
        newJobsBuffer.push(j);
      }
      settings = patchProviderState(settings, pid, {
        last_run_at: new Date().toISOString(),
        last_jobs_found: jobs.length,
        last_jobs_new_to_catalog: fresh.length,
        last_error: null,
        last_search_hint: hint ?? null,
      });
      const errPart = error ? ` partial_error=${error.slice(0, 80)}${error.length > 80 ? "…" : ""}` : "";
      discoveryTerminalLog(
        `phase=fetch_done provider=${pid} wall_ms=${Date.now() - providerWallMs} jobs=${jobs.length} new=${fresh.length} dup=${skipped}${errPart}`,
      );
    }

    if (newJobsBuffer.length > 0) {
      jobsAdded = await appendDiscoveredJobs(newJobsBuffer);
    }
    await saveDiscoverySettings(settings);
    discoveryTerminalLog(`phase=storage jobs_appended_buffer=${newJobsBuffer.length} jobs_added=${jobsAdded}`);

    const prevQueue = await readDiscoveryProgress();
    const sess = prevQueue.sessionLiveStats ?? defaultSessionLiveStats();
    await setDiscoveryProgress({
      phase: "queueing",
      message: "Prioritising jobs for deep analysis…",
      sessionLiveStats: { ...sess, newJobsAdded: newJobsBuffer.length },
    });

    const evaluated = await loadEvaluatedJobIds();
    const tail = await loadDiscoveredJobsTail(600);
    const backlog = tail.filter((j) => opts.providers.includes(j.provider) && !evaluated.has(j.id));
    await mergeIntoEvalQueue(backlog, evaluated, heuristicBlob);
    await pruneEvalQueue(evaluated);
    const queueAfterMerge = await getEvalQueueLength();
    discoveryTerminalLog(`phase=queue_ready backlog_candidates=${backlog.length} queue=${queueAfterMerge}`);

    let firstPass: {
      jobs_evaluated: number;
      new_high_matches: number;
      failures_pending_retry: number;
      failures_permanent: number;
    };
    if (DISCOVERY_SYNC_EVAL_BATCH > 0) {
      discoveryTerminalLog(`phase=in_sync_eval max_batch=${DISCOVERY_SYNC_EVAL_BATCH}`);
      const r = await processEvalQueue({
        model,
        maxItems: DISCOVERY_SYNC_EVAL_BATCH,
        draining: false,
        ...(opts.preferred_location !== undefined ? { preferred_location: opts.preferred_location } : {}),
      });
      firstPass = {
        jobs_evaluated: r.jobs_evaluated,
        new_high_matches: r.new_high_matches,
        failures_pending_retry: r.failures_pending_retry,
        failures_permanent: r.failures_permanent,
      };
    } else {
      await progressQueueing(
        "Skipping in-sync veto (set ELIZA_DISCOVERY_SYNC_EVAL_BATCH>0 to analyze here; drain queue after sync).",
      );
      discoveryTerminalLog("phase=in_sync_eval skipped batch=0 (ELIZA_DISCOVERY_SYNC_EVAL_BATCH)");
      firstPass = {
        jobs_evaluated: 0,
        new_high_matches: 0,
        failures_pending_retry: 0,
        failures_permanent: 0,
      };
    }

    const queue_remaining = await getEvalQueueLength();
    const prevEval = await readDiscoveryProgress();
    const sEval = prevEval.sessionLiveStats ?? defaultSessionLiveStats();
    await setDiscoveryProgress({
      sessionLiveStats: {
        ...sEval,
        jobsEvaluated: sEval.jobsEvaluated + firstPass.jobs_evaluated,
        newHighMatches: sEval.newHighMatches + firstPass.new_high_matches,
        queueRemaining: queue_remaining,
      },
    });

    discoveryTerminalLog(
      `phase=sync_summary evaluated=${firstPass.jobs_evaluated} high_matches=${firstPass.new_high_matches} queue_remaining=${queue_remaining} retry=${firstPass.failures_pending_retry} permanent_fail=${firstPass.failures_permanent}`,
    );

    if (queue_remaining === 0) {
      await clearDiscoveryProgress().catch(() => {});
    } else {
      await progressAwaitingClientDrain(queue_remaining).catch(() => {});
    }

    return {
      ok: true,
      providers_run: [...opts.providers],
      jobs_added: jobsAdded,
      jobs_evaluated: firstPass.jobs_evaluated,
      new_high_matches: firstPass.new_high_matches,
      queue_remaining,
      errors,
      duplicates_skipped: duplicatesSkipped,
      failures_pending_retry: firstPass.failures_pending_retry,
      failures_permanent: firstPass.failures_permanent,
    };
  } catch (e) {
    await clearDiscoveryProgress().catch(() => {});
    throw e;
  }
}
