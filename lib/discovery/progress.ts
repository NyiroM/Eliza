// lib/discovery/progress.ts
import { mkdir, writeFile, readFile } from "node:fs/promises";
import type {
  DiscoveryEvalLane,
  DiscoveryFetchLane,
  DiscoveryFetchProviderSnap,
  DiscoveryProgressState,
  DiscoveryProviderId,
  DiscoverySessionLiveStats,
} from "../../types/discovery";
import { getDiscoveryDir, getDiscoveryProgressPath } from "./paths";

const IDLE: DiscoveryProgressState = {
  phase: "idle",
  message: "",
  updatedAt: new Date(0).toISOString(),
};

export function defaultSessionLiveStats(): DiscoverySessionLiveStats {
  return { newJobsAdded: 0, jobsEvaluated: 0, newHighMatches: 0, queueRemaining: 0 };
}

export function emptyFetchLane(): DiscoveryFetchLane {
  return { status: "idle", providers_total: 0, providers_done: 0, jobs_added: 0, providers: {} };
}

export function emptyEvalLane(): DiscoveryEvalLane {
  return {
    status: "waiting",
    jobs_evaluated: 0,
    queue_remaining: 0,
    high_matches: 0,
    timed_jobs: 0,
    timed_jobs_ms: 0,
  };
}

let progressLock: Promise<unknown> = Promise.resolve();

function withProgressLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = progressLock.then(fn, fn);
  progressLock = run.then(() => undefined, () => undefined);
  return run;
}

function mergeFetchLane(prev: DiscoveryFetchLane | undefined, patch: Partial<DiscoveryFetchLane>): DiscoveryFetchLane {
  const providers: Partial<Record<DiscoveryProviderId, DiscoveryFetchProviderSnap>> = { ...(prev?.providers ?? {}) };
  if (patch.providers) {
    for (const id of Object.keys(patch.providers) as DiscoveryProviderId[]) {
      const b = patch.providers[id];
      if (!b) continue;
      const fallback: DiscoveryFetchProviderSnap = {
        status: "pending",
        seed_index: 0,
        seed_total: 0,
        jobs_new: 0,
      };
      providers[id] = { ...(prev?.providers?.[id] ?? fallback), ...b };
    }
  }
  const rest = { ...patch };
  delete rest.providers;
  return { ...emptyFetchLane(), ...prev, ...rest, providers };
}

function mergeEvalLane(prev: DiscoveryEvalLane | undefined, patch: Partial<DiscoveryEvalLane>): DiscoveryEvalLane {
  return { ...emptyEvalLane(), ...prev, ...patch };
}

type ProgressWrite = Partial<Omit<DiscoveryProgressState, "updatedAt" | "fetchLane" | "evalLane" | "sessionLiveStats">> & {
  updatedAt?: string;
  fetchLane?: Partial<DiscoveryFetchLane>;
  evalLane?: Partial<DiscoveryEvalLane>;
  sessionLiveStats?: Partial<DiscoverySessionLiveStats>;
  /** When true, remove eval-session progress fields (new discovery run). */
  clearEvalProgressMeta?: boolean;
};

export async function setDiscoveryProgress(partial: ProgressWrite): Promise<void> {
  return withProgressLock(() => writeDiscoveryProgressUnlocked(partial));
}

async function writeDiscoveryProgressUnlocked(partial: ProgressWrite): Promise<void> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  let prev: DiscoveryProgressState;
  try {
    const raw = await readFile(getDiscoveryProgressPath(), "utf-8");
    prev = JSON.parse(raw) as DiscoveryProgressState;
  } catch {
    prev = { ...IDLE, updatedAt: new Date().toISOString() };
  }

  let sessionLiveStats = prev.sessionLiveStats;
  if (partial.sessionLiveStats !== undefined) {
    sessionLiveStats = { ...(prev.sessionLiveStats ?? defaultSessionLiveStats()), ...partial.sessionLiveStats };
  }

  const { clearEvalProgressMeta, fetchLane: fetchPatch, evalLane: evalPatch, ...partialRest } = partial;

  const next: DiscoveryProgressState = {
    ...prev,
    ...partialRest,
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
    sessionLiveStats,
    fetchLane: fetchPatch ? mergeFetchLane(prev.fetchLane, fetchPatch) : prev.fetchLane,
    evalLane: evalPatch ? mergeEvalLane(prev.evalLane, evalPatch) : prev.evalLane,
  };

  if (clearEvalProgressMeta) {
    delete (next as Record<string, unknown>).evalSessionGrandTotal;
    delete (next as Record<string, unknown>).evalBatchBaseJobsEvaluated;
    next.fetchLane = fetchPatch ? mergeFetchLane(emptyFetchLane(), fetchPatch) : emptyFetchLane();
    next.evalLane = evalPatch ? mergeEvalLane(emptyEvalLane(), evalPatch) : emptyEvalLane();
  }

  await writeFile(getDiscoveryProgressPath(), JSON.stringify(next, null, 2), "utf-8");
}

