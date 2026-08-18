// lib/discovery/evalQueue.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { DiscoveredJob, DiscoveryProviderId } from "../../types/discovery";
import { loadEvaluatedJobIds } from "./evaluatedStore";
import { isFailureInCooldown, loadEvalFailureMap } from "./evalFailureStore";
import { getDiscoveryDir, getDiscoveryEvalQueuePath } from "./paths";
import type { SuppressedFilter } from "./suppressedStore";
import { isSuppressedDiscoveredJob, loadSuppressedFilter } from "./suppressedStore";

export type QueuedEvalJob = DiscoveredJob & { priority: number };

type QueueFile = { items: QueuedEvalJob[] };

let queueLock: Promise<unknown> = Promise.resolve();

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn);
  queueLock = run.then(() => undefined, () => undefined);
  return run;
}

function tokenizeKeywords(keywords: string): string[] {
  return keywords
    .toLowerCase()
    .split(/[^a-z0-9áéíóöőúüű+#.-]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

/** Higher = analyze sooner (snippet relevance + description richness). */
export function scoreJobHeuristicPriority(job: DiscoveredJob, searchKeywords: string): number {
  const tokens = tokenizeKeywords(searchKeywords);
  const blob = `${job.title}\n${job.description}`.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (blob.includes(t)) hits += 1;
  }
  const lenBonus = Math.min(400, job.description.length) / 20;
  const providerBonus: Record<DiscoveryProviderId, number> = {
    linkedin: 4,
    profession: 3,
    indeed: 2,
  };
  return hits * 8 + lenBonus + (providerBonus[job.provider] ?? 0);
}

async function loadQueueFile(): Promise<QueuedEvalJob[]> {
  try {
    const raw = await readFile(getDiscoveryEvalQueuePath(), "utf-8");
    const parsed = JSON.parse(raw) as QueueFile;
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

async function saveQueueFile(items: QueuedEvalJob[]): Promise<void> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  const data: QueueFile = { items };
  await writeFile(getDiscoveryEvalQueuePath(), JSON.stringify(data, null, 2), "utf-8");
}

export async function clearEvalQueue(): Promise<void> {
  await withQueueLock(() => saveQueueFile([]));
}

/**
 * Merge jobs into the queue (dedupe by id, keep higher priority).
 * Skips ids in `evaluatedIds`, listings in `suppressedFilter` (id or canonical URL), and failure cooldown.
 */
export async function mergeIntoEvalQueue(
  jobs: DiscoveredJob[],
  evaluatedIds: ReadonlySet<string>,
  suppressedFilter: SuppressedFilter,
  searchKeywords: string,
): Promise<number> {
  const failures = await loadEvalFailureMap();
  const now = Date.now();
  const incoming: QueuedEvalJob[] = jobs
    .filter((j) => {
      if (evaluatedIds.has(j.id)) return false;
      if (isSuppressedDiscoveredJob(j, suppressedFilter)) return false;
      const f = failures.get(j.id);
      if (f && isFailureInCooldown(f, now)) return false;
      return true;
    })
    .map((j) => ({
      ...j,
      priority: scoreJobHeuristicPriority(j, searchKeywords),
    }));

  if (incoming.length === 0) return 0;

  return withQueueLock(async () => {
    const existing = await loadQueueFile();
    const byId = new Map<string, QueuedEvalJob>();
    for (const q of existing) {
      byId.set(q.id, q);
    }
    for (const q of incoming) {
      const prev = byId.get(q.id);
      if (!prev || q.priority > prev.priority) {
        byId.set(q.id, q);
      }
    }
    const merged = [...byId.values()].sort((a, b) => b.priority - a.priority);
    await saveQueueFile(merged);
    return incoming.length;
  });
}

/**
 * Rows still present in the eval queue file that are not evaluated and not suppressed.
 * Includes failure-cooldown rows (they are still “pending” for this drain session).
 */
export async function getEvalQueueLength(): Promise<number> {
  const evaluated = await loadEvaluatedJobIds();
  const suppressedFilter = await loadSuppressedFilter();
  return withQueueLock(async () => {
    const items = await loadQueueFile();
    return items.filter((q) => {
      if (evaluated.has(q.id)) return false;
      if (isSuppressedDiscoveredJob(q, suppressedFilter)) return false;
      return true;
    }).length;
  });
}

/** Subset of {@link getEvalQueueLength} that can run immediately (not inside failure cooldown). */
export async function getEvalQueueActionableLength(): Promise<number> {
  const evaluated = await loadEvaluatedJobIds();
  const suppressedFilter = await loadSuppressedFilter();
  const failures = await loadEvalFailureMap();
  const now = Date.now();
  return withQueueLock(async () => {
    const items = await loadQueueFile();
    return items.filter((q) => {
      if (evaluated.has(q.id)) return false;
      if (isSuppressedDiscoveredJob(q, suppressedFilter)) return false;
      const f = failures.get(q.id);
      if (f && isFailureInCooldown(f, now)) return false;
      return true;
    }).length;
  });
}

/** Remove queue items that are evaluated or user-suppressed (by id or canonical URL). */
export async function pruneEvalQueue(
  evaluatedIds: ReadonlySet<string>,
  suppressedFilter: SuppressedFilter,
): Promise<void> {
  await withQueueLock(async () => {
    const items = (await loadQueueFile()).filter(
      (q) => !evaluatedIds.has(q.id) && !isSuppressedDiscoveredJob(q, suppressedFilter),
    );
    await saveQueueFile(items);
  });
}

/**
 * Take up to `max` highest-priority jobs from the queue and remove them from disk.
 * Skips evaluated ids and items still inside their failure cooldown.
 * Caller must mark evaluated (or record a failure) after each pipeline run.
 */
export async function takeFromEvalQueue(
  max: number,
  evaluatedIds: ReadonlySet<string>,
  suppressedFilter: SuppressedFilter,
): Promise<QueuedEvalJob[]> {
  const failures = await loadEvalFailureMap();
  const now = Date.now();
  return withQueueLock(async () => {
    const all = await loadQueueFile();
    const eligible: QueuedEvalJob[] = [];
    const blocked: QueuedEvalJob[] = [];
    for (const q of all) {
      if (evaluatedIds.has(q.id)) continue;
      if (isSuppressedDiscoveredJob(q, suppressedFilter)) continue;
      const f = failures.get(q.id);
      if (f && isFailureInCooldown(f, now)) {
        blocked.push(q);
        continue;
      }
      eligible.push(q);
    }
    eligible.sort((a, b) => b.priority - a.priority);
    const batch = eligible.slice(0, max);
    const leftover = eligible.slice(max);
    await saveQueueFile([...leftover, ...blocked].sort((a, b) => b.priority - a.priority));
    return batch;
  });
}

/** Re-append items to the front of the queue (e.g. after failed pipeline without marking evaluated). */
export async function returnToEvalQueue(jobs: QueuedEvalJob[]): Promise<void> {
  if (jobs.length === 0) return;
  const suppressedFilter = await loadSuppressedFilter();
  const allowed = jobs.filter((j) => !isSuppressedDiscoveredJob(j, suppressedFilter));
  if (allowed.length === 0) return;
  await withQueueLock(async () => {
    const cur = await loadQueueFile();
    const byId = new Map<string, QueuedEvalJob>();
    for (const q of allowed) byId.set(q.id, q);
    for (const q of cur) {
      if (!byId.has(q.id)) byId.set(q.id, q);
    }
    const merged = [...byId.values()].sort((a, b) => b.priority - a.priority);
    await saveQueueFile(merged);
  });
}
