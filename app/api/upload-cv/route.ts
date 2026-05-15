import { NextRequest, NextResponse } from "next/server";
import { withActiveUser } from "../../../lib/api/withActiveUser";
import { appendPendingSynonymSuggestions } from "../../../lib/storage/skillSynonyms";
import { suggestSkillSynonymPairsFromCv } from "../../../lib/skillSynonyms/suggestFromCv";
import {
  hasStoredCv,
  loadStoredCvFromStorage,
  parseAndStoreCvFromPdfBuffer,
} from "../../../lib/storage/userCv";
import { resolveOllamaModel } from "../../../lib/storage/resolveOllamaModel";
import { validateCvPdfUpload, validateOllamaModelTag } from "../../../lib/validation";

export async function GET(request: NextRequest) {
  return withActiveUser(request, async () => {
  const loaded = await hasStoredCv();
  if (!loaded) {
    return NextResponse.json({ loaded: false }, { status: 200 });
  }

  const stored = await loadStoredCvFromStorage();
  const skills = stored?.parsed.skills ?? [];
  const skill_suggestions = (stored?.skill_suggestions ?? []).filter((r) => r.status === "suggested");
  return NextResponse.json(
    {
      loaded: true,
      uploaded_at: stored?.uploaded_at ?? null,
      skills_count: skills.length,
      skills: skills.slice(0, 200),
      skill_suggestions,
    },
    { status: 200 },
  );
  });
}

export async function POST(request: NextRequest) {
  return withActiveUser(request, async () => {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data." }, { status: 400 });
  }

  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing PDF file." }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  const uploadCheck = validateCvPdfUpload(file, buffer.byteLength);
  if (!uploadCheck.ok) {
    return NextResponse.json({ error: uploadCheck.error }, { status: 400 });
  }

  const modelField = formData.get("model");
  const explicit = typeof modelField === "string" ? modelField.trim() : "";
  let model: string;
  if (explicit.length > 0) {
    const modelCheck = validateOllamaModelTag(explicit);
    if (!modelCheck.ok) {
      return NextResponse.json({ error: modelCheck.error }, { status: 400 });
    }
    model = modelCheck.model;
  } else {
    model = await resolveOllamaModel(undefined);
  }

  let stored;
  try {
    stored = await parseAndStoreCvFromPdfBuffer(buffer, model, file.name);
  } catch {
    return NextResponse.json(
      { error: "Could not parse PDF content. Please upload a valid CV PDF." },
      { status: 400 },
    );
  }

  let synonym_suggestions_added = 0;
  let synonym_suggestions_pending_total = 0;
  let synonym_llm_proposed: { from: string; to: string }[] = [];
  let synonym_llm_rationale: string | null = null;
  let synonym_suggestions_error = false;
  try {
    const suggested = await suggestSkillSynonymPairsFromCv({
      cvText: stored.raw_text,
      skills: stored.parsed.skills,
      model,
    });
    synonym_llm_proposed = suggested.pairs.map((p) => ({ from: p.from, to: p.to }));
    synonym_llm_rationale = suggested.rationale.length > 0 ? suggested.rationale : null;
    const merged = await appendPendingSynonymSuggestions(suggested.pairs);
    synonym_suggestions_added = merged.added;
    synonym_suggestions_pending_total = merged.pending_count;
  } catch (err) {
    synonym_suggestions_error = true;
    console.error("[upload-cv] skill synonym suggestions failed:", err);
  }

  return NextResponse.json(
    {
      loaded: true,
      uploaded_at: stored.uploaded_at,
      parsed: stored.parsed,
      synonym_suggestions_added,
      synonym_suggestions_pending_total,
      synonym_llm_proposed,
      synonym_llm_rationale,
      synonym_suggestions_error,
    },
    { status: 200 },
  );
  });
}
