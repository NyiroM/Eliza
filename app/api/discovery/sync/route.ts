import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import type { DiscoveryProviderId } from "../../../../types/discovery";
import { getEvalQueueLength } from "../../../../lib/discovery/evalQueue";
import {
  isDiscoverySessionBlockingSync,
  isDiscoverySyncLocked,
  markDiscoveryAwaitingDrain,
  withDiscoverySyncLock,
} from "../../../../lib/discovery/lock";
import { getKeywordsForSync } from "../../../../lib/discovery/keywordSync";
import { loadDiscoverySettings } from "../../../../lib/discovery/settings";
import { runDiscoverySync } from "../../../../lib/discovery/sync";
import { resolveOllamaModel } from "../../../../lib/storage/resolveOllamaModel";
import { hasStoredCv } from "../../../../lib/storage/userCv";
import { validateOllamaModelTag, validatePreferredLocationField } from "../../../../lib/validation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

const ALL_PROVIDERS: DiscoveryProviderId[] = ["indeed", "linkedin", "profession"];

function isProviderId(v: unknown): v is DiscoveryProviderId {
  return v === "indeed" || v === "linkedin" || v === "profession";
}

type SyncBody = {
  mode?: unknown;
  provider?: unknown;
  model?: unknown;
  preferred_location?: unknown;
};

export async function POST(request: NextRequest) {
  return withActiveUser(request, async () => {
  let body: SyncBody;
  try {
    body = (await request.json()) as SyncBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }

  if (isDiscoverySessionBlockingSync()) {
    const pending = await getEvalQueueLength();
    if (pending === 0) {
      markDiscoveryAwaitingDrain(false);
    } else {
      return NextResponse.json(
        {
          ok: false,
          locked: true,
          awaiting_drain: true,
          queue_remaining: pending,
          error: "Discovery queue is still draining from the previous sync. Wait for it to finish.",
        },
        { status: 409, headers: NO_STORE },
      );
    }
  }

  if (isDiscoverySyncLocked()) {
    return NextResponse.json(
      { ok: false, locked: true, error: "Another discovery sync is already running." },
      { status: 409, headers: NO_STORE },
    );
  }

  const mode = body.mode === "auto" ? "auto" : "manual";
  let providers: DiscoveryProviderId[];

  if (mode === "auto") {
    const st = await loadDiscoverySettings();
    providers = ALL_PROVIDERS.filter((p) => st.providers[p].auto);
    if (providers.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No providers have Automatic Monitor enabled." },
        { status: 400, headers: NO_STORE },
      );
    }
  } else {
    const p = body.provider;
    if (p === "all" || p === undefined) {
      providers = [...ALL_PROVIDERS];
    } else if (isProviderId(p)) {
      providers = [p];
    } else {
      return NextResponse.json({ error: "Invalid provider" }, { status: 400, headers: NO_STORE });
    }
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

  const settingsForPhrases = await loadDiscoverySettings();
  if (getKeywordsForSync(settingsForPhrases).length === 0) {
    return NextResponse.json(
      {
        ok: false,
        blocked: "Add at least one comma-separated search keyword before syncing (or approve a suggestion).",
        providers_run: providers,
        jobs_added: 0,
        jobs_evaluated: 0,
        new_high_matches: 0,
        queue_remaining: 0,
        errors: {},
      },
      { headers: NO_STORE },
    );
  }

  if (!(await hasStoredCv())) {
    return NextResponse.json(
      {
        ok: false,
        blocked: "Upload and parse a CV on the Analysis tab before running discovery sync.",
        providers_run: providers,
        jobs_added: 0,
        jobs_evaluated: 0,
        new_high_matches: 0,
        queue_remaining: 0,
        errors: {},
      },
      { headers: NO_STORE },
    );
  }

  try {
    const result = await withDiscoverySyncLock(() =>
      runDiscoverySync({
        providers,
        model,
        ...(preferred_location !== undefined ? { preferred_location } : {}),
      }),
    );
    if (result.queue_remaining > 0) {
      markDiscoveryAwaitingDrain(true);
    } else {
      markDiscoveryAwaitingDrain(false);
    }
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (e) {
    markDiscoveryAwaitingDrain(false);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "DISCOVERY_LOCKED") {
      return NextResponse.json({ ok: false, locked: true }, { status: 409, headers: NO_STORE });
    }
    console.error("[discovery/sync]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: NO_STORE });
  }
  });
}
