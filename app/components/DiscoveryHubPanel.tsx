"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getKeywordsForSync, mergeApprovedPhraseIntoSearchKeywords } from "@/lib/discovery/keywordSync";
import type {
  DiscoveryKeywordSuggestion,
  DiscoveryMatchRow,
  DiscoveryNonMatchRow,
  DiscoveryProgressState,
  DiscoveryProviderId,
  DiscoverySettings,
} from "@/types/discovery";

type Props = {
  selectedModel: string;
  preferredLocation: string;
  /** True when `storage/user_cv.json` exists (same gate as manual analysis). */
  cvLoaded: boolean;
};

const PROVIDERS: { id: DiscoveryProviderId; label: string; hint: string }[] = [
  {
    id: "indeed",
    label: "Indeed (Hungary)",
    hint: "Playwright search on hu.indeed.com (stealth-style pacing). Set ELIZA_DISCOVERY_PLAYWRIGHT=0 to fall back to RSS only.",
  },
  { id: "linkedin", label: "LinkedIn (guest)", hint: "Public guest search + optional detail fetch." },
  {
    id: "profession",
    label: "Profession.hu",
    hint: "Playwright listing + details (default: lite settle). Speed: ELIZA_PROFESSION_FAST_NAV=1, ELIZA_PROFESSION_LITE_SETTLE=0 (legacy), ELIZA_PROFESSION_DETAIL_VISITS=0–8, ELIZA_PROFESSION_FETCH_TIMEOUT_MS. Sync: ELIZA_DISCOVERY_SYNC_EVAL_BATCH, ELIZA_DISCOVERY_QUEUE_DRAIN_BATCH, ELIZA_DISCOVERY_MAX_SEED_PHRASES. ELIZA_DISCOVERY_PLAYWRIGHT=0 → HTTP only.",
  },
];

function formatTime(iso: string | null): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const DISCOVERY_DRAIN_MAX_ROUNDS = 40;

/** Poll interval while sync runs — balances UI freshness vs dev-server request logging. */
const DISCOVERY_PROGRESS_POLL_MS = 1200;

function discoveryProviderLabel(id: DiscoveryProviderId | undefined): string | null {
  if (!id) return null;
  return PROVIDERS.find((x) => x.id === id)?.label ?? id;
}

function discoveryPhaseHeading(phase: DiscoveryProgressState["phase"]): string {
  switch (phase) {
    case "fetching":
      return "Fetching listings";
    case "queueing":
      return "Queue & scheduling";
    case "analyzing":
      return "Deep analysis (sync batch)";
    case "draining":
      return "Deep analysis (queue drain)";
    default:
      return "Discovery";
  }
}

type ProcessQueueResponse = {
  ok?: boolean;
  locked?: boolean;
  new_high_matches?: number;
  queue_remaining?: number;
  jobs_evaluated?: number;
  failures_pending_retry?: number;
  failures_permanent?: number;
  error?: string;
};

/** POST /api/discovery/process-queue until empty or stall (handles batches where every item fails Ollama). */
async function discoveryDrainEvalQueue(opts: {
  model: string;
  preferred_location?: string;
  /** Refresh match lists after each successful round so completed jobs appear while drain runs. */
  onRoundComplete?: () => void | Promise<void>;
}): Promise<
  | {
      ok: true;
      totalStrictWins: number;
      totalPipelineSuccess: number;
      totalFailuresPendingRetry: number;
      totalFailuresPermanent: number;
      remaining: number;
      stalled: boolean;
    }
  | { ok: false; error: string; remaining: number }
> {
  let totalStrictWins = 0;
  let totalPipelineSuccess = 0;
  let totalFailuresPendingRetry = 0;
  let totalFailuresPermanent = 0;
  let remaining = 1;
  let rounds = 0;
  let stallCount = 0;
  let lastRem = -1;

  while (remaining > 0 && rounds < DISCOVERY_DRAIN_MAX_ROUNDS) {
    const pr = await fetch("/api/discovery/process-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
      body: JSON.stringify({
        model: opts.model,
        ...(opts.preferred_location !== undefined ? { preferred_location: opts.preferred_location } : {}),
      }),
    });
    const pd = (await pr.json()) as ProcessQueueResponse;
    if (pr.status === 409 || pd.locked) {
      return { ok: false, error: "Could not run queue drain (another discovery operation is active).", remaining };
    }
    if (!pr.ok) {
      return { ok: false, error: pd.error ?? "Queue processing stopped.", remaining };
    }
    totalStrictWins += pd.new_high_matches ?? 0;
    totalPipelineSuccess += pd.jobs_evaluated ?? 0;
    totalFailuresPendingRetry += pd.failures_pending_retry ?? 0;
    totalFailuresPermanent += pd.failures_permanent ?? 0;
    const next = pd.queue_remaining ?? 0;
    if (next === lastRem && (pd.jobs_evaluated ?? 0) === 0) {
      stallCount += 1;
      if (stallCount >= 3) {
        return {
          ok: false,
          error: "Evaluation queue did not shrink after several attempts. Check Ollama logs or restart the dev server.",
          remaining: next,
        };
      }
    } else {
      stallCount = 0;
    }
    lastRem = next;
    remaining = next;
    await opts.onRoundComplete?.();
    rounds += 1;
  }
  return {
    ok: true,
    totalStrictWins,
    totalPipelineSuccess,
    totalFailuresPendingRetry,
    totalFailuresPermanent,
    remaining,
    stalled: rounds >= DISCOVERY_DRAIN_MAX_ROUNDS,
  };
}

