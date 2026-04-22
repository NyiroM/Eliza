import { NextRequest, NextResponse } from "next/server";
import { runPipelineDetailed } from "../../../lib/pipeline";
import { addUserConstraint } from "../../../lib/storage/userConstraints";
import {
  validateJobDescription,
  validateOllamaModelTag,
  validatePreferredLocationField,
} from "../../../lib/validation";

type PipelineRequestBody = {
  job?: unknown;
  refine_feedback?: unknown;
  model?: unknown;
  preferred_location?: unknown;
};

export async function POST(request: NextRequest) {
  let body: PipelineRequestBody;

  try {
    body = (await request.json()) as PipelineRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  if (typeof body.job !== "string") {
    return NextResponse.json(
      {
        error: 'Body must include string field: "job".',
      },
      { status: 400 },
    );
  }

  const jobCheck = validateJobDescription(body.job);
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
  console.log(`[Backend] Starting analysis with model: ${model}`);

  const plocCheck = validatePreferredLocationField(body.preferred_location);
  if (!plocCheck.ok) {
    return NextResponse.json({ error: plocCheck.error }, { status: 400 });
  }
  const preferred_location = plocCheck.preferred_location;

  if (typeof body.refine_feedback === "string" && body.refine_feedback.trim()) {
    await addUserConstraint(body.refine_feedback);
  }

  let resultData;
  try {
    resultData = await runPipelineDetailed({
      job: jobCheck.job,
      model,
      ...(preferred_location !== undefined ? { preferred_location } : {}),
    });
    console.log(
      `[Backend] Pipeline completed. fit_score=${resultData.result.fit_score} analysis_model=${resultData.result.analysis_model}`,
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Pipeline failed due to missing CV data.",
      },
      { status: 400 },
    );
  }
  const { result } = resultData;

  return NextResponse.json(result, { status: 200 });
}
