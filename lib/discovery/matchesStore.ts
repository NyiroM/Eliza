// lib/discovery/matchesStore.ts
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { DiscoveryMatchRow } from "../../types/discovery";
import { getDiscoveryDir, getDiscoveryNewMatchesPath } from "./paths";

export async function appendNewMatch(row: DiscoveryMatchRow): Promise<void> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  await appendFile(getDiscoveryNewMatchesPath(), `${JSON.stringify(row)}\n`, "utf-8");
}

/** First matching row for a job_id (scan full file). */
export async function findNewMatchRowByJobId(jobId: string): Promise<DiscoveryMatchRow | null> {
  try {
    const raw = await readFile(getDiscoveryNewMatchesPath(), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as DiscoveryMatchRow;
        if (row.job_id === jobId) return row;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no file */
  }
  return null;
}

/** Removes all lines whose JSON job_id matches (rewrites new_matches.jsonl). */
export async function removeNewMatchesByJobId(jobId: string): Promise<{ removed: number }> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  let raw = "";
  try {
    raw = await readFile(getDiscoveryNewMatchesPath(), "utf-8");
  } catch {
    return { removed: 0 };
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const kept: string[] = [];
  let removed = 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as { job_id?: string };
      if (row.job_id === jobId) {
        removed += 1;
        continue;
      }
      kept.push(line);
    } catch {
      kept.push(line);
    }
  }
  await writeFile(
    getDiscoveryNewMatchesPath(),
    kept.length > 0 ? `${kept.join("\n")}\n` : "",
    "utf-8",
  );
  return { removed };
}

/** Truncate new_matches.jsonl (dashboard “New matches” list). */
export async function clearAllNewMatches(): Promise<void> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  await writeFile(getDiscoveryNewMatchesPath(), "", "utf-8");
}

/** Non-empty JSONL lines in new_matches.jsonl (may exceed dashboard tail). */
export async function countNewMatchLines(): Promise<number> {
  try {
    const raw = await readFile(getDiscoveryNewMatchesPath(), "utf-8");
    return raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** Strongest matches first; tie-break by most recently evaluated. */
function sortMatchRowsByFitScoreDesc(rows: DiscoveryMatchRow[]): void {
  rows.sort((a, b) => {
    const d = (Number(b.fit_score) || 0) - (Number(a.fit_score) || 0);
    if (d !== 0) return d;
    return (Date.parse(b.evaluated_at) || 0) - (Date.parse(a.evaluated_at) || 0);
  });
}

/** Up to `maxLines` rows, strongest `fit_score` first (full file read for correct order). */
export async function loadNewMatchesTail(maxLines = 200): Promise<DiscoveryMatchRow[]> {
  try {
    const raw = await readFile(getDiscoveryNewMatchesPath(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const out: DiscoveryMatchRow[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as DiscoveryMatchRow);
      } catch {
        /* skip */
      }
    }
    sortMatchRowsByFitScoreDesc(out);
    return out.slice(0, maxLines);
  } catch {
    return [];
  }
}