/** "indeed=2, linkedin=1" style summary for the duplicates_skipped breakdown. */
function formatDuplicatesSkipped(map: Partial<Record<DiscoveryProviderId, number>> | undefined): string | null {
  if (!map) return null;
  const parts: string[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(map)) {
    const n = typeof v === "number" ? v : 0;
    if (n > 0) {
      parts.push(`${k}=${n}`);
      total += n;
    }
  }
  if (total === 0) return null;
  return `${total} duplicate(s) skipped (${parts.join(", ")})`;
}

export default function DiscoveryHubPanel({ selectedModel, preferredLocation, cvLoaded }: Props) {
  const [settings, setSettings] = useState<DiscoverySettings | null>(null);
  const [matches, setMatches] = useState<DiscoveryMatchRow[]>([]);
  const [nonMatches, setNonMatches] = useState<DiscoveryNonMatchRow[]>([]);
  const [newMatchesTotal, setNewMatchesTotal] = useState(0);
  const [nonMatchesTotal, setNonMatchesTotal] = useState(0);
  const [previouslyFoundJobsTotal, setPreviouslyFoundJobsTotal] = useState(0);
  const [busyProvider, setBusyProvider] = useState<DiscoveryProviderId | "all" | "auto" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [liveProgress, setLiveProgress] = useState<DiscoveryProgressState | null>(null);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [resetCatalogBusy, setResetCatalogBusy] = useState(false);
  const [resetMatchListsBusy, setResetMatchListsBusy] = useState(false);
  const syncInFlight = useRef(false);
  const intervalRef = useRef<number | null>(null);
  const progressPollRef = useRef<number | null>(null);

  const loadSettings = useCallback(async () => {
    try {
      const res = await fetch("/api/discovery/settings");
      let data = (await res.json()) as DiscoverySettings;
      try {
        const ls = localStorage.getItem("eliza_discovery_auto_sync_interval_minutes");
        if (ls) {
          const v = parseInt(ls, 10);
          if (Number.isFinite(v) && v >= 5 && v <= 1440) {
            data = { ...data, auto_sync_interval_minutes: v };
          }
        }
      } catch {
        /* ignore */
      }
      setSettings(data);
    } catch {
      setMessage("Could not load discovery settings.");
    }
  }, []);

  const loadMatches = useCallback(async () => {
    try {
      const res = await fetch("/api/discovery/matches");
      const data = (await res.json()) as {
        matches?: DiscoveryMatchRow[];
        nonMatches?: DiscoveryNonMatchRow[];
        new_matches_total?: number;
        non_matches_total?: number;
        previously_found_jobs_total?: number;
      };
      setMatches(data.matches ?? []);
      setNonMatches(data.nonMatches ?? []);
      setNewMatchesTotal(typeof data.new_matches_total === "number" ? data.new_matches_total : (data.matches ?? []).length);
      setNonMatchesTotal(
        typeof data.non_matches_total === "number" ? data.non_matches_total : (data.nonMatches ?? []).length,
      );
      setPreviouslyFoundJobsTotal(
        typeof data.previously_found_jobs_total === "number" ? data.previously_found_jobs_total : 0,
      );
    } catch {
      /* ignore */
    }
  }, []);

  const removeMatch = useCallback(async (row: DiscoveryMatchRow) => {
    setMatches((list) => list.filter((x) => x.job_id !== row.job_id));
    try {
      const res = await fetch(`/api/discovery/matches?job_id=${encodeURIComponent(row.job_id)}`, {
        method: "DELETE",
        headers: { "X-Eliza-Internal": "true" },
      });
      const body = (await res.json()) as { ok?: boolean; removed?: number };
      if (!res.ok) {
        await loadMatches();
        setMessage("Could not remove that match from storage.");
        return;
      }
      const removed = typeof body.removed === "number" ? body.removed : 0;
      if (removed > 0) {
        setNewMatchesTotal((n) => Math.max(0, n - removed));
      }
      setMessage(null);
    } catch {
      await loadMatches();
      setMessage("Could not remove that match from storage.");
    }
  }, [loadMatches]);

  const removeNonMatch = useCallback(async (row: DiscoveryNonMatchRow) => {
    setNonMatches((list) => list.filter((x) => x.job_id !== row.job_id));
    try {
      const res = await fetch(
        `/api/discovery/matches?job_id=${encodeURIComponent(row.job_id)}&list=rejects`,
        { method: "DELETE", headers: { "X-Eliza-Internal": "true" } },
      );
      const body = (await res.json()) as { ok?: boolean; removed?: number };
      if (!res.ok) {
        await loadMatches();
        setMessage("Could not remove that listing from the not-a-match list.");
        return;
      }
      const removed = typeof body.removed === "number" ? body.removed : 0;
      if (removed > 0) {
        setNonMatchesTotal((n) => Math.max(0, n - removed));
      }
      setMessage(null);
    } catch {
      await loadMatches();
      setMessage("Could not remove that listing from the not-a-match list.");
    }
  }, [loadMatches]);

  useEffect(() => {
    const id = window.setTimeout(() => {
      void loadSettings();
      void loadMatches();
    }, 0);
    return () => window.clearTimeout(id);
  }, [loadSettings, loadMatches]);

  useEffect(() => {
    const t = window.setInterval(() => {
      void loadSettings();
    }, 45_000);
    return () => window.clearInterval(t);
  }, [loadSettings]);

  const postSettings = async (partial: {
    auto_sync_interval_minutes?: number;
    match_notify_threshold_percent?: number;
    search_keywords?: string;
    keyword_suggestions?: DiscoveryKeywordSuggestion[];
    providers?: Partial<Record<DiscoveryProviderId, Partial<DiscoverySettings["providers"][DiscoveryProviderId]>>>;
  }) => {
    const res = await fetch("/api/discovery/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
      body: JSON.stringify(partial),
    });
    const data = (await res.json()) as DiscoverySettings & { error?: string };
    if (!res.ok) {
      setMessage(data.error ?? "Save failed.");
      return;
    }
    setSettings(data);
    setMessage(null);
  };

  const pollDiscoveryProgress = useCallback(() => {
    if (progressPollRef.current != null) return;
    progressPollRef.current = window.setInterval(async () => {
      try {
        const r = await fetch("/api/discovery/progress");
        const p = (await r.json()) as DiscoveryProgressState;
        setLiveProgress(p.phase === "idle" && !p.message ? null : p);
      } catch {
        /* ignore */
      }
    }, DISCOVERY_PROGRESS_POLL_MS);
  }, []);

  const stopProgressPoll = useCallback(() => {
    if (progressPollRef.current != null) {
      window.clearInterval(progressPollRef.current);
      progressPollRef.current = null;
    }
    setLiveProgress(null);
  }, []);

  const runSync = useCallback(
    async (opts: { mode: "manual" | "auto"; provider?: DiscoveryProviderId | "all" }) => {
      if (syncInFlight.current) {
        setMessage("A sync is already running.");
        return;
      }
      if (!cvLoaded) {
        if (opts.mode !== "auto") {
          setMessage("Upload and parse a CV on the Analysis tab before running discovery sync.");
        }
        return;
      }
      syncInFlight.current = true;
      setBusyProvider(opts.mode === "auto" ? "auto" : opts.provider ?? "all");
      setMessage(null);
      pollDiscoveryProgress();
      try {
        const res = await fetch("/api/discovery/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
          body: JSON.stringify({
            mode: opts.mode,
            provider: opts.provider,
            model: selectedModel,
            preferred_location: preferredLocation.trim() || undefined,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          blocked?: string;
          locked?: boolean;
          awaiting_drain?: boolean;
          jobs_added?: number;
          jobs_evaluated?: number;
          new_high_matches?: number;
          queue_remaining?: number;
          errors?: Record<string, string>;
          duplicates_skipped?: Partial<Record<DiscoveryProviderId, number>>;
          failures_pending_retry?: number;
          failures_permanent?: number;
          error?: string;
        };
        if (data.ok === false && data.blocked) {
          if (opts.mode !== "auto") setMessage(data.blocked);
          return;
        }
        if ((res.status === 409 || data.locked) && data.awaiting_drain) {
          setMessage("Finishing the evaluation queue from your last sync…");
          const drain = await discoveryDrainEvalQueue({
            model: selectedModel,
            preferred_location: preferredLocation.trim() || undefined,
            onRoundComplete: async () => {
              await loadMatches();
            },
          });
          await loadMatches();
          if (!drain.ok) {
            setMessage(
              `${drain.error} (${drain.remaining} job(s) still reported queued — try Run sync again in a moment.)`,
            );
            return;
          }
          if (drain.stalled) {
            setMessage(
              `Queue drain hit the safety round limit with ${drain.remaining} job(s) left. Try Run sync again or increase ELIZA_DISCOVERY_QUEUE_DRAIN_BATCH.`,
            );
            return;
          }
          setMessage(
            `Evaluation queue cleared (${drain.totalPipelineSuccess} full Veto run(s), ${drain.totalStrictWins} high matches this drain). Click Run sync again when ready.`,
          );
          return;
        }
        if (res.status === 409 || data.locked) {
          setMessage("Another sync is already running — try again shortly.");
          return;
        }
        if (!res.ok) {
          setMessage(data.error ?? "Sync failed.");
          return;
        }

        let totalStrictWins = data.new_high_matches ?? 0;
        let totalEvaluated = data.jobs_evaluated ?? 0;
        let totalFailuresPendingRetry = data.failures_pending_retry ?? 0;
        let totalFailuresPermanent = data.failures_permanent ?? 0;
        let remaining = data.queue_remaining ?? 0;

        if (remaining > 0) {
          const drain = await discoveryDrainEvalQueue({
            model: selectedModel,
            preferred_location: preferredLocation.trim() || undefined,
            onRoundComplete: async () => {
              await loadMatches();
            },
          });
          if (!drain.ok) {
            setMessage(
              `${data.jobs_added ?? 0} job(s) added. Queue drain failed: ${drain.error} (${drain.remaining} still queued).`,
            );
            return;
          }
          if (drain.stalled) {
            setMessage(
              `${data.jobs_added ?? 0} job(s) added. Queue drain stopped after ${DISCOVERY_DRAIN_MAX_ROUNDS} rounds with ${drain.remaining} job(s) left — run sync again to continue.`,
            );
            return;
          }
          totalStrictWins += drain.totalStrictWins;
          totalEvaluated += drain.totalPipelineSuccess;
          totalFailuresPendingRetry += drain.totalFailuresPendingRetry;
          totalFailuresPermanent += drain.totalFailuresPermanent;
          remaining = drain.remaining;
        }

        await loadSettings();
        await loadMatches();
        const thr = settings?.match_notify_threshold_percent ?? 70;
        const dupSummary = formatDuplicatesSkipped(data.duplicates_skipped);
        const parts = [
          `Added ${data.jobs_added ?? 0} new job(s)${dupSummary ? ` (${dupSummary})` : ""}.`,
          `Analyzed ${totalEvaluated} job(s) through the Veto pipeline.`,
          `${totalStrictWins} passed the Veto Engine and scored ≥ ${thr}% (listed under New matches).`,
        ];
        if (totalFailuresPendingRetry > 0) {
          parts.push(`${totalFailuresPendingRetry} failed and will retry next sync.`);
        }
        if (totalFailuresPermanent > 0) {
          parts.push(`${totalFailuresPermanent} failed permanently — check the dev server logs.`);
        }
        parts.push(
          remaining > 0
            ? `${remaining} job(s) still queued for deep analysis — sync again or wait for auto.`
            : "Evaluation queue is empty.",
        );
        setMessage(parts.join(" "));

        if (
          totalStrictWins > 0 &&
          typeof window !== "undefined" &&
          "Notification" in window &&
          Notification.permission === "granted"
        ) {
          new Notification("ELIZA Discovery", {
            body: `${totalStrictWins} new listing(s) passed the Veto Engine and meet your match threshold.`,
          });
        }
      } catch {
        setMessage("Could not reach discovery sync API.");
      } finally {
        stopProgressPoll();
        syncInFlight.current = false;
        setBusyProvider(null);
      }
    },
    [
      cvLoaded,
      selectedModel,
      preferredLocation,
      settings?.match_notify_threshold_percent,
      loadSettings,
      loadMatches,
      pollDiscoveryProgress,
      stopProgressPoll,
    ],
  );

  const anyAuto =
    Boolean(settings?.providers?.indeed?.auto) ||
    Boolean(settings?.providers?.linkedin?.auto) ||
    Boolean(settings?.providers?.profession?.auto);

  const intervalMinutes = settings?.auto_sync_interval_minutes ?? 60;

  const syncPhrases = useMemo(() => (settings ? getKeywordsForSync(settings) : []), [settings]);
  const hasSyncKeywords = syncPhrases.length > 0;
  const canSync = cvLoaded && hasSyncKeywords;
  const syncBlockedTitle = !cvLoaded
    ? "Upload and parse a CV on the Analysis tab before syncing."
    : !hasSyncKeywords
      ? "Add search keywords or approve suggestions before syncing."
      : undefined;

  const approveSuggestion = (phrase: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const search_keywords = mergeApprovedPhraseIntoSearchKeywords(prev.search_keywords, phrase);
      const keyword_suggestions = (prev.keyword_suggestions ?? []).filter((row) => row.phrase !== phrase);
      void postSettings({ search_keywords, keyword_suggestions });
      return { ...prev, search_keywords, keyword_suggestions };
    });
  };

  const rejectSuggestion = (phrase: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const keyword_suggestions = (prev.keyword_suggestions ?? []).map((row) =>
        row.phrase === phrase ? { ...row, status: "rejected" as const } : row,
      );
      void postSettings({ keyword_suggestions });
      return { ...prev, keyword_suggestions };
    });
  };

  useEffect(() => {
    if (!settings || !anyAuto || !canSync) {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    const ms = Math.max(5, intervalMinutes) * 60 * 1000;
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    intervalRef.current = window.setInterval(() => {
      if (syncInFlight.current || !canSync) return;
      void runSync({ mode: "auto" });
    }, ms);
    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [settings, anyAuto, intervalMinutes, runSync, canSync]);

  if (!settings) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">
        Loading Discovery Hub…
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {busyProvider != null && liveProgress && liveProgress.phase !== "idle" ? (
        <div
          className="rounded-lg border border-blue-800/50 bg-blue-950/40 p-4 text-sm text-blue-100 space-y-3"
          aria-live="polite"
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-blue-300">Live progress</p>
              <p className="mt-0.5 text-base font-semibold text-blue-50">{discoveryPhaseHeading(liveProgress.phase)}</p>
              {discoveryProviderLabel(liveProgress.provider) ? (
                <p className="text-xs text-blue-200/85 mt-0.5">Source: {discoveryProviderLabel(liveProgress.provider)}</p>
              ) : null}
            </div>
            {liveProgress.phase === "analyzing" || liveProgress.phase === "draining" ? (
              (() => {
                const idx = liveProgress.analysisIndex;
                const tot = liveProgress.analysisTotal;
                if (idx == null || tot == null || tot <= 0) return null;
                const pct = Math.min(100, Math.round((idx / tot) * 100));
                const afterThis = Math.max(0, tot - idx);
                return (
                  <div className="text-right tabular-nums">
                    <p className="text-2xl font-bold text-blue-100 leading-none">{pct}%</p>
                    <p className="text-[11px] text-blue-200/90 mt-1">
                      Job {idx} of {tot} in this batch
                    </p>
                    <p className="text-[11px] text-blue-300/80">{afterThis} left after this one</p>
                  </div>
                );
              })()
            ) : null}
          </div>

          {liveProgress.phase === "fetching" &&
          liveProgress.fetchKeywordIndex != null &&
          liveProgress.fetchKeywordTotal != null ? (
            <div className="rounded-md border border-blue-800/40 bg-slate-900/40 px-3 py-2 text-[11px] text-blue-100/95 space-y-1">
              <p className="tabular-nums">
                Seed phrase <strong>{liveProgress.fetchKeywordIndex}</strong> of{" "}
                <strong>{liveProgress.fetchKeywordTotal}</strong> for this source ·{" "}
                <strong>{liveProgress.keywordsInListTotal ?? "—"}</strong> phrase(s) in Search keywords
              </p>
              {liveProgress.fetchPhraseDurationMs != null ? (
                <p className="text-blue-200/85">
                  Last phrase completed in {(liveProgress.fetchPhraseDurationMs / 1000).toFixed(1)}s
                </p>
              ) : null}
            </div>
          ) : null}

          {liveProgress.sessionLiveStats &&
          (liveProgress.phase === "queueing" ||
            liveProgress.phase === "analyzing" ||
            liveProgress.phase === "draining") ? (
            <div className="rounded-md border border-emerald-900/50 bg-slate-900/50 px-3 py-2 text-[11px] text-emerald-100/95 tabular-nums space-y-0.5">
              <p className="font-medium text-emerald-50/95">This sync (cumulative)</p>
              <p>
                {liveProgress.sessionLiveStats.newJobsAdded} new job(s) to catalog ·{" "}
                {liveProgress.sessionLiveStats.jobsEvaluated} evaluated ·{" "}
                {liveProgress.sessionLiveStats.newHighMatches} strong match(es) · queue{" "}
                {liveProgress.sessionLiveStats.queueRemaining}
              </p>
            </div>
          ) : null}

          {liveProgress.phase === "analyzing" || liveProgress.phase === "draining" ? (
            (() => {
              const idx = liveProgress.analysisIndex;
              const tot = liveProgress.analysisTotal;
              if (idx == null || tot == null || tot <= 0) {
                return (
                  <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800/80" aria-hidden>
                    <div className="h-full w-full animate-pulse rounded-full bg-blue-500/35" />
                  </div>
                );
              }
              const pct = Math.min(100, (idx / tot) * 100);
              return (
                <div className="space-y-1">
                  <div
                    className="h-2.5 w-full overflow-hidden rounded-full bg-slate-800/90 ring-1 ring-blue-900/40"
                    role="progressbar"
                    aria-valuenow={Math.round(pct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Pipeline progress for this batch"
                  >
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-blue-600 to-sky-400 transition-[width] duration-300 ease-out"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-blue-200/75">
                    Bar = position in the current Veto batch only. Match lists below refresh after each drain round when
                    jobs finish.
                  </p>
                </div>
              );
            })()
          ) : (
            <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800/80" aria-hidden>
              <div className="h-full w-full animate-pulse rounded-full bg-blue-500/30" />
            </div>
          )}

          <p className="text-sm text-blue-50/95 leading-snug border-t border-blue-800/40 pt-2">{liveProgress.message}</p>
          <p className="text-[10px] text-blue-400/70 tabular-nums">
            Updated {formatTime(liveProgress.updatedAt)}
          </p>
        </div>
      ) : busyProvider != null ? (
        <div
          className="rounded-lg border border-slate-700 bg-slate-900/80 p-4 text-sm text-slate-400 space-y-2"
          aria-live="polite"
        >
          <p className="font-medium text-slate-300">Starting discovery…</p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800" aria-hidden>
            <div className="h-full w-full animate-pulse rounded-full bg-slate-600/40" />
          </div>
          <p className="text-xs text-slate-500">Waiting for the first progress update from the server.</p>
        </div>
      ) : null}

      <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Global settings</h2>
        <p className="text-xs text-slate-500 tabular-nums">
          Previously found jobs catalog: {previouslyFoundJobsTotal.toLocaleString()} job
          {previouslyFoundJobsTotal === 1 ? "" : "s"} on disk.
        </p>
        <p className="text-[11px] text-slate-600">
          Defaults favor shorter runs: smaller in-sync veto batch and queue drain (override via{" "}
          <code className="text-slate-500">ELIZA_DISCOVERY_SYNC_EVAL_BATCH</code>,{" "}
          <code className="text-slate-500">ELIZA_DISCOVERY_QUEUE_DRAIN_BATCH</code>,{" "}
          <code className="text-slate-500">ELIZA_DISCOVERY_MAX_SEED_PHRASES</code> in the server env).
        </p>
        <div className="rounded-lg border border-amber-900/50 bg-amber-950/25 p-3 space-y-2">
          <p className="text-xs text-amber-100/95 leading-snug">
            <span className="font-medium">Previously found jobs / duplicate-filter reset:</span> deletes the{" "}
            <code className="text-amber-200/90">jobs.jsonl</code> catalog, the <code className="text-amber-200/90">evaluated_ids</code>{" "}
            list, the evaluation queue, and the failed-attempt log. The next sync may pick up and process the same listings
            again. <strong>New matches</strong> / non-match lists are <strong>not</strong> cleared.
          </p>
          <button
            type="button"
            disabled={busyProvider !== null || resetCatalogBusy || resetMatchListsBusy}
            onClick={async () => {
              if (
                !window.confirm(
                  "Delete the previously found jobs catalog and related pipeline state (evaluated IDs, queue, failure log)? The next sync may process these listings again.",
                )
              ) {
                return;
              }
              setResetCatalogBusy(true);
              setMessage(null);
              try {
                const res = await fetch("/api/discovery/reset-catalog", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
                  body: "{}",
                });
                const data = (await res.json()) as { ok?: boolean; error?: string };
                if (res.status === 409 || !res.ok || data.ok === false) {
                  setMessage(data.error ?? "Delete failed (a sync may be running).");
                  return;
                }
                setMessage(
                  "Previously found jobs and duplicate-filter state cleared. Run a new sync if you want to process the lists again.",
                );
                await loadMatches();
              } catch {
                setMessage("Could not reach the reset API.");
              } finally {
                setResetCatalogBusy(false);
              }
            }}
            className="rounded-md border border-amber-700/80 bg-amber-950/60 px-3 py-2 text-xs font-medium text-amber-100 hover:bg-amber-900/50 disabled:opacity-40"
          >
            {resetCatalogBusy ? "Deleting…" : "Clear previously found jobs (duplicate reset)"}
          </button>
        </div>
        <div className="rounded-lg border border-rose-900/45 bg-rose-950/20 p-3 space-y-2">
          <p className="text-xs text-rose-100/95 leading-snug">
            <span className="font-medium">Clear New matches and &quot;no match&quot; lists:</span> empties{" "}
            <code className="text-rose-200/90">new_matches.jsonl</code> and <code className="text-rose-200/90">non_matches.jsonl</code>.
            The discovery catalog / duplicate filter <strong>does not</strong> change — only rows shown on the dashboard are
            removed.
          </p>
          <button
            type="button"
            disabled={busyProvider !== null || resetCatalogBusy || resetMatchListsBusy}
            onClick={async () => {
              if (
                !window.confirm(
                  'Delete all rows from New matches and "Evaluated, not a match" lists? This does not reset the duplicate filter.',
                )
              ) {
                return;
              }
              setResetMatchListsBusy(true);
              setMessage(null);
              try {
                const res = await fetch("/api/discovery/reset-match-lists", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
                  body: "{}",
                });
                const data = (await res.json()) as { ok?: boolean; error?: string };
                if (res.status === 409 || !res.ok || data.ok === false) {
                  setMessage(data.error ?? "Could not clear the lists (a sync may be running).");
                  return;
                }
                await loadMatches();
                setMessage("New matches and non-match lists cleared.");
              } catch {
                setMessage("Could not reach the reset-match-lists API.");
              } finally {
                setResetMatchListsBusy(false);
              }
            }}
            className="rounded-md border border-rose-700/70 bg-rose-950/50 px-3 py-2 text-xs font-medium text-rose-100 hover:bg-rose-900/45 disabled:opacity-40"
          >
            {resetMatchListsBusy ? "Deleting…" : "Clear New matches and non-match lists"}
          </button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">Auto sync interval (minutes)</span>
            <input
              type="number"
              min={5}
              max={1440}
              value={settings.auto_sync_interval_minutes}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isFinite(v)) return;
                setSettings((s) => (s ? { ...s, auto_sync_interval_minutes: v } : s));
              }}
              onBlur={() => {
                void postSettings({ auto_sync_interval_minutes: settings.auto_sync_interval_minutes });
                try {
                  localStorage.setItem(
                    "eliza_discovery_auto_sync_interval_minutes",
                    String(settings.auto_sync_interval_minutes),
                  );
                } catch {
                  /* ignore */
                }
              }}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
            <span className="text-[11px] text-slate-600">
              Stored on server under <code className="text-slate-500">storage/discovery/</code> and mirrored in{" "}
              <code className="text-slate-500">localStorage</code> on save.
            </span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-500">Match notify threshold (%)</span>
            <input
              type="number"
              min={0}
              max={100}
              value={settings.match_notify_threshold_percent}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isFinite(v)) return;
                setSettings((s) => (s ? { ...s, match_notify_threshold_percent: v } : s));
              }}
              onBlur={() => void postSettings({ match_notify_threshold_percent: settings.match_notify_threshold_percent })}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-xs text-slate-500">
            Search keywords — comma-separated (always used on sync). Ollama is not run during sync; generate
            suggestions below, then approve to append each phrase here (same as typing).
          </span>
          <textarea
            rows={3}
            value={settings.search_keywords}
            onChange={(e) => setSettings((s) => (s ? { ...s, search_keywords: e.target.value } : s))}
            onBlur={() => void postSettings({ search_keywords: settings.search_keywords })}
            className="w-full resize-y min-h-[4.5rem] rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          />
        </label>
        {!cvLoaded ? (
          <p className="text-xs text-amber-400/90">
            Upload and parse a CV on the Analysis tab before manual sync, automatic monitor runs, or queue evaluation.
          </p>
        ) : null}
        {!hasSyncKeywords ? (
          <p className="text-xs text-amber-400/90">
            Sync is disabled until this field has at least one keyword or you approve a suggested keyword.
          </p>
        ) : null}
        {canSync ? (
          <p className="text-xs text-slate-600">
            Active sync phrases ({syncPhrases.length}): {syncPhrases.join(" · ")}
          </p>
        ) : null}
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Suggested keywords (AI)</h3>
            <button
              type="button"
              disabled={suggestBusy || busyProvider !== null}
              onClick={async () => {
                setSuggestBusy(true);
                setMessage(null);
                try {
                  const res = await fetch("/api/discovery/suggest-keywords", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-Eliza-Internal": "true" },
                    body: JSON.stringify({ model: selectedModel }),
                  });
                  const data = (await res.json()) as DiscoverySettings & { error?: string };
                  if (!res.ok) {
                    setMessage(data.error ?? "Suggestion request failed.");
                    return;
                  }
                  setSettings(data);
                  setMessage("New suggestions added — review and approve before syncing.");
                } catch {
                  setMessage("Could not reach suggest-keywords API.");
                } finally {
                  setSuggestBusy(false);
                }
              }}
              className="rounded-md bg-violet-800 px-3 py-1.5 text-xs hover:bg-violet-700 disabled:opacity-40"
            >
              {suggestBusy ? "Generating…" : "Generate suggestions"}
            </button>
          </div>
          <p className="text-[11px] text-slate-500">
            Suggestions start as pending. Approving appends the phrase to Search keywords above (deduped); sync uses
            that field only.
          </p>
          {(settings.keyword_suggestions ?? []).filter((s) => s.status === "suggested").length === 0 ? (
            <p className="text-xs text-slate-600">No pending suggestions.</p>
          ) : (
            <ul className="space-y-2 max-h-40 overflow-auto text-sm">
              {(settings.keyword_suggestions ?? [])
                .filter((s) => s.status === "suggested")
                .map((s) => (
                  <li
                    key={s.phrase}
                    className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800 px-2 py-1.5"
                  >
                    <span className="text-slate-200">{s.phrase}</span>
                    <span className="flex gap-1">
                      <button
                        type="button"
                        className="rounded bg-emerald-900/80 px-2 py-0.5 text-[11px] hover:bg-emerald-800"
                        onClick={() => approveSuggestion(s.phrase)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="rounded bg-slate-800 px-2 py-0.5 text-[11px] hover:bg-slate-700"
                        onClick={() => rejectSuggestion(s.phrase)}
                      >
                        Reject
                      </button>
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              if (typeof window === "undefined" || !("Notification" in window)) return;
              const p = await Notification.requestPermission();
              setMessage(
                p === "granted"
                  ? "Notifications enabled only for listings that pass the Veto Engine and meet your threshold."
                  : `Permission: ${p}`,
              );
            }}
            className="rounded-md bg-slate-700 px-3 py-2 text-xs hover:bg-slate-600"
          >
            Enable browser notifications
          </button>
          <span className="text-xs text-slate-500">
            Notifications fire only for listings that pass the Veto Engine and meet your threshold (requires a CV).
          </span>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        {PROVIDERS.map(({ id, label, hint }) => {
          const st = settings.providers[id];
          const busy = busyProvider === id || busyProvider === "all";
          const syncDisabled = busy || !canSync;
          return (
            <div key={id} className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-3 flex flex-col">
              <div>
                <h3 className="text-sm font-semibold text-slate-200">{label}</h3>
                <p className="mt-1 text-[11px] text-slate-500 leading-snug">{hint}</p>
              </div>
              <div className="text-xs text-slate-400 space-y-1 flex-1">
                <p>
                  <span className="text-slate-500">Last run:</span> {formatTime(st.last_run_at)}
                </p>
                <p>
                  <span className="text-slate-500">Listings returned (capped):</span> {st.last_jobs_found}
                </p>
                <p>
                  <span className="text-slate-500">New to your catalog (last fetch):</span>{" "}
                  {st.last_jobs_new_to_catalog ?? 0}
                </p>
                {st.last_error ? (
                  <p className="text-amber-400 break-words" title={st.last_error}>
                    {st.last_error.slice(0, 120)}
                    {st.last_error.length > 120 ? "…" : ""}
                  </p>
                ) : null}
                {st.last_search_hint ? (
                  <p className="text-sky-300/90 break-words text-[11px]" title={st.last_search_hint}>
                    {st.last_search_hint.slice(0, 200)}
                    {st.last_search_hint.length > 200 ? "…" : ""}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                disabled={syncDisabled}
                title={syncBlockedTitle}
                onClick={() => void runSync({ mode: "manual", provider: id })}
                className="w-full rounded-md bg-emerald-700 px-3 py-2 text-sm hover:bg-emerald-600 disabled:opacity-40"
              >
                {busy ? "Syncing…" : "Manual sync"}
              </button>
              <label className="flex items-center justify-between gap-2 text-xs text-slate-300 cursor-pointer">
                <span>Automatic monitor</span>
                <input
                  type="checkbox"
                  checked={st.auto}
                  onChange={(e) => {
                    const auto = e.target.checked;
                    if (auto && !cvLoaded) {
                      setMessage("Upload and parse a CV on the Analysis tab before enabling automatic monitor.");
                      return;
                    }
                    setSettings((prev) =>
                      prev
                        ? {
                            ...prev,
                            providers: { ...prev.providers, [id]: { ...prev.providers[id], auto } },
                          }
                        : prev,
                    );
                    void postSettings({ providers: { [id]: { auto } } as Partial<DiscoverySettings["providers"]> });
                  }}
                  className="h-4 w-4 rounded border-slate-600"
                />
              </label>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busyProvider !== null || !canSync}
          title={syncBlockedTitle}
          onClick={() => void runSync({ mode: "manual", provider: "all" })}
          className="rounded-md bg-blue-700 px-4 py-2 text-sm hover:bg-blue-600 disabled:opacity-40"
        >
          {busyProvider === "all" ? "Syncing all…" : "Manual sync — all providers"}
        </button>
      </div>

      {message ? <p className="text-sm text-amber-300">{message}</p> : null}

      <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          New matches ({newMatchesTotal.toLocaleString()})
        </h2>
        <p className="text-xs text-slate-500">
          Jobs that passed your veto and scored at or above the threshold ({settings.match_notify_threshold_percent}%)
          after automatic or manual sync.
        </p>
        {matches.length === 0 ? (
          <p className="text-sm text-slate-500">No strong matches yet. Run a sync after uploading your CV.</p>
        ) : (
          <ul className="space-y-2 max-h-64 overflow-auto">
            {matches.map((m) => (
              <li key={`${m.job_id}-${m.evaluated_at}`} className="rounded-md border border-slate-700 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-100">{m.title}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-emerald-400 tabular-nums">{m.fit_score}%</span>
                    <button
                      type="button"
                      title="Remove from New matches (kuka)"
                      aria-label="Remove match"
                      onClick={() => void removeMatch(m)}
                      className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-rose-400"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  {m.provider} · {new Date(m.evaluated_at).toLocaleString()}
                </p>
                {m.one_sentence_summary ? (
                  <p className="text-xs text-slate-400 mt-1">{m.one_sentence_summary}</p>
                ) : null}
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-blue-400 hover:underline"
                >
                  Open posting
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Evaluated, not a match ({nonMatchesTotal.toLocaleString()})
        </h2>
        <p className="text-xs text-slate-500">
          Jobs that completed the Veto pipeline but failed the veto and/or scored below your threshold (
          {settings.match_notify_threshold_percent}%). Each row explains why it is not listed under New matches.
        </p>
        {nonMatches.length === 0 ? (
          <p className="text-sm text-slate-500">
            No rejected listings stored yet. After the next sync, non-matches appear here alongside matches.
          </p>
        ) : (
          <ul className="space-y-2 max-h-64 overflow-auto">
            {nonMatches.map((m) => (
              <li key={`${m.job_id}-${m.evaluated_at}`} className="rounded-md border border-slate-700 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-slate-100">{m.title}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={
                        m.constraint_veto
                          ? "text-amber-400/95 tabular-nums"
                          : "text-slate-400 tabular-nums"
                      }
                    >
                      {m.fit_score}%
                    </span>
                    <button
                      type="button"
                      title="Remove from this list"
                      aria-label="Remove from not-a-match list"
                      onClick={() => void removeNonMatch(m)}
                      className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-rose-400"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">
                  {m.provider} · {new Date(m.evaluated_at).toLocaleString()}
                </p>
                <p className="text-xs text-rose-200/90 mt-1.5 leading-snug">{m.not_match_reason}</p>
                {m.one_sentence_summary && m.one_sentence_summary !== m.not_match_reason ? (
                  <p className="text-xs text-slate-400 mt-1">{m.one_sentence_summary}</p>
                ) : null}
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs text-blue-400 hover:underline"
                >
                  Open posting
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
