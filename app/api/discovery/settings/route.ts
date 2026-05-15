import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import type { DiscoveryProviderId, DiscoverySettings } from "../../../../types/discovery";
import { sanitizeKeywordSuggestions } from "../../../../lib/discovery/keywordSync";
import { loadDiscoverySettings, saveDiscoverySettings } from "../../../../lib/discovery/settings";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export async function GET(request: NextRequest) {
  return withActiveUser(request, async () => {
  const settings = await loadDiscoverySettings();
  return NextResponse.json(settings, { headers: NO_STORE });
  });
}

type Body = {
  auto_sync_interval_minutes?: unknown;
  match_notify_threshold_percent?: unknown;
  search_keywords?: unknown;
  keyword_suggestions?: unknown;
  providers?: Partial<Record<DiscoveryProviderId, { auto?: unknown }>>;
};

export async function POST(request: NextRequest) {
  return withActiveUser(request, async () => {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
  }

  const cur = await loadDiscoverySettings();
  const next: DiscoverySettings = { ...cur };

  if (typeof body.auto_sync_interval_minutes === "number" && Number.isFinite(body.auto_sync_interval_minutes)) {
    next.auto_sync_interval_minutes = Math.min(24 * 60, Math.max(5, Math.round(body.auto_sync_interval_minutes)));
  }
  if (
    typeof body.match_notify_threshold_percent === "number" &&
    Number.isFinite(body.match_notify_threshold_percent)
  ) {
    next.match_notify_threshold_percent = Math.min(100, Math.max(0, Math.round(body.match_notify_threshold_percent)));
  }
  if (typeof body.search_keywords === "string") {
    next.search_keywords = body.search_keywords;
  }
  if (body.keyword_suggestions !== undefined) {
    next.keyword_suggestions = sanitizeKeywordSuggestions(body.keyword_suggestions);
  }
  if (body.providers && typeof body.providers === "object") {
    for (const key of ["indeed", "linkedin", "profession"] as const) {
      const patch = body.providers[key];
      if (patch && typeof patch === "object" && typeof patch.auto === "boolean") {
        next.providers[key] = { ...next.providers[key], auto: patch.auto };
      }
    }
  }

  await saveDiscoverySettings(next);
  return NextResponse.json(next, { headers: NO_STORE });
  });
}
