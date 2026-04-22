import { NextRequest, NextResponse } from "next/server";
import { generateCoverLetter } from "../../../lib/generators/coverLetter";
import { generateCvRewriteSuggestionsFromText } from "../../../lib/generators/cvRewriter";
import { selectStrengthHighlights } from "../../../lib/pipeline";
import { loadStoredCvFromStorage } from "../../../lib/storage/userCv";
import { validateJobDescription, validateOllamaModelTag } from "../../../lib/validation";

type GenerateAssetsBody = {
  job_text?: unknown;
  cv_text?: unknown;
  model?: unknown;
  missing_skills?: unknown;
  required_skills?: unknown;
  strength_highlights?: unknown;
};

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function POST(request: NextRequest) {
  let body: GenerateAssetsBody;
  try {
    body = (await request.json()) as GenerateAssetsBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.job_text !== "string") {
    return NextResponse.json(
      { error: 'Body must include string field: "job_text".' },
      { status: 400 },
    );
  }

  const jobCheck = validateJobDescription(body.job_text);
  if (!jobCheck.ok) {
    return NextResponse.json({ error: jobCheck.error }, { status: 400 });
  }

  const rawModel =
    typeof body.model === "string" && body.model.trim().length > 0 ? body.model.trim() : "llama3";
  const modelCheck = validateOllamaModelTag(rawModel);
  if (!modelCheck.ok) {
    return NextResponse.json({ error: modelCheck.error }, { status: 400 });
  }
  const model = modelCheck.model;

  const stored = await loadStoredCvFromStorage();
  const cvFromBody = typeof body.cv_text === "string" ? body.cv_text.trim() : "";
  const cvText = cvFromBody || (stored?.raw_text ?? "").trim();
  if (!cvText) {
    return NextResponse.json(
      {
        error:
          "No CV text available. Upload a CV via the dashboard or include a non-empty \"cv_text\" field.",
      },
      { status: 400 },
    );
  }

  const missingSkills = asStringArray(body.missing_skills);
  const requiredSkills = asStringArray(body.required_skills);
  const highlightsFromBody = asStringArray(body.strength_highlights);
  const coreStories = stored?.parsed.core_stories ?? [];
  const strengthHighlights =
    highlightsFromBody.length > 0
      ? highlightsFromBody
      : selectStrengthHighlights(coreStories, requiredSkills);

  const [cvRewrite, coverLetter] = await Promise.all([
    generateCvRewriteSuggestionsFromText(cvText, missingSkills, model),
    generateCoverLetter({
      strength_highlights: strengthHighlights,
      core_stories: coreStories,
      required_skills: requiredSkills,
      job_text: jobCheck.job,
      model,
    }),
  ]);

  return NextResponse.json(
    {
      application_bundle: {
        cv_rewrite_suggestions: cvRewrite.rewritten_bullets,
        cover_letter: coverLetter.cover_letter,
      },
      debug: {
        generation_source:
          cvRewrite.generation_source === "llm" && coverLetter.generation_source === "llm"
            ? "llm"
            : "fallback",
        cv_rewrite_source: cvRewrite.generation_source,
        cover_letter_source: coverLetter.generation_source,
      },
    },
    { status: 200 },
  );
}
