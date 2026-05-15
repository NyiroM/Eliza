// app/api/upload-cv/skill/route.ts — remove one parsed CV skill from stored user_cv.json.
import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import { loadStoredCvFromStorage, removeSkillFromStoredCv } from "../../../../lib/storage/userCv";
import { resolveOllamaModel } from "../../../../lib/storage/resolveOllamaModel";

const MAX_SKILL_LEN = 200;

export async function POST(request: NextRequest) {
  return withActiveUser(request, async () => {
    let body: { skill?: unknown; model?: unknown };
    try {
      body = (await request.json()) as { skill?: unknown; model?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    const raw = typeof body.skill === "string" ? body.skill : "";
    const skill = raw.trim();
    if (!skill) {
      return NextResponse.json({ error: "Missing non-empty string field: skill." }, { status: 400 });
    }
    if (skill.length > MAX_SKILL_LEN) {
      return NextResponse.json({ error: "Skill value too long." }, { status: 400 });
    }
    const stored = await loadStoredCvFromStorage();
    if (!stored) {
      return NextResponse.json({ error: "No CV loaded for this profile." }, { status: 404 });
    }
    const explicit =
      typeof body.model === "string" && body.model.trim().length > 0 ? body.model.trim() : undefined;
    const model = await resolveOllamaModel(explicit);
    const next = await removeSkillFromStoredCv(skill, model);
    if (next === null) {
      return NextResponse.json({ error: "No CV loaded for this profile." }, { status: 404 });
    }
    const unchanged = next.length === (stored.parsed.skills ?? []).length;
    const merged = await loadStoredCvFromStorage();
    const skill_suggestions = (merged?.skill_suggestions ?? []).filter((r) => r.status === "suggested");
    return NextResponse.json(
      {
        ok: true,
        removed: !unchanged,
        skills: next.slice(0, 200),
        skills_count: next.length,
        uploaded_at: stored.uploaded_at,
        skill_suggestions,
      },
      { status: 200 },
    );
  });
}
