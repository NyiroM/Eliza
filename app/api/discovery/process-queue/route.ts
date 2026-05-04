import { NextRequest, NextResponse } from "next/server";
import { DISCOVERY_QUEUE_DRAIN_BATCH } from "../../../../config/constants";
import {
  clearDiscoveryProgress,
  defaultSessionLiveStats,
  readDiscoveryProgress,
  setDiscoveryProgress,
} from "../../../../lib/discovery/progress";
import {
  isDiscoverySyncLocked,
  markDiscoveryAwaitingDrain,
  withDiscoverySyncLock,
} from "../../../../lib/discovery/lock";
import { discoveryTerminalLog } from "../../../../lib/discovery/discoveryTerminalLog";
import { processEvalQueue } from "../../../../lib/discovery/processEvalQueue";
import { resolveOllamaModel } from "../../../../lib/storage/resolveOllamaModel";
import { validateOllamaModelTag, validatePreferredLocationField } from "../../../../lib/validation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

type Body = {
  model?: unknown;
  preferred_location?: unknown;
  batch_size?: unknown;
};

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    body = {};
  }

  if (isDiscoverySyncLocked()) {
    return NextResponse.json(
      { ok: false, locked: true, error: "Another discovery operation is running." },
      { status: 409, headers: NO_STORE },
    );
  }

  const rawModel =
    typeof body.model === "string" && body.model.trim().length > 0 ? body.model.trim() : undefined;
  let model: string;
  if (rawModel) {
    const m = validateOllamaModelTag(rawModel);
    if (!m.ok) {
      return NextResponse.json({ error: m.error }, { status: 400, headers: NO_STORE });
    }
    model = m.model;
  } else {
    model = await resolveOllamaModel(undefined);
  }

  const ploc = validatePreferredLocationField(body.preferred_location);
  if (!ploc.ok) {
    return NextResponse.json({ error: ploc.error }, { status: 400, headers: NO_STORE });
  }
  const preferred_location = ploc.preferred_location;

  let batchSize = DISCOVERY_QUEUE_DRAIN_BATCH;
  if (typeof body.batch_size === "number" && Number.isFinite(body.batch_size)) {
    batchSize = Math.min(20, Math.max(1, Math.round(body.batch_size)));
  }

  try {
    const result = await withDiscoverySyncLock(() =>
      processEvalQueue({
        model,
        maxItems: batchSize,
        draining: true,
        ...(preferred_location !== undefined ? { preferred_location } : {}),
      }),
    );
    if (result.queue_remaining === 0) {
      markDiscoveryAwaitingDrain(false);
      await clearDiscoveryProgress().catch(() => {});
    } else {
      const prev = await readDiscoveryProgress();
      const s = prev.sessionLiveStats ?? defaultSessionLiveStats();
      await setDiscoveryProgress({
        sessionLiveStats: {
          ...s,
          jobsEvaluated: s.jobsEvaluated + (result.jobs_evaluated ?? 0),
          newHighMatches: s.newHighMatches + (result.new_high_matches ?? 0),
          queueRemaining: result.queue_remaining,
        },
      });
    }
    discoveryTerminalLog(
      `phase=drain_round batch_size=${batchSize} evaluated=${result.jobs_evaluated} processed=${result.processed} high_matches=${result.new_high_matches} queue_remaining=${result.queue_remaining} retry=${result.failures_pending_retry ?? 0} permanent_fail=${result.failures_permanent ?? 0}`,
    );
    return NextResponse.json(
      {
        ok: true,
        processed: result.processed,
        new_high_matches: result.new_high_matches,
        queue_remaining: result.queue_remaining,
        jobs_evaluated: result.jobs_evaluated,
        failures_pending_retry: result.failures_pending_retry,
        failures_permanent: result.failures_permanent,
      },
      { headers: NO_STORE },
    );
  } catch (e) {
    markDiscoveryAwaitingDrain(false);
    await clearDiscoveryProgress().catch(() => {});
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "DISCOVERY_LOCKED") {
      return NextResponse.json({ ok: false, locked: true }, { status: 409, headers: NO_STORE });
    }
    console.error("[discovery/process-queue]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: NO_STORE });
  }
}
