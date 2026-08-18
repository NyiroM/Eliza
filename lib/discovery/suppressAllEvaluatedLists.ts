// lib/discovery/suppressAllEvaluatedLists.ts — Clear lists: suppress + empty both evaluated JSONL files.
import { clearAllNewMatches, loadAllNewMatches } from "./matchesStore";
import { clearAllNonMatches, loadAllNonMatches } from "./nonMatchesStore";
import { mergeSuppressedListings } from "./suppressedStore";

export type SuppressAllEvaluatedListsResult = {
  new_matches_lines: number;
  non_matches_lines: number;
  suppressed_listings: number;
};

/** Same outcome as trash on every row: add to suppressed_ids, then truncate both list files. */
export async function suppressAndClearAllEvaluatedLists(): Promise<SuppressAllEvaluatedListsResult> {
  const [matchRows, nonMatchRows] = await Promise.all([loadAllNewMatches(), loadAllNonMatches()]);
  const byJobId = new Map<string, { id: string; provider: string; url: string }>();
  for (const row of matchRows) {
    byJobId.set(row.job_id, { id: row.job_id, provider: row.provider, url: row.url });
  }
  for (const row of nonMatchRows) {
    if (!byJobId.has(row.job_id)) {
      byJobId.set(row.job_id, { id: row.job_id, provider: row.provider, url: row.url });
    }
  }
  await mergeSuppressedListings([...byJobId.values()]);
  await Promise.all([clearAllNewMatches(), clearAllNonMatches()]);
  return {
    new_matches_lines: matchRows.length,
    non_matches_lines: nonMatchRows.length,
    suppressed_listings: byJobId.size,
  };
}
