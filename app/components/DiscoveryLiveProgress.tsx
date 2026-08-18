// app/components/DiscoveryLiveProgress.tsx
"use client";

import type {
  DiscoveryEvalLane,
  DiscoveryFetchLane,
  DiscoveryFetchProviderSnap,
  DiscoveryProgressState,
  DiscoveryProviderId,
} from "@/types/discovery";

const PROVIDER_SHORT: Record<DiscoveryProviderId, string> = {
  indeed: "Indeed",
  linkedin: "LinkedIn",
  profession: "Profession.hu",
};

const PROVIDER_SEED_DEFAULT_MS: Record<DiscoveryProviderId, number> = {
  indeed: 60_000,
  linkedin: 8_000,
  profession: 90_000,
};

const PROVIDER_ORDER: DiscoveryProviderId[] = ["linkedin", "indeed", "profession"];

function parseIsoMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : null;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function formatClock(msFromNow: number, nowMs: number): string {
  const t = new Date(nowMs + msFromNow);
  return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function fetchFromLegacy(p: DiscoveryProgressState): DiscoveryFetchLane {
  if (p.fetchLane) return p.fetchLane;
  const running = p.phase === "fetching";
  return {
    status: running ? "running" : p.phase === "idle" ? "idle" : "done",
    providers_total: 1,
    providers_done: running ? 0 : 1,
    jobs_added: p.sessionLiveStats?.newJobsAdded ?? 0,
    current_provider: p.provider,
    seed_index: p.fetchKeywordIndex,
    seed_total: p.fetchKeywordTotal ?? p.fetchSeedsTotal,
    phrase: p.fetchPhrase,
    last_seed_ms: p.fetchPhraseDurationMs,
  };
}

function evalFromLegacy(p: DiscoveryProgressState): DiscoveryEvalLane {
  if (p.evalLane) return p.evalLane;
  const running = p.phase === "analyzing" || p.phase === "draining";
  const waiting = p.phase === "queueing";
  const q = p.sessionLiveStats?.queueRemaining ?? 0;
  return {
    status: running ? "running" : waiting && q > 0 ? "waiting" : "idle",
    jobs_evaluated: p.sessionLiveStats?.jobsEvaluated ?? 0,
    queue_remaining: q,
    high_matches: p.sessionLiveStats?.newHighMatches ?? 0,
    current_title: running ? p.message : undefined,
  };
}

function remainingSeeds(snap: DiscoveryFetchProviderSnap): number {
  if (snap.status === "done" || snap.status === "error") return 0;
  const total = snap.seed_total || 0;
  if (snap.status === "pending") return total;
  return Math.max(0, total - (snap.seed_index || 0) + (snap.seed_index > 0 ? 1 : 0));
}

/** Wall time left for fetch: providers run in parallel, so this is max(per source), not a sum. */
function fetchEtaMs(lane: DiscoveryFetchLane): number | null {
  if (lane.status !== "running") return 0;
  const providers = lane.providers ?? {};
  const ids = (Object.keys(providers) as DiscoveryProviderId[]).length
    ? (Object.keys(providers) as DiscoveryProviderId[])
    : lane.current_provider
      ? [lane.current_provider]
      : [];
  if (ids.length === 0) {
    const tot = lane.seed_total ?? 0;
    const idx = lane.seed_index ?? 0;
    const left = Math.max(0, tot - idx + (idx > 0 ? 1 : 0));
    const unit = lane.last_seed_ms ?? 20_000;
    return left > 0 ? left * unit : null;
  }
  let slowest: number | null = null;
  for (const id of ids) {
    const snap = providers[id];
    if (!snap) continue;
    const left = remainingSeeds(snap);
    if (left <= 0) continue;
    const unit = snap.last_seed_ms ?? PROVIDER_SEED_DEFAULT_MS[id] ?? 20_000;
    const ms = left * unit;
    slowest = slowest == null ? ms : Math.max(slowest, ms);
  }
  return slowest;
}

function evalEtaMs(lane: DiscoveryEvalLane, nowMs: number): number | null {
  const left = lane.queue_remaining;
  if (lane.status === "done" || (lane.status !== "running" && left <= 0)) return 0;
  const timed = lane.timed_jobs ?? 0;
  const timedMs = lane.timed_jobs_ms ?? 0;
  if (timed < 1 || timedMs <= 0) return null;
  const avg = timedMs / timed;
  if (left <= 0) return 0;
  const jobStart = parseIsoMs(lane.job_started_at);
  const inflight = lane.status === "running" ? 1 : 0;
  const currentElapsed = jobStart != null && inflight ? Math.max(0, nowMs - jobStart) : 0;
  const currentLeft = inflight ? Math.max(2_000, avg - currentElapsed) : 0;
  const rest = Math.max(0, left - inflight);
  return currentLeft + rest * avg;
}

function overallEtaMs(fetchMs: number | null, evalMs: number | null, fetchRunning: boolean, evalRunning: boolean): number | null {
  if (fetchMs == null && evalMs == null) return null;
  const f = fetchMs ?? 0;
  const e = evalMs ?? 0;
  if (fetchRunning && evalRunning) return Math.max(f, e);
  if (!fetchRunning) return evalMs;
  if (!evalRunning) return fetchMs == null ? null : f + e;
  return Math.max(f, e);
}

function TrackBar({
  pct,
  tone,
  indeterminate,
}: {
  pct: number;
  tone: "cyan" | "violet";
  indeterminate?: boolean;
}) {
  const fill = tone === "cyan" ? "bg-cyan-400" : "bg-violet-400";
  const ring = tone === "cyan" ? "ring-cyan-700/40" : "ring-violet-700/40";
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-slate-800/90 ring-1 ${ring}`} aria-hidden>
      {indeterminate ? (
        <div className={`h-full w-1/3 ${fill} opacity-80 animate-pulse rounded-full`} />
      ) : (
        <div
          className={`h-full ${fill} rounded-full transition-[width] duration-300 ease-out`}
          style={{ width: `${clampPct(pct)}%` }}
        />
      )}
    </div>
  );
}

function StatusPill({
  status,
}: {
  status: "idle" | "waiting" | "running" | "done" | "error" | "pending";
}) {
  const map: Record<typeof status, { label: string; className: string }> = {
    running: { label: "Running", className: "bg-emerald-500/15 text-emerald-200 ring-emerald-500/30" },
    waiting: { label: "Waiting", className: "bg-amber-500/15 text-amber-100 ring-amber-500/30" },
    done: { label: "Done", className: "bg-slate-500/20 text-slate-300 ring-slate-500/30" },
    error: { label: "Error", className: "bg-rose-500/15 text-rose-200 ring-rose-500/30" },
    pending: { label: "Queued", className: "bg-slate-500/15 text-slate-400 ring-slate-500/25" },
    idle: { label: "Idle", className: "bg-slate-500/15 text-slate-400 ring-slate-500/25" },
  };
  const row = map[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${row.className}`}>
      {status === "running" ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-300 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-300" />
        </span>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      )}
      {row.label}
    </span>
  );
}

