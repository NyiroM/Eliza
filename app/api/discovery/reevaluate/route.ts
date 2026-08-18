import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import { getEvalQueueLength, mergeIntoEvalQueue, pruneEvalQueue, clearEvalQueue } from "../../../../lib/discovery/evalQueue";
import {
  isDiscoverySessionBlockingSync,
  isDiscoverySyncLocked,
  markDiscoveryAwaitingDrain,
  withDiscoverySyncLock,
} from "../../../../lib/discovery/lock";
import { getKeywordsForSync } from "../../../../lib/discovery/keywordSync";
import { loadDiscoverySettings } from "../../../../lib/discovery/settings";
import { findDiscoveredJobById, loadDiscoveredJobsAll } from "../../../../lib/discovery/jobStore";
import { removeEvaluatedJobIds, resetEvaluatedJobIds } from "../../../../lib/discovery/evaluatedStore";
import { hydrateThinIndeedJobs } from "../../../../lib/discovery/refreshThinIndeedCatalog";
import { clearAllNewMatches, findNewMatchRowByJobId, removeNewMatchesByJobId } from "../../../../lib/discovery/matchesStore";
import { clearAllNonMatches, findNonMatchRowByJobId, removeNonMatchesByJobId } from "../../../../lib/discovery/nonMatchesStore";
import { isSuppressedDiscoveredJob, loadSuppressedFilter } from "../../../../lib/discovery/suppressedStore";
import { clearEvalFailure } from "../../../../lib/discovery/evalFailureStore";
import {
  clearDiscoveryProgress,
  defaultSessionLiveStats,
  progressAwaitingClientDrain,
  progressQueueing,
  progressSyncFinished,
  readDiscoveryProgress,
  setDiscoveryProgress,
} from "../../../../lib/discovery/progress";
import type { DiscoveredJob } from "../../../../types/discovery";
import { discoveryTerminalLog } from "../../../../lib/discovery/discoveryTerminalLog";
import { processEvalQueue } from "../../../../lib/discovery/processEvalQueue";
import { resolveOllamaModel } from "../../../../lib/storage/resolveOllamaModel";
import { hasStoredCv } from "../../../../lib/storage/userCv";
import { validateOllamaModelTag, validatePreferredLocationField } from "../../../../lib/validation";
import {
  DEFAULT_OLLAMA_MODEL,
  DISCOVERY_SYNC_BACKLOG_MAX_JOBS,
  DISCOVERY_SYNC_EVAL_BATCH,
} from "../../../../config/constants";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

const SINGLE_JOB_QUEUE_PRIORITY = 1_000_000;

type Body = {
  model?: unknown;
  preferred_location?: unknown;
  max_jobs?: unknown;
  /** When set, only this catalog/list row is re-queued and scored. */
  job_id?: unknown;
};

function listingToDiscoveredJob(row: {
  job_id: string;
  provider: DiscoveredJob["provider"];
  company: string | null;
  title: string;
  url: string;
  evaluated_at: string;
}): DiscoveredJob {
  return {
    id: row.job_id,
    provider: row.provider,
    title: row.title,
    company: row.company,
    url: row.url,
    description: "",
    discovered_at: row.evaluated_at,
  };
}

