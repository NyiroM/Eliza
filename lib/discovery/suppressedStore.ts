// lib/discovery/suppressedStore.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { DiscoveredJob } from "../../types/discovery";
import { canonicalizeJobUrl } from "./id";
import { DISCOVERY_DIR, DISCOVERY_SUPPRESSED_IDS_PATH } from "./paths";

type SuppressedFile = { ids: string[]; canonical_urls?: string[] };

export type SuppressedFilter = {
  ids: ReadonlySet<string>;
  canonicalUrls: ReadonlySet<string>;
};

async function readSuppressedFile(): Promise<SuppressedFile> {
  try {
    const raw = await readFile(DISCOVERY_SUPPRESSED_IDS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SuppressedFile;
    const ids = Array.isArray(parsed.ids) ? parsed.ids : [];
    const canonical_urls = Array.isArray(parsed.canonical_urls) ? parsed.canonical_urls : [];
    return { ids, canonical_urls };
  } catch {
    return { ids: [], canonical_urls: [] };
  }
}

export async function loadSuppressedFilter(): Promise<SuppressedFilter> {
  const f = await readSuppressedFile();
  const ids = new Set(
    f.ids.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim()),
  );
  const canonicalUrls = new Set(
    (f.canonical_urls ?? [])
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((s) => s.trim()),
  );
  return { ids, canonicalUrls };
}

/** @deprecated Prefer loadSuppressedFilter — URLs may also suppress re-queued duplicates. */
export async function loadSuppressedJobIds(): Promise<Set<string>> {
  const f = await loadSuppressedFilter();
  return new Set(f.ids);
}

export function isSuppressedDiscoveredJob(job: DiscoveredJob, filter: SuppressedFilter): boolean {
  if (filter.ids.has(job.id)) return true;
  const c = canonicalizeJobUrl(job.provider, job.url).trim();
  if (!c) return false;
  return filter.canonicalUrls.has(c);
}

/** Persist user-dismissed listings: by id and by canonical URL (covers id drift / duplicate JSONL rows). */
export async function addSuppressedListing(job: { id: string; provider: string; url: string }): Promise<void> {
  const id = job.id.trim();
  if (!id) return;
  const f = await readSuppressedFile();
  const ids = new Set(
    (f.ids ?? []).filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim()),
  );
  const urls = new Set(
    (f.canonical_urls ?? [])
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .map((s) => s.trim()),
  );
  ids.add(id);
  const prov = job.provider.trim();
  const rawUrl = job.url.trim();
  if (prov && rawUrl) {
    const c = canonicalizeJobUrl(prov, rawUrl).trim();
    if (c) urls.add(c);
  }
  await mkdir(DISCOVERY_DIR, { recursive: true });
  const payload: SuppressedFile = {
    ids: [...ids].sort(),
    canonical_urls: urls.size > 0 ? [...urls].sort() : [],
  };
  await writeFile(DISCOVERY_SUPPRESSED_IDS_PATH, JSON.stringify(payload, null, 2), "utf-8");
}

export async function addSuppressedJobId(jobId: string): Promise<void> {
  await addSuppressedListing({ id: jobId, provider: "", url: "" });
}
