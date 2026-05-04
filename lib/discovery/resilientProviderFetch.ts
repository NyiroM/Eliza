// lib/discovery/resilientProviderFetch.ts — multi-phrase + widening-ladder fetch for Indeed / LinkedIn / Profession.
import type { DiscoveredJob, DiscoveryProviderId } from "../../types/discovery";
import { discoveryTerminalLog } from "./discoveryTerminalLog";
import { warnIfPlaywrightChromiumMissingForDiscovery } from "./playwrightChromiumPreflight";
import { fetchIndeedJobsPlaywright } from "./sources/indeedPlaywright";
import { fetchIndeedRssJobs } from "./sources/indeedRss";
import { fetchLinkedInGuestJobs } from "./sources/linkedinGuest";
import { fetchProfessionHuJobs } from "./sources/professionHu";
import { fetchProfessionHuJobsPlaywright } from "./sources/professionHuPlaywright";
import { buildWideningLadder, truncateHint } from "./searchKeywords";

/** Caps how many distinct seed phrases hit the network per provider. Override: `ELIZA_DISCOVERY_MAX_SEED_PHRASES` (1–10). */
const rawMaxSeeds = parseInt(process.env.ELIZA_DISCOVERY_MAX_SEED_PHRASES ?? "", 10);
export const DISCOVERY_MAX_SEED_PHRASES_EFFECTIVE = Number.isFinite(rawMaxSeeds)
  ? Math.min(10, Math.max(1, rawMaxSeeds))
  : 5;

export type FetchPhraseProgressEvent =
  | {
      kind: "start";
      seedIndex1Based: number;
      seedsTotal: number;
      phrase: string;
      keywordsInListTotal: number;
    }
  | {
      kind: "done";
      seedIndex1Based: number;
      seedsTotal: number;
      phrase: string;
      keywordsInListTotal: number;
      durationMs: number;
      uniqueCount: number;
    };

export type FetchJobsProgressOpts = {
  keywordsInListTotal: number;
  onPhrase?: (provider: DiscoveryProviderId, ev: FetchPhraseProgressEvent) => void | Promise<void>;
};

/** Profession.hu: one Playwright session is expensive; do not burn time on token-dropping retries. */
function professionSearchAttempts(seed: string): string[] {
  const t = seed.trim();
  return t ? [t] : [];
}

async function fetchIndeedOnce(keywords: string, maxItems: number): Promise<DiscoveredJob[]> {
  if (process.env.ELIZA_DISCOVERY_PLAYWRIGHT === "0") {
    return fetchIndeedRssJobs(keywords, maxItems);
  }
  return fetchIndeedJobsPlaywright(keywords, maxItems);
}

const PROVIDER_LABEL: Record<DiscoveryProviderId, string> = {
  indeed: "Indeed",
  linkedin: "LinkedIn",
  profession: "Profession.hu",
};

function formatHint(provider: DiscoveryProviderId, parts: string[]): string | null {
  if (parts.length === 0) return null;
  const label = PROVIDER_LABEL[provider];
  const tail = parts.slice(-4);
  return truncateHint(`${label}: ${tail.join(" · ")}`);
}

async function fetchProfessionOnce(keywords: string, maxListings: number): Promise<DiscoveredJob[]> {
  const skipPw = process.env.ELIZA_DISCOVERY_PLAYWRIGHT === "0";
  if (!skipPw) {
    try {
      const rawDv = parseInt(process.env.ELIZA_PROFESSION_DETAIL_VISITS ?? "", 10);
      const detailVisits = Number.isFinite(rawDv) ? Math.min(8, Math.max(0, rawDv)) : 1;
      return await fetchProfessionHuJobsPlaywright(keywords, maxListings, detailVisits);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[discovery] Profession Playwright failed, using HTTP fallback:", msg);
    }
  }
  return fetchProfessionHuJobs(keywords, Math.min(20, maxListings));
}

