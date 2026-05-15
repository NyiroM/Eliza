// lib/discovery/dupeIndexStore.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { DiscoveredJob, DiscoveryProviderId } from "../../types/discovery";
import { getDiscoveryDir, getDiscoveryDupeIndexPath } from "./paths";
import {
  computeDupeSignals,
  hammingDistance64Hex,
  titleTokenSimilarity,
  type DupeSignals,
} from "./dupeFingerprint";

type DupeIndexEntry = {
  job_id: string;
  provider: DiscoveryProviderId;
  norm_company: string | null;
  title_tokens: string[];
  simhash64_hex: string;
};

type DupeIndexFile = {
  version: 1;
  updated_at: string;
  buckets: Record<string, DupeIndexEntry[]>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function simhashBucketKeyHex(simhash64Hex: string): string {
  const s = (simhash64Hex ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(s)) return "0000";
  // Top 16 bits == first 4 hex chars.
  return s.slice(0, 4);
}

export type DupeDecision = {
  duplicate_of_job_id: string;
  reason: string;
};

export type DupeIndex = {
  findDuplicate: (job: DiscoveredJob) => DupeDecision | null;
  recordJob: (job: DiscoveredJob) => void;
  count: () => number;
  save: () => Promise<void>;
};

export async function loadDupeIndex(filePath?: string): Promise<DupeIndex> {
  const resolvedPath = filePath ?? getDiscoveryDupeIndexPath();
  let data: DupeIndexFile = { version: 1, updated_at: nowIso(), buckets: {} };
  try {
    const raw = await readFile(resolvedPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DupeIndexFile>;
    if (parsed && parsed.version === 1 && parsed.buckets && typeof parsed.buckets === "object") {
      data = {
        version: 1,
        updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : nowIso(),
        buckets: parsed.buckets as Record<string, DupeIndexEntry[]>,
      };
    }
  } catch {
    /* empty */
  }

  const buckets = data.buckets;

  function count(): number {
    let n = 0;
    for (const v of Object.values(buckets)) n += Array.isArray(v) ? v.length : 0;
    return n;
  }

  function findDuplicateBySignals(sig: DupeSignals): DupeDecision | null {
    const key = simhashBucketKeyHex(sig.simhash64_hex);
    const candidates = buckets[key] ?? [];
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    // Precision-first thresholds:
    // - If company known: company must match, title tokens must be strong, simhash moderately close.
    // - If company missing: require very strong title AND very close simhash.
    const hasCompany = Boolean(sig.normCompany);
    const minTitleJaccard = hasCompany ? 0.72 : 0.92;
    const maxHam = hasCompany ? 8 : 3;

    let best: { jobId: string; ham: number; titleSim: number; reason: string } | null = null;

    for (const c of candidates) {
      if (hasCompany) {
        if (!c.norm_company || c.norm_company !== sig.normCompany) continue;
      } else {
        // Company missing: only compare against candidates that also don't have a company.
        if (c.norm_company) continue;
      }

      const titleSim = titleTokenSimilarity(sig.titleTokens, c.title_tokens ?? []);
      if (titleSim < minTitleJaccard) continue;
      const ham = hammingDistance64Hex(sig.simhash64_hex, c.simhash64_hex);
      if (ham > maxHam) continue;

      const reason = hasCompany
        ? `company+title+simhash match (jaccard=${titleSim.toFixed(2)} ham=${ham})`
        : `title+simhash match (no company) (jaccard=${titleSim.toFixed(2)} ham=${ham})`;

      if (!best || ham < best.ham || (ham === best.ham && titleSim > best.titleSim)) {
        best = { jobId: c.job_id, ham, titleSim, reason };
      }
    }

    return best ? { duplicate_of_job_id: best.jobId, reason: best.reason } : null;
  }

  function findDuplicate(job: DiscoveredJob): DupeDecision | null {
    const sig = computeDupeSignals(job);
    return findDuplicateBySignals(sig);
  }

  function recordJobBySignals(jobId: string, provider: DiscoveryProviderId, sig: DupeSignals): void {
    const key = simhashBucketKeyHex(sig.simhash64_hex);
    const arr = buckets[key] ?? [];
    // Avoid unbounded growth for exact repeats.
    if (arr.some((x) => x.job_id === jobId)) {
      buckets[key] = arr;
      return;
    }
    arr.push({
      job_id: jobId,
      provider,
      norm_company: sig.normCompany ?? null,
      title_tokens: sig.titleTokens.slice(0, 24),
      simhash64_hex: sig.simhash64_hex,
    });
    buckets[key] = arr;
  }

  function recordJob(job: DiscoveredJob): void {
    const sig = computeDupeSignals(job);
    recordJobBySignals(job.id, job.provider, sig);
  }

  async function save(): Promise<void> {
    await mkdir(getDiscoveryDir(), { recursive: true });
    const next: DupeIndexFile = { version: 1, updated_at: nowIso(), buckets };
    await writeFile(resolvedPath, JSON.stringify(next, null, 2), "utf-8");
  }

  return { findDuplicate, recordJob, count, save };
}

