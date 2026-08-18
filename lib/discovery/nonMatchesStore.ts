// lib/discovery/nonMatchesStore.ts
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import type { DiscoveryNonMatchRow } from "../../types/discovery";
import { getDiscoveryDir, getDiscoveryNonMatchesPath } from "./paths";

export async function appendNonMatch(row: DiscoveryNonMatchRow): Promise<void> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  await appendFile(getDiscoveryNonMatchesPath(), `${JSON.stringify(row)}\n`, "utf-8");
}

/** First matching row for a job_id (scan full file). */
export async function findNonMatchRowByJobId(jobId: string): Promise<DiscoveryNonMatchRow | null> {
  try {
    const raw = await readFile(getDiscoveryNonMatchesPath(), "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as DiscoveryNonMatchRow;
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

/** Removes all lines whose JSON job_id matches (rewrites non_matches.jsonl). */
export async function removeNonMatchesByJobId(jobId: string): Promise<{ removed: number }> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  let raw = "";
  try {
    raw = await readFile(getDiscoveryNonMatchesPath(), "utf-8");
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
    getDiscoveryNonMatchesPath(),
    kept.length > 0 ? `${kept.join("\n")}\n` : "",
    "utf-8",
  );
  return { removed };
}

/** Truncate non_matches.jsonl (“Evaluated, not a match” list). */
export async function clearAllNonMatches(): Promise<void> {
  await mkdir(getDiscoveryDir(), { recursive: true });
  await writeFile(getDiscoveryNonMatchesPath(), "", "utf-8");
}

/** Non-empty JSONL lines in non_matches.jsonl (may exceed dashboard tail). */
export async function countNonMatchLines(): Promise<number> {
  try {
    const raw = await readFile(getDiscoveryNonMatchesPath(), "utf-8");
    return raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** Strongest (highest) fit_score first; tie-break by most recently evaluated. */
function sortNonMatchRowsByFitScoreDesc(rows: DiscoveryNonMatchRow[]): void {
  rows.sort((a, b) => {
    const d = (Number(b.fit_score) || 0) - (Number(a.fit_score) || 0);
    if (d !== 0) return d;
    return (Date.parse(b.evaluated_at) || 0) - (Date.parse(a.evaluated_at) || 0);
  });
}

/** Every row in non_matches.jsonl (unsorted). */
export async function loadAllNonMatches(): Promise<DiscoveryNonMatchRow[]> {
  try {
    const raw = await readFile(getDiscoveryNonMatchesPath(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const out: DiscoveryNonMatchRow[] = [];
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as DiscoveryNonMatchRow);
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Up to `maxLines` rows, strongest `fit_score` first (full file read for correct order). */
export async function loadNonMatchesTail(maxLines = 200): Promise<DiscoveryNonMatchRow[]> {
  const out = await loadAllNonMatches();
  sortNonMatchRowsByFitScoreDesc(out);
  return out.slice(0, maxLines);
}