function providerList(lane: DiscoveryFetchLane): { id: DiscoveryProviderId; snap: DiscoveryFetchProviderSnap }[] {
  const providers = lane.providers ?? {};
  const ids = PROVIDER_ORDER.filter((id) => providers[id]);
  const extra = (Object.keys(providers) as DiscoveryProviderId[]).filter((id) => !ids.includes(id));
  return [...ids, ...extra].map((id) => ({ id, snap: providers[id]! }));
}

export function DiscoveryLiveProgressBoard({
  p,
  nowMs,
  awaitingFirstTick,
}: {
  p: DiscoveryProgressState | null;
  nowMs: number;
  awaitingFirstTick?: boolean;
}) {
  if (awaitingFirstTick || !p) {
    return (
      <section className="rounded-xl border border-slate-700/80 bg-slate-950/70 p-4 shadow-lg shadow-black/20" aria-live="polite">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Live progress</p>
        <p className="mt-1 text-sm font-medium text-slate-200">Starting discovery…</p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-xs font-semibold text-cyan-200/90">Fetch</p>
            <div className="mt-3 h-2 animate-pulse rounded-full bg-slate-800" />
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-xs font-semibold text-violet-200/90">Ollama</p>
            <div className="mt-3 h-2 animate-pulse rounded-full bg-slate-800" />
          </div>
        </div>
      </section>
    );
  }

  const fetchLane = fetchFromLegacy(p);
  const evalLane = evalFromLegacy(p);
  const runStart = parseIsoMs(p.pipeline_run_started_at) ?? parseIsoMs(fetchLane.started_at);
  const elapsed = runStart != null ? Math.max(0, nowMs - runStart) : null;
  const fetchMs = fetchEtaMs(fetchLane);
  const evalMs = evalEtaMs(evalLane, nowMs);
  const fetchRunning = fetchLane.status === "running";
  const evalRunning = evalLane.status === "running";
  const overall = overallEtaMs(fetchMs, evalMs, fetchRunning, evalRunning);

  const fetchDone = fetchLane.providers_done;
  const fetchTot = Math.max(fetchLane.providers_total, 1);
  const fetchPct = fetchLane.status === "done" ? 100 : (fetchDone / fetchTot) * 100;

  const evalDone = evalLane.jobs_evaluated;
  const evalLeft = evalLane.queue_remaining;
  const evalTot = Math.max(1, evalDone + evalLeft);
  const evalPct = evalLeft + evalDone <= 0 && evalLane.status !== "running" ? 0 : (evalDone / evalTot) * 100;
  const evalHasWork = evalRunning || evalLeft > 0 || evalDone > 0;

  const rows = providerList(fetchLane);
  const livePhrase =
    fetchLane.current_provider && fetchLane.providers?.[fetchLane.current_provider]?.status === "running"
      ? fetchLane.phrase
      : undefined;
  const phrase = livePhrase && livePhrase.length > 42 ? `${livePhrase.slice(0, 42)}…` : livePhrase;
  const title =
    evalRunning && evalLane.current_title && evalLane.current_title.length > 52
      ? `${evalLane.current_title.slice(0, 52)}…`
      : evalRunning
        ? evalLane.current_title
        : undefined;

  const avgJob =
    (evalLane.timed_jobs ?? 0) > 0 && (evalLane.timed_jobs_ms ?? 0) > 0
      ? (evalLane.timed_jobs_ms ?? 0) / (evalLane.timed_jobs ?? 1)
      : null;

  return (
    <section
      className="rounded-xl border border-slate-700/70 bg-gradient-to-b from-slate-900 to-slate-950 p-4 shadow-lg shadow-black/25 ring-1 ring-white/[0.04]"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Live progress</p>
          <p className="mt-0.5 text-sm font-semibold text-slate-100">
            {p.phase === "done" ? "Last run" : "Fetch and Ollama run side by side"}
          </p>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-right tabular-nums">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Elapsed</p>
            <p className="text-sm font-semibold text-slate-100">{elapsed != null ? formatDuration(elapsed) : "—"}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Est. remaining</p>
            <p className="text-sm font-semibold text-amber-100">
              {overall != null ? formatDuration(overall) : "calibrating…"}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-slate-500">Done around</p>
            <p className="text-sm font-semibold text-slate-100">
              {overall != null ? formatClock(overall, nowMs) : "—"}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <article className="rounded-lg border border-cyan-800/40 bg-cyan-950/20 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-cyan-100">Fetch</p>
              <p className="text-[11px] text-cyan-200/70">Listings from job boards</p>
            </div>
            <StatusPill status={fetchLane.status === "idle" ? "pending" : fetchLane.status} />
          </div>
          <div className="mt-3 space-y-1.5">
            <div className="flex items-baseline justify-between text-[11px] tabular-nums text-cyan-100/90">
              <span>
                {fetchDone}/{fetchTot} sources
              </span>
              <span>
                {fetchLane.jobs_added} new
                {fetchMs != null && fetchRunning ? ` · ${formatDuration(fetchMs)} left` : ""}
              </span>
            </div>
            <TrackBar pct={fetchPct} tone="cyan" indeterminate={fetchRunning && fetchDone === 0} />
          </div>
          <ul className="mt-3 space-y-1.5">
            {rows.length > 0
              ? rows.map(({ id, snap }) => {
                  const left = remainingSeeds(snap);
                  const tot = snap.seed_total || 0;
                  const idx = snap.seed_index || 0;
                  const seedPct = snap.status === "done" || snap.status === "error" ? 100 : tot > 0 ? (Math.max(0, idx - 1) / tot) * 100 : 0;
                  return (
                    <li key={id} className="rounded-md bg-slate-950/40 px-2.5 py-1.5">
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="font-medium text-slate-100">{PROVIDER_SHORT[id]}</span>
                        <span className="tabular-nums text-slate-400">
                          {snap.status === "running" && tot > 0
                            ? `seed ${idx}/${tot}`
                            : snap.status === "done"
                              ? `${snap.jobs_new ?? 0} new${
                                  snap.seed_index > 0 && snap.seed_total > 0 && snap.seed_index < snap.seed_total
                                    ? ` · stopped ${snap.seed_index}/${snap.seed_total}`
                                    : ""
                                }`
                              : snap.status === "error"
                                ? "failed"
                                : "queued"}
                        </span>
                      </div>
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className={`h-full rounded-full ${snap.status === "error" ? "bg-rose-400" : "bg-cyan-500/80"}`}
                          style={{ width: `${clampPct(seedPct)}%` }}
                        />
                      </div>
                      {snap.status === "running" && left > 0 ? (
                        <p className="mt-1 text-[10px] text-slate-500 tabular-nums">{left} seed phrase(s) left on this source</p>
                      ) : null}
                    </li>
                  );
                })
              : (
                <li className="text-[11px] text-slate-500">
                  {fetchRunning
                    ? phrase
                      ? `Now: ${phrase}`
                      : "Requesting listings…"
                    : "No source snapshot yet"}
                </li>
              )}
          </ul>
          {fetchRunning && phrase ? (
            <p className="mt-2 truncate text-[11px] text-cyan-100/80">Now: {phrase}</p>
          ) : null}
        </article>

        <article className="rounded-lg border border-violet-800/40 bg-violet-950/20 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold text-violet-100">Ollama</p>
              <p className="text-[11px] text-violet-200/70">CPU / GPU — one job at a time</p>
            </div>
            <StatusPill
              status={
                evalLane.status === "idle" && !evalHasWork
                  ? fetchRunning
                    ? "waiting"
                    : "idle"
                  : evalLane.status
              }
            />
          </div>
          <div className="mt-3 space-y-1.5">
            <div className="flex items-baseline justify-between text-[11px] tabular-nums text-violet-100/90">
              <span>
                {evalDone} done · {evalLeft} left
              </span>
              <span>
                {evalLane.high_matches} matches
                {evalMs != null && evalLeft > 0 ? ` · ${formatDuration(evalMs)} left` : ""}
              </span>
            </div>
            <TrackBar
              pct={evalPct}
              tone="violet"
              indeterminate={evalRunning && evalDone === 0 && evalLeft <= 1}
            />
          </div>
          <div className="mt-3 space-y-1.5 rounded-md bg-slate-950/40 px-2.5 py-2 text-[11px] leading-snug text-slate-300">
            {evalRunning && title ? (
              <p>
                <span className="text-slate-500">Now · </span>
                <span className="text-slate-100">{title}</span>
                {evalLane.current_provider ? (
                  <span className="text-slate-500"> · {PROVIDER_SHORT[evalLane.current_provider]}</span>
                ) : null}
              </p>
            ) : evalLane.status === "waiting" || (fetchRunning && !evalHasWork) ? (
              <p className="text-slate-400">Waiting for the next listing in the eval queue.</p>
            ) : evalLeft > 0 ? (
              <p className="text-slate-400">{evalLeft} job(s) queued for deep analysis.</p>
            ) : evalDone > 0 ? (
              <p className="text-slate-400">Eval queue caught up.</p>
            ) : (
              <p className="text-slate-500">No jobs to score yet.</p>
            )}
            {avgJob != null ? (
              <p className="tabular-nums text-slate-500">~{formatDuration(avgJob)} per job</p>
            ) : evalRunning ? (
              <p className="text-slate-500">Timing this first job to estimate the rest…</p>
            ) : null}
          </div>
        </article>
      </div>

      {fetchRunning && evalHasWork ? (
        <p className="mt-3 text-[11px] text-slate-500">
          Fetch may still add listings — the finish time grows if new jobs land in the Ollama queue.
        </p>
      ) : null}
    </section>
  );
}