async function fetchLinkedInResilient(
  id: DiscoveryProviderId,
  orderedPhrases: string[],
  maxTotal: number,
  progress?: FetchJobsProgressOpts,
): Promise<{ jobs: DiscoveredJob[]; hint: string | null; error?: string }> {
  const byId = new Map<string, DiscoveredJob>();
  const notes: string[] = [];
  let lastHttp: string | undefined;
  const kwTotal = progress?.keywordsInListTotal ?? orderedPhrases.length;
  const seedsTotal = orderedPhrases.length;

  outer: for (let si = 0; si < orderedPhrases.length; si += 1) {
    const seed = orderedPhrases[si];
    if (byId.size >= maxTotal) break;
    const t0 = Date.now();
    await progress?.onPhrase?.(id, {
      kind: "start",
      seedIndex1Based: si + 1,
      seedsTotal,
      phrase: seed,
      keywordsInListTotal: kwTotal,
    });
    let brokeOnError = false;
    try {
      inner: for (const attempt of buildWideningLadder(seed)) {
        if (byId.size >= maxTotal) break outer;
        try {
          const batch = await fetchLinkedInGuestJobs(attempt, "Hungary", maxTotal);
          if (batch.length === 0) {
            notes.push(`0 results for "${attempt}"`);
            continue;
          }
          const before = byId.size;
          for (const j of batch) {
            if (!byId.has(j.id)) byId.set(j.id, j);
            if (byId.size >= maxTotal) break;
          }
          const added = byId.size - before;
          if (attempt !== seed.trim()) {
            notes.push(`0 results for "${seed}", trying "${attempt}" (${added} jobs)`);
          }
          break inner;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lastHttp = msg;
          notes.push(msg.includes("403") ? `HTTP 403 for "${attempt}"` : msg.slice(0, 80));
          brokeOnError = true;
          break outer;
        }
      }
    } finally {
      const elapsed = Date.now() - t0;
      await progress?.onPhrase?.(id, {
        kind: "done",
        seedIndex1Based: si + 1,
        seedsTotal,
        phrase: seed,
        keywordsInListTotal: kwTotal,
        durationMs: elapsed,
        uniqueCount: byId.size,
      });
      discoveryTerminalLog(
        `phase=fetch_keyword_done provider=${id} seed_index=${si + 1}/${seedsTotal} phrase="${seed.slice(0, 48)}${seed.length > 48 ? "…" : ""}" duration_ms=${elapsed} unique_listings=${byId.size}${brokeOnError ? " error=1" : ""}`,
      );
    }
    if (brokeOnError) break;
    if (byId.size >= maxTotal) break;
  }

  const jobs = [...byId.values()].slice(0, maxTotal);
  const hint = formatHint("linkedin", notes);
  if (jobs.length === 0 && lastHttp) return { jobs: [], hint, error: lastHttp };
  if (jobs.length === 0) return { jobs: [], hint: hint ?? `LinkedIn: no jobs for tried searches.` };
  return { jobs, hint };
}

async function fetchIndeedResilient(
  id: DiscoveryProviderId,
  orderedPhrases: string[],
  maxTotal: number,
  progress?: FetchJobsProgressOpts,
): Promise<{ jobs: DiscoveredJob[]; hint: string | null; error?: string }> {
  await warnIfPlaywrightChromiumMissingForDiscovery().catch(() => {});
  const byId = new Map<string, DiscoveredJob>();
  const notes: string[] = [];
  let lastErr: string | undefined;
  const kwTotal = progress?.keywordsInListTotal ?? orderedPhrases.length;
  const seedsTotal = orderedPhrases.length;

  outer: for (let si = 0; si < orderedPhrases.length; si += 1) {
    const seed = orderedPhrases[si];
    if (byId.size >= maxTotal) break;
    const t0 = Date.now();
    await progress?.onPhrase?.(id, {
      kind: "start",
      seedIndex1Based: si + 1,
      seedsTotal,
      phrase: seed,
      keywordsInListTotal: kwTotal,
    });
    let brokeOnError = false;
    try {
      inner: for (const attempt of buildWideningLadder(seed)) {
        if (byId.size >= maxTotal) break outer;
        try {
          const batch = await fetchIndeedOnce(attempt, maxTotal);
          if (batch.length === 0) {
            notes.push(`0 results for "${attempt}"`);
            continue;
          }
          const before = byId.size;
          for (const j of batch) {
            if (!byId.has(j.id)) byId.set(j.id, j);
            if (byId.size >= maxTotal) break;
          }
          const added = byId.size - before;
          if (attempt !== seed.trim()) {
            notes.push(`0 results for "${seed}", trying "${attempt}" (${added} jobs)`);
          }
          break inner;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lastErr = msg;
          notes.push(msg.includes("403") ? `HTTP 403 for "${attempt}"` : msg.slice(0, 80));
          brokeOnError = true;
          break outer;
        }
      }
    } finally {
      const elapsed = Date.now() - t0;
      await progress?.onPhrase?.(id, {
        kind: "done",
        seedIndex1Based: si + 1,
        seedsTotal,
        phrase: seed,
        keywordsInListTotal: kwTotal,
        durationMs: elapsed,
        uniqueCount: byId.size,
      });
      discoveryTerminalLog(
        `phase=fetch_keyword_done provider=${id} seed_index=${si + 1}/${seedsTotal} phrase="${seed.slice(0, 48)}${seed.length > 48 ? "…" : ""}" duration_ms=${elapsed} unique_listings=${byId.size}${brokeOnError ? " error=1" : ""}`,
      );
    }
    if (brokeOnError) break;
    if (byId.size >= maxTotal) break;
  }

  const jobs = [...byId.values()].slice(0, maxTotal);
  const hint = formatHint("indeed", notes);
  if (jobs.length === 0 && lastErr) return { jobs: [], hint, error: lastErr };
  if (jobs.length === 0) return { jobs: [], hint: hint ?? `Indeed: no jobs for tried searches.` };
  return { jobs, hint };
}

