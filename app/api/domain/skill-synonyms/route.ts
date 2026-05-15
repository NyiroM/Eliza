import { NextRequest, NextResponse } from "next/server";
import { SKILL_SYNONYM_SUGGEST_LIMITS } from "../../../../config/constants";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import {
  loadSkillSynonymsFromStorage,
  saveSkillSynonymsToStorage,
  type SkillSynonymPair,
  type StoredSkillSynonyms,
} from "../../../../lib/storage/skillSynonyms";

type PutBody = { pairs?: unknown; pending_suggestions?: unknown };

function sanitizePairs(raw: unknown): SkillSynonymPair[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillSynonymPair[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const from = typeof r.from === "string" ? r.from.trim() : "";
    const to = typeof r.to === "string" ? r.to.trim() : "";
    if (!from || !to) continue;
    if (from.length > 120 || to.length > 120) continue;
    out.push({ from, to });
  }
  return out.slice(0, 200);
}

function sanitizePending(raw: unknown): SkillSynonymPair[] {
  const list = sanitizePairs(raw);
  return list.slice(0, SKILL_SYNONYM_SUGGEST_LIMITS.maxPendingStored);
}

export async function GET(request: NextRequest) {
  return withActiveUser(request, async () => {
  const data = await loadSkillSynonymsFromStorage();
  return NextResponse.json(data, { status: 200 });
  });
}

export async function PUT(request: NextRequest) {
  return withActiveUser(request, async () => {
  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const existing = await loadSkillSynonymsFromStorage();
  const pairs = sanitizePairs(body.pairs);
  const pending_suggestions =
    body.pending_suggestions !== undefined
      ? sanitizePending(body.pending_suggestions)
      : existing.pending_suggestions;
  const next: StoredSkillSynonyms = {
    pairs,
    pending_suggestions,
    updated_at: new Date().toISOString(),
  };
  await saveSkillSynonymsToStorage(next);
  return NextResponse.json(next, { status: 200 });
  });
}