export async function clearDiscoveryProgress(): Promise<void> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  await writeFile(
    getDiscoveryProgressPath(),
    JSON.stringify({ phase: "idle", message: "", updatedAt: new Date().toISOString() } satisfies DiscoveryProgressState, null, 2),
  );
}

/** Bump `updatedAt` only so long single-job pipelines still show a live clock in the dashboard. */
export async function bumpDiscoveryProgressClock(): Promise<void> {
  await setDiscoveryProgress({ updatedAt: nowIso() });
}

export async function readDiscoveryProgress(): Promise<DiscoveryProgressState> {
  try {
    const raw = await readFile(getDiscoveryProgressPath(), "utf-8");
    return JSON.parse(raw) as DiscoveryProgressState;
  } catch {
    return { ...IDLE, updatedAt: new Date().toISOString() };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function progressFetching(
  provider: DiscoveryProviderId,
  message: string,
  fetchInit?: { providers: DiscoveryProviderId[]; seedsTotal: number },
): Promise<void> {
  const t = nowIso();
  const providers: NonNullable<DiscoveryFetchLane["providers"]> = {};
  if (fetchInit) {
    for (const id of fetchInit.providers) {
      providers[id] = { status: "pending", seed_index: 0, seed_total: fetchInit.seedsTotal, jobs_new: 0 };
    }
  }
  return setDiscoveryProgress({
    phase: "fetching",
    provider,
    message,
    step_started_at: t,
    fetchLane: {
      status: "running",
      providers_total: fetchInit?.providers.length ?? 1,
      providers_done: 0,
      jobs_added: 0,
      started_at: t,
      current_provider: provider,
      seed_total: fetchInit?.seedsTotal,
      providers,
    },
  });
}

/** Indeed catalog JD hydrate (Playwright search session + card / q&vjk=), shown on the Fetch lane. */
export async function progressCatalogHydrate(opts: {
  index: number;
  total: number;
  filled: number;
  title?: string;
  launching?: boolean;
  done?: boolean;
}): Promise<void> {
  const t = nowIso();
  const prev = await readDiscoveryProgress();
  const keepEvalPhase = prev.phase === "analyzing" || prev.phase === "draining";
  const total = Math.max(0, opts.total);
  const idx = Math.max(0, Math.min(opts.index, total || opts.index));
  const title = (opts.title ?? "").trim();
  const shortTitle = title.length > 48 ? `${title.slice(0, 48)}…` : title;

  if (opts.done) {
    await setDiscoveryProgress({
      phase: keepEvalPhase ? prev.phase : "queueing",
      message: total > 0 ? `Indeed descriptions: filled ${opts.filled}/${total}.` : prev.message,
      fetchLane: {
        status: "done",
        task: "hydrate",
        providers_total: 1,
        providers_done: 1,
        jobs_added: opts.filled,
        current_provider: "indeed",
        seed_index: total,
        seed_total: total,
        phrase: undefined,
        providers: {
          indeed: {
            status: "done",
            seed_index: total,
            seed_total: total,
            jobs_new: opts.filled,
          },
        },
      },
    });
    return;
  }

  const msg = opts.launching
    ? `Starting Chromium to fill up to ${total} Indeed job description(s)…`
    : `Filling Indeed descriptions ${idx}/${total} (${opts.filled} filled)${shortTitle ? ` — ${shortTitle}` : ""}`;

  await setDiscoveryProgress({
    phase: keepEvalPhase ? prev.phase : "fetching",
    message: msg,
    step_started_at: t,
    pipeline_run_started_at: prev.pipeline_run_started_at ?? t,
    fetchLane: {
      status: "running",
      task: "hydrate",
      providers_total: 1,
      providers_done: 0,
      jobs_added: opts.filled,
      started_at: prev.fetchLane?.started_at && prev.fetchLane.task === "hydrate" ? prev.fetchLane.started_at : t,
      current_provider: "indeed",
      seed_index: idx,
      seed_total: total,
      phrase: opts.launching ? "Starting Chromium…" : shortTitle || "Indeed listing",
      providers: {
        indeed: {
          status: "running",
          seed_index: idx,
          seed_total: total,
          jobs_new: opts.filled,
          seed_started_at: t,
        },
      },
    },
  });
}

export function progressQueueing(message: string, initSession?: boolean): Promise<void> {
  const t = nowIso();
  return setDiscoveryProgress({
    phase: "queueing",
    message,
    step_started_at: t,
    ...(initSession
      ? {
          sessionLiveStats: defaultSessionLiveStats(),
          pipeline_run_started_at: t,
          clearEvalProgressMeta: true,
          fetchLane: emptyFetchLane(),
          evalLane: emptyEvalLane(),
        }
      : {}),
  });
}

/** Keep the live board visible after a run that has nothing left to drain. */
export async function progressSyncFinished(opts: {
  jobsAdded: number;
  jobsEvaluated: number;
  highMatches: number;
}): Promise<void> {
  const prev = await readDiscoveryProgress();
  const s = prev.sessionLiveStats ?? defaultSessionLiveStats();
  const jobsAdded = opts.jobsAdded;
  const jobsEvaluated = Math.max(opts.jobsEvaluated, prev.evalLane?.jobs_evaluated ?? s.jobsEvaluated);
  const highMatches = Math.max(opts.highMatches, prev.evalLane?.high_matches ?? s.newHighMatches);
  await setDiscoveryProgress({
    phase: "done",
    message: `Finished — ${jobsAdded} new listing(s), ${jobsEvaluated} evaluated, ${highMatches} strong match(es).`,
    sessionLiveStats: {
      ...s,
      newJobsAdded: jobsAdded,
      jobsEvaluated,
      newHighMatches: highMatches,
      queueRemaining: 0,
    },
    fetchLane: {
      status: "done",
      providers_total: prev.fetchLane?.providers_total ?? 0,
      providers_done: prev.fetchLane?.providers_done ?? prev.fetchLane?.providers_total ?? 0,
      jobs_added: prev.fetchLane?.jobs_added ?? jobsAdded,
    },
    evalLane: {
      status: "done",
      jobs_evaluated: jobsEvaluated,
      queue_remaining: 0,
      high_matches: highMatches,
      current_title: undefined,
      current_provider: undefined,
      job_started_at: undefined,
    },
    step_started_at: nowIso(),
  });
}

export async function progressAwaitingClientDrain(queueRemaining: number): Promise<void> {
  const prev = await readDiscoveryProgress();
  const s = prev.sessionLiveStats ?? defaultSessionLiveStats();
  await setDiscoveryProgress({
    phase: "queueing",
    message: `${queueRemaining} job(s) queued for deep analysis — continuing in the background…`,
    sessionLiveStats: { ...s, queueRemaining },
    step_started_at: nowIso(),
    fetchLane: { status: "done", providers_total: prev.fetchLane?.providers_total ?? 0, providers_done: prev.fetchLane?.providers_done ?? 0, jobs_added: prev.fetchLane?.jobs_added ?? s.newJobsAdded },
    evalLane: {
      status: queueRemaining > 0 ? "waiting" : "done",
      jobs_evaluated: prev.evalLane?.jobs_evaluated ?? s.jobsEvaluated,
      queue_remaining: queueRemaining,
      high_matches: prev.evalLane?.high_matches ?? s.newHighMatches,
    },
  });
}

export type EvalQueueProgressMeta = {
  evalSessionGrandTotal: number;
  evalBatchBaseJobsEvaluated: number;
};

export function progressAnalyzing(
  index: number,
  total: number,
  message: string,
  queueMeta?: EvalQueueProgressMeta,
  evalLane?: Partial<DiscoveryEvalLane>,
): Promise<void> {
  const t = nowIso();
  return setDiscoveryProgress({
    phase: "analyzing",
    analysisIndex: index,
    analysisTotal: total,
    message,
    step_started_at: t,
    ...(index === 1 ? { eval_batch_started_at: t } : {}),
    ...(queueMeta
      ? {
          evalSessionGrandTotal: queueMeta.evalSessionGrandTotal,
          evalBatchBaseJobsEvaluated: queueMeta.evalBatchBaseJobsEvaluated,
        }
      : {}),
    ...(evalLane ? { evalLane } : {}),
  });
}

export function progressDraining(
  index: number,
  total: number,
  message: string,
  queueMeta?: EvalQueueProgressMeta,
  evalLane?: Partial<DiscoveryEvalLane>,
): Promise<void> {
  const t = nowIso();
  return setDiscoveryProgress({
    phase: "draining",
    analysisIndex: index,
    analysisTotal: total,
    message,
    step_started_at: t,
    ...(index === 1 ? { eval_batch_started_at: t } : {}),
    ...(queueMeta
      ? {
          evalSessionGrandTotal: queueMeta.evalSessionGrandTotal,
          evalBatchBaseJobsEvaluated: queueMeta.evalBatchBaseJobsEvaluated,
        }
      : {}),
    ...(evalLane ? { evalLane } : {}),
  });
}
