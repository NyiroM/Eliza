// lib/discovery/sync.ts
import {
  DEFAULT_OLLAMA_MODEL,
  DISCOVERY_SYNC_BACKLOG_MAX_JOBS,
  DISCOVERY_SYNC_EVAL_BATCH,
} from "../../config/constants";
import type { DiscoveredJob, DiscoveryProviderId, DiscoverySyncResult } from "../../types/discovery";
import { appendDiscoveredJobs, loadDiscoveredJobIds, loadDiscoveredJobsTail } from "./jobStore";
import { getKeywordsForSync } from "./keywordSync";
import { loadDiscoverySettings, patchProviderState, saveDiscoverySettings } from "./settings";
import { getEvalQueueActionableLength, getEvalQueueLength, mergeIntoEvalQueue, pruneEvalQueue } from "./evalQueue";
import { loadEvaluatedJobIds } from "./evaluatedStore";
import { isSuppressedDiscoveredJob, loadSuppressedFilter } from "./suppressedStore";
import { loadDupeIndex } from "./dupeIndexStore";
import { processEvalQueue } from "./processEvalQueue";
import {
  clearDiscoveryProgress,
  defaultSessionLiveStats,
  progressAwaitingClientDrain,
  progressFetching,
  progressQueueing,
  progressSyncFinished,
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

const EVAL_DURING_FETCH = process.env.ELIZA_DISCOVERY_EVAL_DURING_FETCH !== "0";

function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

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
  const crossProviderDuplicatesSkipped: Partial<Record<DiscoveryProviderId, number>> = {};
  let jobsAdded = 0;
  const existing = await loadDiscoveredJobIds();
  const newJobsBuffer: DiscoveredJob[] = [];
  const dupeIndex = await loadDupeIndex();

  try {
    // Warm the dupe index from recent catalog rows (cheap, helps cross-provider dedupe immediately).
    if (existing.size > 0 && dupeIndex.count() === 0) {
      const tail = await loadDiscoveredJobsTail(DISCOVERY_SYNC_BACKLOG_MAX_JOBS);
      for (const j of tail) {
        dupeIndex.recordJob(j);
      }
    }

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
      `phase=fetch_start providers=${opts.providers.join(",")} parallel=1 eval_during_fetch=${EVAL_DURING_FETCH && DISCOVERY_SYNC_EVAL_BATCH > 0 ? 1 : 0} keyword_phrases=${orderedPhrases.length} seeds_per_provider=${DISCOVERY_MAX_SEED_PHRASES_EFFECTIVE}`,
    );

    const evaluatedEarly = await loadEvaluatedJobIds();
    const suppressedFilterEarly = await loadSuppressedFilter();
    for (const id of suppressedFilterEarly.ids) evaluatedEarly.add(id);

    const catalogIo = createMutex();
    const evalAcc = {
      jobs_evaluated: 0,
      new_high_matches: 0,
      failures_pending_retry: 0,
      failures_permanent: 0,
    };
    const fetchState = { allDone: false, overlapEvalBusy: false };
    let fetchProvidersDone = 0;

    const overlapEval =
      EVAL_DURING_FETCH && DISCOVERY_SYNC_EVAL_BATCH > 0
        ? (async () => {
            discoveryTerminalLog("phase=overlap_eval_start");
            while (!fetchState.allDone) {
              const n = await getEvalQueueActionableLength();
              if (n === 0) {
                await new Promise((r) => setTimeout(r, 400));
                continue;
              }
              fetchState.overlapEvalBusy = true;
              try {
                const r = await processEvalQueue({
                  model,
                  maxItems: 1,
                  draining: false,
                  deferCompletion: true,
                  ...(opts.preferred_location !== undefined
                    ? { preferred_location: opts.preferred_location }
                    : {}),
                });
                evalAcc.jobs_evaluated += r.jobs_evaluated;
                evalAcc.new_high_matches += r.new_high_matches;
                evalAcc.failures_pending_retry += r.failures_pending_retry;
                evalAcc.failures_permanent += r.failures_permanent;
              } finally {
                fetchState.overlapEvalBusy = false;
              }
            }
            discoveryTerminalLog(
              `phase=overlap_eval_done evaluated=${evalAcc.jobs_evaluated} high_matches=${evalAcc.new_high_matches}`,
            );
          })()
        : Promise.resolve();

    const ingestProviderResult = async (
      pid: DiscoveryProviderId,
      jobs: DiscoveredJob[],
      error: string | null,
      hint: string | null | undefined,
      providerWallMs: number,
    ): Promise<void> => {
      await catalogIo(async () => {
        let freshCount = 0;
        let snapStatus: "done" | "error" = "done";
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
          snapStatus = "error";
        } else {
          const fresh: DiscoveredJob[] = [];
          let skippedIdDup = 0;
          let skippedCrossProvider = 0;
          for (const j of jobs) {
            if (existing.has(j.id) || newJobsBuffer.some((x) => x.id === j.id)) {
              skippedIdDup += 1;
              continue;
            }
            const dupe = dupeIndex.findDuplicate(j);
            if (dupe) {
              skippedCrossProvider += 1;
              continue;
            }
            fresh.push(j);
          }
          if (skippedIdDup > 0) {
            duplicatesSkipped[pid] = (duplicatesSkipped[pid] ?? 0) + skippedIdDup;
          }
          if (skippedCrossProvider > 0) {
            crossProviderDuplicatesSkipped[pid] = (crossProviderDuplicatesSkipped[pid] ?? 0) + skippedCrossProvider;
          }
          for (const j of fresh) {
            existing.add(j.id);
            newJobsBuffer.push(j);
            dupeIndex.recordJob(j);
          }
          settings = patchProviderState(settings, pid, {
            last_run_at: new Date().toISOString(),
            last_jobs_found: jobs.length,
            last_jobs_new_to_catalog: fresh.length,
            last_error:
              jobs.length === 0
                ? "Fetch returned 0 listings (no HTTP error). Empty scrape or site block is likely."
                : null,
            last_search_hint: hint ?? null,
          });
          const errPart = error ? ` partial_error=${error.slice(0, 80)}${error.length > 80 ? "…" : ""}` : "";
          discoveryTerminalLog(
            `phase=fetch_done provider=${pid} wall_ms=${Date.now() - providerWallMs} jobs=${jobs.length} new=${fresh.length} dup=${skippedIdDup} cross_dup=${skippedCrossProvider}${errPart}`,
          );

          if (fresh.length > 0) {
            jobsAdded += await appendDiscoveredJobs(fresh);
            await mergeIntoEvalQueue(fresh, evaluatedEarly, suppressedFilterEarly, heuristicBlob);
          }
          freshCount = fresh.length;
        }

        fetchProvidersDone += 1;
        await setDiscoveryProgress({
          sessionLiveStats: { newJobsAdded: jobsAdded },
          fetchLane: {
            jobs_added: jobsAdded,
            providers_done: fetchProvidersDone,
            providers: {
              [pid]: {
                status: snapStatus,
                jobs_new: freshCount,
              },
            },
          },
        });
      });
    };

    await progressFetching(
      opts.providers[0] ?? "linkedin",
      `Fetching ${opts.providers.map((p) => PROVIDER_LOG_LABEL[p]).join(", ")} in parallel (${DISCOVERY_MAX_SEED_PHRASES_EFFECTIVE} seed phrase(s) of ${orderedPhrases.length})…`,
      { providers: [...opts.providers], seedsTotal: DISCOVERY_MAX_SEED_PHRASES_EFFECTIVE },
    );

    await Promise.all(
      opts.providers.map(async (pid) => {
        const providerWallMs = Date.now();
        const { jobs, error, hint } = await fetchJobsForProviderResilient(
          pid,
          orderedPhrases,
          28,
          {
            keywordsInListTotal: orderedPhrases.length,
            onPhrase: async (prov, ev) => {
              const short = ev.phrase.length > 56 ? `${ev.phrase.slice(0, 56)}…` : ev.phrase;
              if (ev.kind === "start") {
                discoveryTerminalLog(
                  `phase=fetch_keyword_start provider=${prov} seed=${ev.seedIndex1Based}/${ev.seedsTotal} keywords_in_list=${ev.keywordsInListTotal} phrase="${ev.phrase.slice(0, 72)}${ev.phrase.length > 72 ? "…" : ""}"`,
                );
              }
              await setDiscoveryProgress({
                ...(fetchState.overlapEvalBusy
                  ? {}
                  : {
                      phase: "fetching" as const,
                      provider: prov,
                      message:
                        ev.kind === "start"
                          ? `${PROVIDER_LOG_LABEL[prov]} · phrase ${ev.seedIndex1Based}/${ev.seedsTotal} in this source’s pass — “${short}” · ${ev.keywordsInListTotal} phrase(s) in Search keywords`
                          : `${PROVIDER_LOG_LABEL[prov]} · finished “${short}” in ${(ev.durationMs / 1000).toFixed(1)}s — ${ev.uniqueCount} unique listing(s) for this source so far · ${ev.keywordsInListTotal} phrase(s) in Search keywords`,
                    }),
                fetchKeywordIndex: ev.seedIndex1Based,
                fetchKeywordTotal: ev.seedsTotal,
                fetchPhrase: ev.phrase,
                keywordsInListTotal: ev.keywordsInListTotal,
                fetchSeedsTotal: ev.seedsTotal,
                ...(ev.kind === "done" ? { fetchPhraseDurationMs: ev.durationMs } : {}),
                step_started_at: new Date().toISOString(),
                fetchLane: {
                  status: "running",
                  current_provider: prov,
                  seed_index: ev.seedIndex1Based,
                  seed_total: ev.seedsTotal,
                  phrase: ev.phrase,
                  ...(ev.kind === "done" ? { last_seed_ms: ev.durationMs } : {}),
                  providers: {
                    [prov]: {
                      status: "running" as const,
                      seed_index: ev.seedIndex1Based,
                      seed_total: ev.seedsTotal,
                      ...(ev.kind === "done" ? { last_seed_ms: ev.durationMs, jobs_new: ev.uniqueCount } : {}),
                    },
                  },
                },
              });
            },
          },
          opts.preferred_location,
        );
        await ingestProviderResult(pid, jobs, error ?? null, hint, providerWallMs);
      }),
    );

    fetchState.allDone = true;
    await setDiscoveryProgress({
      fetchLane: {
        status: "done",
        providers_done: opts.providers.length,
        jobs_added: jobsAdded,
      },
    });
    await overlapEval;
    await dupeIndex.save().catch(() => {});
    await saveDiscoverySettings(settings);
    discoveryTerminalLog(`phase=storage jobs_appended_buffer=${newJobsBuffer.length} jobs_added=${jobsAdded}`);

    const prevQueue = await readDiscoveryProgress();
    const sess = prevQueue.sessionLiveStats ?? defaultSessionLiveStats();
    await setDiscoveryProgress({
      phase: "queueing",
      message: "Prioritising jobs for deep analysis…",
      sessionLiveStats: { ...sess, newJobsAdded: newJobsBuffer.length },
      step_started_at: new Date().toISOString(),
    });

    const evaluated = await loadEvaluatedJobIds();
    const suppressedFilter = await loadSuppressedFilter();
    for (const id of suppressedFilter.ids) evaluated.add(id);
    const tail = await loadDiscoveredJobsTail(DISCOVERY_SYNC_BACKLOG_MAX_JOBS);
    // Backlog sweep: queue any pending catalog rows in the tail window, not only providers
    // fetched in this run — otherwise single-provider syncs leave other sources unevaluated.
    const backlog = tail.filter(
      (j) => !evaluated.has(j.id) && !isSuppressedDiscoveredJob(j, suppressedFilter),
    );
    await mergeIntoEvalQueue(backlog, evaluated, suppressedFilter, heuristicBlob);
    await pruneEvalQueue(evaluated, suppressedFilter);
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
        jobs_evaluated: evalAcc.jobs_evaluated + r.jobs_evaluated,
        new_high_matches: evalAcc.new_high_matches + r.new_high_matches,
        failures_pending_retry: evalAcc.failures_pending_retry + r.failures_pending_retry,
        failures_permanent: evalAcc.failures_permanent + r.failures_permanent,
      };
    } else {
      await progressQueueing(
        "Skipping in-sync veto (set ELIZA_DISCOVERY_SYNC_EVAL_BATCH>0 to analyze here; drain queue after sync).",
      );
      discoveryTerminalLog("phase=in_sync_eval skipped batch=0 (ELIZA_DISCOVERY_SYNC_EVAL_BATCH)");
      firstPass = {
        jobs_evaluated: evalAcc.jobs_evaluated,
        new_high_matches: evalAcc.new_high_matches,
        failures_pending_retry: evalAcc.failures_pending_retry,
        failures_permanent: evalAcc.failures_permanent,
      };
    }

    const queue_remaining = await getEvalQueueLength();
    const prevEval = await readDiscoveryProgress();
    const sEval = prevEval.sessionLiveStats ?? defaultSessionLiveStats();
    const nextJobsEval = Math.max(sEval.jobsEvaluated, firstPass.jobs_evaluated);
    const nextHigh = Math.max(sEval.newHighMatches, firstPass.new_high_matches);
    const grandTotalFresh = nextJobsEval + queue_remaining;
    const keepGrand =
      typeof prevEval.evalSessionGrandTotal === "number" && prevEval.evalSessionGrandTotal > 0
        ? prevEval.evalSessionGrandTotal
        : Math.max(1, grandTotalFresh);
    await setDiscoveryProgress({
      sessionLiveStats: {
        ...sEval,
        jobsEvaluated: nextJobsEval,
        newHighMatches: nextHigh,
        queueRemaining: queue_remaining,
      },
      evalLane: {
        jobs_evaluated: nextJobsEval,
        high_matches: nextHigh,
        queue_remaining,
        status: queue_remaining > 0 ? "waiting" : "done",
      },
      ...(typeof prevEval.evalSessionGrandTotal !== "number" || prevEval.evalSessionGrandTotal <= 0
        ? { evalSessionGrandTotal: keepGrand }
        : {}),
    });

    discoveryTerminalLog(
      `phase=sync_summary evaluated=${firstPass.jobs_evaluated} high_matches=${firstPass.new_high_matches} queue_remaining=${queue_remaining} retry=${firstPass.failures_pending_retry} permanent_fail=${firstPass.failures_permanent}`,
    );

    if (queue_remaining === 0) {
      await progressSyncFinished({
        jobsAdded,
        jobsEvaluated: firstPass.jobs_evaluated,
        highMatches: firstPass.new_high_matches,
      }).catch(() => {});
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
      cross_provider_duplicates_skipped: crossProviderDuplicatesSkipped,
      failures_pending_retry: firstPass.failures_pending_retry,
      failures_permanent: firstPass.failures_permanent,
    };
  } catch (e) {
    await clearDiscoveryProgress().catch(() => {});
    throw e;
  }
}
