// app/api/upload-cv/suggest-skills/route.ts — LLM extra skill phrases → pending suggestions (Discovery-style).
import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import { suggestExtraSkillsFromCv } from "../../../../lib/cvSkills/suggestExtraSkillsFromCv";
import {
  appendPendingCvSkillSuggestions,
  loadStoredCvFromStorage,
} from "../../../../lib/storage/userCv";
import { resolveOllamaModel } from "../../../../lib/storage/resolveOllamaModel";
import { validateOllamaModelTag } from "../../../../lib/validation";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type Body = { model?: unknown };

export async function POST(request: NextRequest) {
  return withActiveUser(request, async () => {
    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      body = {};
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

    const stored = await loadStoredCvFromStorage();
    if (!stored) {
      return NextResponse.json({ error: "No CV loaded for this profile." }, { status: 404, headers: NO_STORE });
    }

    const currentSkills = stored.parsed.skills ?? [];
    let rationale = "";
    let phrases: string[] = [];
    try {
      const out = await suggestExtraSkillsFromCv({
        cvText: stored.raw_text ?? "",
        currentSkills,
        model,
      });
      phrases = out.phrases;
      rationale = out.rationale;
    } catch (err) {
      console.error("[suggest-skills] LLM failed:", err);
      return NextResponse.json(
        { error: "Skill suggestion failed (Ollama unreachable, timeout, or invalid JSON)." },
        { status: 502, headers: NO_STORE },
      );
    }

    const { stored: merged, added } = await appendPendingCvSkillSuggestions(phrases, currentSkills);
    const skills = merged.parsed.skills ?? [];
    return NextResponse.json(
      {
        loaded: true,
        uploaded_at: merged.uploaded_at,
        skills_count: skills.length,
        skills: skills.slice(0, 200),
        skill_suggestions: (merged.skill_suggestions ?? []).filter((r) => r.status === "suggested"),
        suggest_rationale: rationale.length > 0 ? rationale : null,
        suggest_phrases_proposed: phrases,
        suggest_phrases_added: added,
      },
      { status: 200, headers: NO_STORE },
    );
  });
}
