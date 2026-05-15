import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import { expandDiscoveryPhrasesWithOllama } from "../../../../lib/discovery/expandSearchSynonyms";
import { normalizeKeywordPhrase, sanitizeKeywordSuggestions } from "../../../../lib/discovery/keywordSync";
import { loadDiscoverySettings, saveDiscoverySettings } from "../../../../lib/discovery/settings";
import type { DiscoveryKeywordSuggestion } from "../../../../types/discovery";
import { resolveOllamaModel } from "../../../../lib/storage/resolveOllamaModel";
import { validateOllamaModelTag } from "../../../../lib/validation";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

type Body = { model?: unknown };

export async function POST(request: NextRequest) {
  return withActiveUser(request, async () => {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE });
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

  const settings = await loadDiscoverySettings();
  const bases = settings.search_keywords
    .split(",")
    .map((s) => normalizeKeywordPhrase(s))
    .filter((s) => s.length > 0);
  if (bases.length === 0) {
    return NextResponse.json(
      { error: "Add at least one keyword in Search keywords before generating suggestions." },
      { status: 400, headers: NO_STORE },
    );
  }

  const expanded = await expandDiscoveryPhrasesWithOllama(bases, model);
  const manualLower = new Set(bases.map((b) => b.toLowerCase()));
  const seen = new Set(settings.keyword_suggestions.map((s) => s.phrase.toLowerCase()));
  const next: DiscoveryKeywordSuggestion[] = [...settings.keyword_suggestions];

  for (const phrase of expanded) {
    const p = normalizeKeywordPhrase(phrase).slice(0, 160);
    if (!p) continue;
    const low = p.toLowerCase();
    if (manualLower.has(low) || seen.has(low)) continue;
    seen.add(low);
    next.push({ phrase: p, status: "suggested" });
  }

  const merged = sanitizeKeywordSuggestions(next);
  await saveDiscoverySettings({ ...settings, keyword_suggestions: merged });
  const saved = await loadDiscoverySettings();
  return NextResponse.json(saved, { headers: NO_STORE });
  });
}
