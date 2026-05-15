// app/api/upload-cv/skills/route.ts — replace parsed CV skills (comma list or JSON array) + parse cache sync.
import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import {
  dedupeSkillsList,
  parseCommaSeparatedSkills,
  replaceParsedSkillsInStorage,
} from "../../../../lib/storage/userCv";
import { resolveOllamaModel } from "../../../../lib/storage/resolveOllamaModel";
import { validateOllamaModelTag } from "../../../../lib/validation";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type Body = { skills?: unknown; skills_text?: unknown; model?: unknown };

export async function PUT(request: NextRequest) {
  return withActiveUser(request, async () => {
    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
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

    let nextSkills: string[] = [];
    if (Array.isArray(body.skills)) {
      const raw = body.skills.filter((s): s is string => typeof s === "string");
      nextSkills = dedupeSkillsList(raw);
    } else if (typeof body.skills_text === "string") {
      nextSkills = parseCommaSeparatedSkills(body.skills_text);
    } else {
      return NextResponse.json(
        { error: "Provide `skills` (string[]) or `skills_text` (comma-separated string)." },
        { status: 400, headers: NO_STORE },
      );
    }

    const updated = await replaceParsedSkillsInStorage(nextSkills, model);
    if (!updated) {
      return NextResponse.json({ error: "No CV loaded for this profile." }, { status: 404, headers: NO_STORE });
    }

    const skills = updated.parsed.skills ?? [];
    return NextResponse.json(
      {
        loaded: true,
        uploaded_at: updated.uploaded_at,
        skills_count: skills.length,
        skills: skills.slice(0, 200),
        skill_suggestions: (updated.skill_suggestions ?? []).filter((r) => r.status === "suggested"),
      },
      { status: 200, headers: NO_STORE },
    );
  });
}