export async function POST(request: NextRequest) {
  return withActiveUser(request, async () => {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    body = {};
  }

  if (isDiscoverySessionBlockingSync()) {
    const pending = await getEvalQueueLength();
    if (pending === 0) {
      markDiscoveryAwaitingDrain(false);
    } else {
      return NextResponse.json(
        {
          ok: false,
          locked: true,
          awaiting_drain: true,
          queue_remaining: pending,
          error: "Discovery queue is still draining from the previous run. Wait for it to finish.",
        },
        { status: 409, headers: NO_STORE },
      );
    }
  }

  if (isDiscoverySyncLocked()) {
    return NextResponse.json(
      { ok: false, locked: true, error: "Another discovery operation is running." },
      { status: 409, headers: NO_STORE },
    );
  }

  const rawModel =
    typeof body.model === "string" && body.model.trim().length > 0 ? body.model.trim() : undefined;
  let model: string;
  if (rawModel) {
    const m = validateOllamaModelTag(rawModel);
    if (!m.ok) {
      return NextResponse.json({ error: m.error }, { status: 400, headers: NO_STORE });
    }
    model = m.model;
  } else {
    model = await resolveOllamaModel(undefined);
  }
  model = model.trim() || DEFAULT_OLLAMA_MODEL;

  const ploc = validatePreferredLocationField(body.preferred_location);
  if (!ploc.ok) {
    return NextResponse.json({ error: ploc.error }, { status: 400, headers: NO_STORE });
  }
  const preferred_location = ploc.preferred_location;

  const jobId =
    typeof body.job_id === "string" && body.job_id.trim().length > 0 ? body.job_id.trim() : undefined;
  if (jobId && jobId.length > 80) {
    return NextResponse.json({ error: "Invalid job_id." }, { status: 400, headers: NO_STORE });
  }

  let maxJobs = DISCOVERY_SYNC_BACKLOG_MAX_JOBS;
  if (typeof body.max_jobs === "number" && Number.isFinite(body.max_jobs)) {
    maxJobs = Math.min(20000, Math.max(50, Math.round(body.max_jobs)));
  }

  if (!(await hasStoredCv())) {
    return NextResponse.json(
      { ok: false, blocked: "Upload and parse a CV on the Analysis tab before reevaluating." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const result = await withDiscoverySyncLock(async () => {
      const settings = await loadDiscoverySettings();
      const phrases = getKeywordsForSync(settings);
      const heuristicBlob = phrases.join(", ");

      if (jobId) {
        const prevProgress = await readDiscoveryProgress();
        const queueBefore = await getEvalQueueLength();

        const catalogJob = await findDiscoveredJobById(jobId);
        const listRow = catalogJob
          ? null
          : (await findNewMatchRowByJobId(jobId)) ?? (await findNonMatchRowByJobId(jobId));
        const job = catalogJob ?? (listRow ? listingToDiscoveredJob(listRow) : null);
        if (!job) {
          return { ok: false as const, blocked: "That listing is no longer in the catalog or match lists." };
        }

        const suppressedFilter = await loadSuppressedFilter();
        if (isSuppressedDiscoveredJob(job, suppressedFilter)) {
          return { ok: false as const, blocked: "That listing is suppressed (removed with trash)." };
        }

        await hydrateThinIndeedJobs([job]);
        const hydrated = (await findDiscoveredJobById(job.id)) ?? job;

        await Promise.all([
          removeNewMatchesByJobId(hydrated.id),
          removeNonMatchesByJobId(hydrated.id),
          removeEvaluatedJobIds([hydrated.id]),
          clearEvalFailure(hydrated.id),
        ]);

        const queued = await mergeIntoEvalQueue(
          [hydrated],
          new Set<string>(),
          suppressedFilter,
          heuristicBlob,
          SINGLE_JOB_QUEUE_PRIORITY,
        );
        if (queued === 0) {
          return { ok: false as const, blocked: "Could not queue that listing for reevaluation." };
        }

        discoveryTerminalLog(`phase=reevaluate_one job=${hydrated.id} provider=${hydrated.provider}`);

        const r = await processEvalQueue({
          model,
          maxItems: 1,
          draining: false,
          deferCompletion: true,
          ...(preferred_location !== undefined ? { preferred_location } : {}),
        });

        const queue_remaining = await getEvalQueueLength();
        if (queueBefore === 0) {
          markDiscoveryAwaitingDrain(false);
          const live = await readDiscoveryProgress();
          const s = live.sessionLiveStats ?? defaultSessionLiveStats();
          await progressSyncFinished({
            jobsAdded: s.newJobsAdded,
            jobsEvaluated: s.jobsEvaluated,
            highMatches: s.newHighMatches,
          }).catch(() => {});
        } else {
          await setDiscoveryProgress(prevProgress).catch(() => {});
        }

        const matchRow = await findNewMatchRowByJobId(hydrated.id);
        const rejectRow = matchRow ? null : await findNonMatchRowByJobId(hydrated.id);

        return {
          ok: true as const,
          single_job: true as const,
          jobs_considered: 1,
          queued,
          jobs_evaluated: r.jobs_evaluated,
          new_high_matches: r.new_high_matches,
          queue_remaining,
          failures_pending_retry: r.failures_pending_retry,
          failures_permanent: r.failures_permanent,
          not_match_reason: rejectRow?.not_match_reason,
          one_sentence_summary: (matchRow ?? rejectRow)?.one_sentence_summary,
        };
      }

      await clearDiscoveryProgress().catch(() => {});

      if (phrases.length === 0) {
        return { ok: false as const, blocked: "Add at least one Search keyword before reevaluating." };
      }

      const jobs = await loadDiscoveredJobsAll(maxJobs);
      if (jobs.length === 0) {
        return { ok: false as const, blocked: "No discovered jobs found yet. Run a sync first." };
      }

      await progressQueueing(`AI reevaluate: reading ${jobs.length} catalog job(s), then filling Indeed descriptions…`, true);
      const indeedHydrated = await hydrateThinIndeedJobs(jobs);
      discoveryTerminalLog(`phase=reevaluate_indeed_hydrate hydrated=${indeedHydrated.length}`);

      await progressQueueing(`AI reevaluate: resetting match lists and queueing ${jobs.length} job(s) for scoring…`);

      await Promise.all([clearAllNewMatches(), clearAllNonMatches()]);
      await resetEvaluatedJobIds();
      await clearEvalQueue();

      const suppressedFilter = await loadSuppressedFilter();
      const queued = await mergeIntoEvalQueue(jobs, new Set<string>(), suppressedFilter, heuristicBlob);
      await pruneEvalQueue(new Set<string>(), suppressedFilter);

      discoveryTerminalLog(`phase=reevaluate queued=${queued} jobs=${jobs.length}`);
      await setDiscoveryProgress({
        message: `AI reevaluate: queued ${queued} job(s). Ollama scoring starting…`,
        sessionLiveStats: { queueRemaining: queued },
        evalLane: {
          status: queued > 0 ? "waiting" : "done",
          queue_remaining: queued,
        },
      });

      let firstPass = {
        jobs_evaluated: 0,
        new_high_matches: 0,
        failures_pending_retry: 0,
        failures_permanent: 0,
      };

      if (DISCOVERY_SYNC_EVAL_BATCH > 0) {
        const r = await processEvalQueue({
          model,
          maxItems: DISCOVERY_SYNC_EVAL_BATCH,
          draining: false,
          ...(preferred_location !== undefined ? { preferred_location } : {}),
        });
        firstPass = {
          jobs_evaluated: r.jobs_evaluated,
          new_high_matches: r.new_high_matches,
          failures_pending_retry: r.failures_pending_retry,
          failures_permanent: r.failures_permanent,
        };
      } else {
        await setDiscoveryProgress({
          phase: "queueing",
          message: "AI reevaluate queued — run drain rounds to process remaining jobs.",
        });
      }

      const queue_remaining = await getEvalQueueLength();
      if (queue_remaining > 0) {
        markDiscoveryAwaitingDrain(true);
        await progressAwaitingClientDrain(queue_remaining).catch(() => {});
      } else {
        markDiscoveryAwaitingDrain(false);
        await progressSyncFinished({
          jobsAdded: 0,
          jobsEvaluated: firstPass.jobs_evaluated,
          highMatches: firstPass.new_high_matches,
        }).catch(() => {});
      }

      return {
        ok: true as const,
        jobs_considered: jobs.length,
        queued,
        jobs_evaluated: firstPass.jobs_evaluated,
        new_high_matches: firstPass.new_high_matches,
        queue_remaining,
        failures_pending_retry: firstPass.failures_pending_retry,
        failures_permanent: firstPass.failures_permanent,
      };
    });

    return NextResponse.json(result, { headers: NO_STORE });
  } catch (e) {
    markDiscoveryAwaitingDrain(false);
    await clearDiscoveryProgress().catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "DISCOVERY_LOCKED") {
      return NextResponse.json({ ok: false, locked: true }, { status: 409, headers: NO_STORE });
    }
    console.error("[discovery/reevaluate]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: NO_STORE });
  }
  });
}

