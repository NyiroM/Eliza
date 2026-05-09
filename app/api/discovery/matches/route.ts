import { NextRequest, NextResponse } from "next/server";
import { countDiscoveredJobLines } from "../../../../lib/discovery/jobStore";
import {
  countNewMatchLines,
  findNewMatchRowByJobId,
  loadNewMatchesTail,
  removeNewMatchesByJobId,
} from "../../../../lib/discovery/matchesStore";
import {
  countNonMatchLines,
  findNonMatchRowByJobId,
  loadNonMatchesTail,
  removeNonMatchesByJobId,
} from "../../../../lib/discovery/nonMatchesStore";
import { addSuppressedListing } from "../../../../lib/discovery/suppressedStore";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

const JOB_ID_RE = /^[a-f0-9]{24}$/i;

export async function GET() {
  const [matches, nonMatches, new_matches_total, non_matches_total, previously_found_jobs_total] = await Promise.all([
    loadNewMatchesTail(100),
    loadNonMatchesTail(100),
    countNewMatchLines(),
    countNonMatchLines(),
    countDiscoveredJobLines(),
  ]);
  return NextResponse.json(
    { matches, nonMatches, new_matches_total, non_matches_total, previously_found_jobs_total },
    { headers: NO_STORE },
  );
}

type DeleteBody = { job_id?: unknown };

export async function DELETE(request: NextRequest) {
  let jobId: string | undefined;
  const q = request.nextUrl.searchParams.get("job_id");
  if (typeof q === "string" && q.trim()) {
    jobId = q.trim();
  } else {
    let body: DeleteBody;
    try {
      body = (await request.json()) as DeleteBody;
    } catch {
      return NextResponse.json({ error: "Expected JSON body with job_id or ?job_id=" }, { status: 400, headers: NO_STORE });
    }
    if (typeof body.job_id === "string" && body.job_id.trim()) {
      jobId = body.job_id.trim();
    }
  }

  if (!jobId || !JOB_ID_RE.test(jobId)) {
    return NextResponse.json({ error: "Invalid or missing job_id (24-char hex)." }, { status: 400, headers: NO_STORE });
  }

  const list = request.nextUrl.searchParams.get("list");
  if (list === "rejects") {
    const row = await findNonMatchRowByJobId(jobId);
    const { removed } = await removeNonMatchesByJobId(jobId);
    await addSuppressedListing(
      row
        ? { id: row.job_id, provider: row.provider, url: row.url }
        : { id: jobId, provider: "", url: "" },
    );
    return NextResponse.json({ ok: true, removed }, { headers: NO_STORE });
  }

  const row = await findNewMatchRowByJobId(jobId);
  const { removed } = await removeNewMatchesByJobId(jobId);
  await addSuppressedListing(
    row ? { id: row.job_id, provider: row.provider, url: row.url } : { id: jobId, provider: "", url: "" },
  );
  return NextResponse.json({ ok: true, removed }, { headers: NO_STORE });
}
