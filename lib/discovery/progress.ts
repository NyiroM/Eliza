// lib/discovery/progress.ts
import { mkdir, writeFile, readFile } from "node:fs/promises";
import type {
  DiscoveryProgressState,
  DiscoveryProviderId,
  DiscoverySessionLiveStats,
} from "../../types/discovery";
import { DISCOVERY_DIR, DISCOVERY_PROGRESS_PATH } from "./paths";

const IDLE: DiscoveryProgressState = {
  phase: "idle",
  message: "",
  updatedAt: new Date(0).toISOString(),
};

export function defaultSessionLiveStats(): DiscoverySessionLiveStats {
  return { newJobsAdded: 0, jobsEvaluated: 0, newHighMatches: 0, queueRemaining: 0 };
}

export async function setDiscoveryProgress(
  partial: Partial<Omit<DiscoveryProgressState, "updatedAt">> & { updatedAt?: string },
): Promise<void> {
  await mkdir(DISCOVERY_DIR, { recursive: true });
  let prev: DiscoveryProgressState;
  try {
    const raw = await readFile(DISCOVERY_PROGRESS_PATH, "utf-8");
    prev = JSON.parse(raw) as DiscoveryProgressState;
  } catch {
    prev = { ...IDLE, updatedAt: new Date().toISOString() };
  }

  let sessionLiveStats = prev.sessionLiveStats;
  if (partial.sessionLiveStats !== undefined) {
    sessionLiveStats = { ...(prev.sessionLiveStats ?? defaultSessionLiveStats()), ...partial.sessionLiveStats };
  }

  const next: DiscoveryProgressState = {
    ...prev,
    ...partial,
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
    sessionLiveStats,
  };

  const effPhase = partial.phase ?? prev.phase;

  if (effPhase === "queueing" || effPhase === "fetching") {
    delete (next as Record<string, unknown>).analysisIndex;
    delete (next as Record<string, unknown>).analysisTotal;
  }
  if (effPhase === "queueing" || effPhase === "analyzing" || effPhase === "draining") {
    delete (next as Record<string, unknown>).fetchKeywordIndex;
    delete (next as Record<string, unknown>).fetchKeywordTotal;
    delete (next as Record<string, unknown>).fetchPhrase;
    delete (next as Record<string, unknown>).keywordsInListTotal;
    delete (next as Record<string, unknown>).fetchSeedsTotal;
    delete (next as Record<string, unknown>).fetchPhraseDurationMs;
  }
  if ((effPhase === "analyzing" || effPhase === "draining") && !("provider" in partial)) {
    delete (next as { provider?: DiscoveryProviderId }).provider;
  }

  await writeFile(DISCOVERY_PROGRESS_PATH, JSON.stringify(next, null, 2), "utf-8");
}

export async function clearDiscoveryProgress(): Promise<void> {
  await mkdir(DISCOVERY_DIR, { recursive: true });
  await writeFile(
    DISCOVERY_PROGRESS_PATH,
    JSON.stringify({ phase: "idle", message: "", updatedAt: new Date().toISOString() } satisfies DiscoveryProgressState, null, 2),
    "utf-8",
  );
}

export async function readDiscoveryProgress(): Promise<DiscoveryProgressState> {
  try {
    const raw = await readFile(DISCOVERY_PROGRESS_PATH, "utf-8");
    return JSON.parse(raw) as DiscoveryProgressState;
  } catch {
    return { ...IDLE, updatedAt: new Date().toISOString() };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function progressFetching(provider: DiscoveryProviderId, message: string): Promise<void> {
  return setDiscoveryProgress({
    phase: "fetching",
    provider,
    message,
    step_started_at: nowIso(),
  });
}

export function progressQueueing(message: string, initSession?: boolean): Promise<void> {
  const t = nowIso();
  return setDiscoveryProgress({
    phase: "queueing",
    message,
    step_started_at: t,
    ...(initSession
      ? { sessionLiveStats: defaultSessionLiveStats(), pipeline_run_started_at: t }
      : {}),
  });
}

/** Shown after sync when jobs remain queued so the UI does not jump to idle before drain. */
export async function progressAwaitingClientDrain(queueRemaining: number): Promise<void> {
  const prev = await readDiscoveryProgress();
  const s = prev.sessionLiveStats ?? defaultSessionLiveStats();
  await setDiscoveryProgress({
    phase: "queueing",
    message: `${queueRemaining} job(s) queued for deep analysis — continuing in the background…`,
    sessionLiveStats: { ...s, queueRemaining },
    step_started_at: nowIso(),
  });
}

export function progressAnalyzing(index: number, total: number, message: string): Promise<void> {
  const t = nowIso();
  return setDiscoveryProgress({
    phase: "analyzing",
    analysisIndex: index,
    analysisTotal: total,
    message,
    step_started_at: t,
    ...(index === 1 ? { eval_batch_started_at: t } : {}),
  });
}

export function progressDraining(index: number, total: number, message: string): Promise<void> {
  const t = nowIso();
  return setDiscoveryProgress({
    phase: "draining",
    analysisIndex: index,
    analysisTotal: total,
    message,
    step_started_at: t,
    ...(index === 1 ? { eval_batch_started_at: t } : {}),
  });
}