async function fetchProfessionResilient(
  id: DiscoveryProviderId,
  orderedPhrases: string[],
  maxTotal: number,
  progress?: FetchJobsProgressOpts,
): Promise<{ jobs: DiscoveredJob[]; hint: string | null; error?: string }> {
  await warnIfPlaywrightChromiumMissingForDiscovery().catch(() => {});
  const byId = new Map<string, DiscoveredJob>();
  const notes: string[] = [];
  let lastErr: string | undefined;
  const kwTotal = progress?.keywordsInListTotal ?? orderedPhrases.length;
  const seedsTotal = orderedPhrases.length;

  outer: for (let si = 0; si < orderedPhrases.length; si += 1) {
    const seed = orderedPhrases[si];
    if (byId.size >= maxTotal) break;
    const t0 = Date.now();
    await progress?.onPhrase?.(id, {
      kind: "start",
      seedIndex1Based: si + 1,
      seedsTotal,
      phrase: seed,
      keywordsInListTotal: kwTotal,
    });
    let brokeOnError = false;
    try {
      inner: for (const attempt of professionSearchAttempts(seed)) {
        if (byId.size >= maxTotal) break outer;
        try {
          const batch = await fetchProfessionOnce(attempt, 22);
          if (batch.length === 0) {
            notes.push(`0 results for "${attempt}"`);
            continue;
          }
          const before = byId.size;
          for (const j of batch) {
            if (!byId.has(j.id)) byId.set(j.id, j);
            if (byId.size >= maxTotal) break;
          }
          const added = byId.size - before;
          if (attempt !== seed.trim()) {
            notes.push(`0 results for "${seed}", trying "${attempt}" (${added} jobs)`);
          }
          break inner;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lastErr = msg;
          notes.push(msg.includes("403") ? `HTTP 403 for "${attempt}"` : msg.slice(0, 80));
          brokeOnError = true;
          break outer;
        }
      }
    } finally {
      const elapsed = Date.now() - t0;
      await progress?.onPhrase?.(id, {
        kind: "done",
        seedIndex1Based: si + 1,
        seedsTotal,
        phrase: seed,
        keywordsInListTotal: kwTotal,
        durationMs: elapsed,
        uniqueCount: byId.size,
      });
      discoveryTerminalLog(
        `phase=fetch_keyword_done provider=${id} seed_index=${si + 1}/${seedsTotal} phrase="${seed.slice(0, 48)}${seed.length > 48 ? "…" : ""}" duration_ms=${elapsed} unique_listings=${byId.size}${brokeOnError ? " error=1" : ""}`,
      );
    }
    if (brokeOnError) break;
    if (byId.size >= maxTotal) break;
  }

  const jobs = [...byId.values()].slice(0, maxTotal);
  const hint = formatHint("profession", notes);
  if (jobs.length === 0 && lastErr) return { jobs: [], hint, error: lastErr };
  if (jobs.length === 0) return { jobs: [], hint: hint ?? `Profession.hu: no jobs for tried searches.` };
  return { jobs, hint };
}

export async function fetchJobsForProviderResilient(
  id: DiscoveryProviderId,
  orderedPhrases: string[],
  maxTotal: number,
  progress?: FetchJobsProgressOpts,
): Promise<{ jobs: DiscoveredJob[]; hint: string | null; error?: string }> {
  const seeds = orderedPhrases.slice(0, DISCOVERY_MAX_SEED_PHRASES_EFFECTIVE);
  if (id === "linkedin") return fetchLinkedInResilient(id, seeds, maxTotal, progress);
  if (id === "indeed") return fetchIndeedResilient(id, seeds, maxTotal, progress);
  return fetchProfessionResilient(id, seeds, maxTotal, progress);
}
