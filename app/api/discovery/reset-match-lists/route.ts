import { NextResponse } from "next/server";
import { clearAllNewMatches } from "../../../../lib/discovery/matchesStore";
import { clearAllNonMatches } from "../../../../lib/discovery/nonMatchesStore";
import { withDiscoverySyncLock } from "../../../../lib/discovery/lock";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

/** POST — empties new_matches.jsonl and non_matches.jsonl. */
export async function POST() {
  try {
    await withDiscoverySyncLock(async () => {
      await Promise.all([clearAllNewMatches(), clearAllNonMatches()]);
    });
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "DISCOVERY_LOCKED") {
      return NextResponse.json(
        { ok: false, error: "Discovery is busy (sync or queue processing). Try again when it finishes." },
        { status: 409, headers: NO_STORE },
      );
    }
    console.error("[discovery/reset-match-lists]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: NO_STORE });
  }
}
