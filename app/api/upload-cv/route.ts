import { NextRequest, NextResponse } from "next/server";
import {
  hasStoredCv,
  loadStoredCvFromStorage,
  parseAndStoreCvFromPdfBuffer,
} from "../../../lib/storage/userCv";
import { validateCvPdfUpload, validateOllamaModelTag } from "../../../lib/validation";

export async function GET() {
  const loaded = await hasStoredCv();
  if (!loaded) {
    return NextResponse.json({ loaded: false }, { status: 200 });
  }

  const stored = await loadStoredCvFromStorage();
  return NextResponse.json(
    {
      loaded: true,
      uploaded_at: stored?.uploaded_at ?? null,
      skills_count: stored?.parsed.skills.length ?? 0,
    },
    { status: 200 },
  );
}

export async function POST(request: NextRequest) {
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
  const rawModel =
    typeof modelField === "string" && modelField.trim().length > 0 ? modelField.trim() : "llama3";
  const modelCheck = validateOllamaModelTag(rawModel);
  if (!modelCheck.ok) {
    return NextResponse.json({ error: modelCheck.error }, { status: 400 });
  }
  const model = modelCheck.model;

  let stored;
  try {
    stored = await parseAndStoreCvFromPdfBuffer(buffer, model);
  } catch {
    return NextResponse.json(
      { error: "Could not parse PDF content. Please upload a valid CV PDF." },
      { status: 400 },
    );
  }

  return NextResponse.json(
    {
      loaded: true,
      uploaded_at: stored.uploaded_at,
      parsed: stored.parsed,
    },
    { status: 200 },
  );
}
