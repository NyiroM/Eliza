// app/api/upload-cv/skill-suggestions/route.ts — approve/reject pending AI skill phrases (bulk supported).
import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../../lib/api/withActiveUser";
import {
  approveAllPendingCvSkillSuggestions,
  approveCvSkillSuggestionPhrase,
  clearPendingCvSkillSuggestions,
  loadStoredCvFromStorage,
  rejectCvSkillSuggestionPhrase,
} from "../../../../lib/storage/userCv";
import { resolveOllamaModel } from "../../../../lib/storage/resolveOllamaModel";
import { validateOllamaModelTag } from "../../../../lib/validation";

const NO_STORE = { "Cache-Control": "no-store" } as const;

type Body = { phrase?: unknown; action?: unknown; model?: unknown };

function jsonMerged(merged: NonNullable<Awaited<ReturnType<typeof loadStoredCvFromStorage>>>) {
  const skills = merged.parsed.skills ?? [];
  return {
    ok: true,
    loaded: true,
    uploaded_at: merged.uploaded_at,
    skills_count: skills.length,
    skills: skills.slice(0, 200),
    skill_suggestions: (merged.skill_suggestions ?? []).filter((r) => r.status === "suggested"),
  };
}

export async function POST(request: NextRequest) {
  return withActiveUser(request, async () => {
    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400, headers: NO_STORE });
    }

    const phrase = typeof body.phrase === "string" ? body.phrase.trim() : "";
    const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";

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

    const before = await loadStoredCvFromStorage();
    if (!before) {
      return NextResponse.json({ error: "No CV loaded for this profile." }, { status: 404, headers: NO_STORE });
    }

    if (action === "approve_all_skill_phrases") {
      const merged = await approveAllPendingCvSkillSuggestions(model);
      if (!merged) {
        return NextResponse.json({ error: "No CV loaded for this profile." }, { status: 404, headers: NO_STORE });
      }
      return NextResponse.json({ ...jsonMerged(merged), action }, { status: 200, headers: NO_STORE });
    }

    if (action === "reject_all_skill_phrases") {
      const merged = await clearPendingCvSkillSuggestions();
      if (!merged) {
        return NextResponse.json({ error: "No CV loaded for this profile." }, { status: 404, headers: NO_STORE });
      }
      return NextResponse.json({ ...jsonMerged(merged), action }, { status: 200, headers: NO_STORE });
    }

    if (!phrase) {
      return NextResponse.json({ error: "Missing non-empty `phrase`." }, { status: 400, headers: NO_STORE });
    }
    if (action !== "approve" && action !== "reject") {
      return NextResponse.json(
        {
          error:
            "`action` must be \"approve\", \"reject\", \"approve_all_skill_phrases\", or \"reject_all_skill_phrases\".",
        },
        { status: 400, headers: NO_STORE },
      );
    }

    let merged = before;
    if (action === "approve") {
      const out = await approveCvSkillSuggestionPhrase(phrase, model);
      if (!out) {
        return NextResponse.json({ error: "No CV loaded for this profile." }, { status: 404, headers: NO_STORE });
      }
      if (!out.approved) {
        return NextResponse.json(
          { error: "Phrase not found in pending suggestions (or already in skills)." },
          { status: 404, headers: NO_STORE },
        );
      }
      merged = out.stored;
    } else {
      const next = await rejectCvSkillSuggestionPhrase(phrase);
      if (!next) {
        return NextResponse.json({ error: "No CV loaded for this profile." }, { status: 404, headers: NO_STORE });
      }
      merged = next;
    }

    return NextResponse.json({ ...jsonMerged(merged), action }, { status: 200, headers: NO_STORE });
  });
}
