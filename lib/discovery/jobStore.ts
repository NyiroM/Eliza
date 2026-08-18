// lib/discovery/jobStore.ts
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { DISCOVERY_SYNC_BACKLOG_MAX_JOBS } from "../../config/constants";
import type { DiscoveredJob } from "../../types/discovery";
import { getDiscoveryDir, getDiscoveryJobsPath } from "./paths";

export async function ensureDiscoveryDir(): Promise<void> {
  await mkdir(getDiscoveryDir(), { recursive: true });
}

/** Non-empty JSONL rows in jobs.jsonl (Previously found jobs / duplicate catalog). */
export async function countDiscoveredJobLines(): Promise<number> {
  try {
    const raw = await readFile(getDiscoveryJobsPath(), "utf-8");
    return raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

export async function loadDiscoveredJobIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const raw = await readFile(getDiscoveryJobsPath(), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as DiscoveredJob;
        if (j.id) ids.add(j.id);
      } catch {
        /* skip bad line */
      }
    }
  } catch {
    /* no file */
  }
  return ids;
}

export async function appendDiscoveredJobs(jobs: DiscoveredJob[]): Promise<number> {
  if (jobs.length === 0) return 0;
  await ensureDiscoveryDir();
  let n = 0;
  for (const j of jobs) {
    await appendFile(getDiscoveryJobsPath(), `${JSON.stringify(j)}\n`, "utf-8");
    n += 1;
  }
  return n;
}

export async function loadDiscoveredJobsTail(maxLines = 400): Promise<DiscoveredJob[]> {
  try {
    const raw = await readFile(getDiscoveryJobsPath(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const slice = lines.slice(-maxLines);
    const out: DiscoveredJob[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as DiscoveredJob);
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Parse up to `maxLines` jobs from jobs.jsonl (oldest → newest). */
export async function loadDiscoveredJobsAll(maxLines = DISCOVERY_SYNC_BACKLOG_MAX_JOBS): Promise<DiscoveredJob[]> {
  try {
    const raw = await readFile(getDiscoveryJobsPath(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const slice = maxLines > 0 ? lines.slice(-maxLines) : [];
    const out: DiscoveredJob[] = [];
    for (const line of slice) {
      try {
        out.push(JSON.parse(line) as DiscoveredJob);
      } catch {
        /* skip bad line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Rewrite jobs.jsonl applying field patches by job id (every matching line). */
export async function patchDiscoveredJobsById(
  patches: Map<string, Partial<Pick<DiscoveredJob, "description" | "company" | "title">>>,
): Promise<number> {
  if (patches.size === 0) return 0;
  await ensureDiscoveryDir();
  let raw = "";
  try {
    raw = await readFile(getDiscoveryJobsPath(), "utf-8");
  } catch {
    return 0;
  }
  const lines = raw.split("\n");
  let n = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    try {
      const j = JSON.parse(line) as DiscoveredJob;
      const patch = j.id ? patches.get(j.id) : undefined;
      if (!patch) {
        out.push(line);
        continue;
      }
      out.push(JSON.stringify({ ...j, ...patch }));
      n += 1;
    } catch {
      out.push(line);
    }
  }
  await writeFile(getDiscoveryJobsPath(), out.join("\n"), "utf-8");
  return n;
}
