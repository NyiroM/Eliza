// lib/discovery/refreshThinIndeedCatalog.ts — re-fetch JDs for title-only Indeed catalog rows.
import type { DiscoveredJob } from "../../types/discovery";
import { jobNeedsDescriptionEnrichment } from "./descriptionQuality";
import { mergeIntoEvalQueue } from "./evalQueue";
import { removeEvaluatedJobIds } from "./evaluatedStore";
import { patchDiscoveredJobsById } from "./jobStore";
import { removeNonMatchesByJobIds } from "./nonMatchesStore";
import { hydrateIndeedJobsViaSerpVjk } from "./sources/indeedPlaywright";
import type { SuppressedFilter } from "./suppressedStore";

function indeedHydrateCap(): number {
  const raw = parseInt(process.env.ELIZA_INDEED_CATALOG_HYDRATE_MAX ?? "", 10);
  if (Number.isFinite(raw)) return Math.max(0, Math.min(400, raw));
  return 100;
}

/** Mutates thin Indeed jobs in `jobs`, writes JDs back to jobs.jsonl. */
export async function hydrateThinIndeedJobs(jobs: DiscoveredJob[]): Promise<DiscoveredJob[]> {
  const cap = indeedHydrateCap();
  if (cap === 0) return [];
  const thin = jobs
    .filter((j) => j.provider === "indeed" && jobNeedsDescriptionEnrichment(j))
    .slice(-cap)
    .reverse();
  if (thin.length === 0) return [];
  try {
    await hydrateIndeedJobsViaSerpVjk(thin);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[indeedCatalogHydrate] Playwright session failed", msg);
    return [];
  }
  const hydrated = thin.filter((j) => !jobNeedsDescriptionEnrichment(j));
  if (hydrated.length === 0) return [];
  const patches = new Map<string, Pick<DiscoveredJob, "description">>();
  for (const j of hydrated) {
    patches.set(j.id, { description: j.description });
  }
  await patchDiscoveredJobsById(patches);
  return hydrated;
}

export async function requeueHydratedIndeedJobs(
  hydrated: DiscoveredJob[],
  searchKeywords: string,
  suppressedFilter: SuppressedFilter,
): Promise<number> {
  if (hydrated.length === 0) return 0;
  const ids = hydrated.map((j) => j.id);
  await removeEvaluatedJobIds(ids);
  await removeNonMatchesByJobIds(ids);
  return mergeIntoEvalQueue(hydrated, new Set<string>(), suppressedFilter, searchKeywords);
}
