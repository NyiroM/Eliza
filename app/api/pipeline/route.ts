import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { assertOllamaModelInstalled, OllamaRequestError } from "../../../lib/llm/ollama";
import { runPipelineDetailed } from "../../../lib/pipeline";
import { addUserConstraint } from "../../../lib/storage/userConstraints";
import {
  validateJobDescription,
  validateOllamaModelTag,
  validatePreferredLocationField,
} from "../../../lib/validation";

/** Never statically cache this route; each POST must execute the full pipeline. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Allow long local Ollama runs (matches `OLLAMA_TIMEOUT` in lib/llm/ollama.ts). No separate route-level abort. */
export const maxDuration = 300;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
} as const;

function jsonNoStore(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

type PipelineRequestBody = {
  job?: unknown;
  refine_feedback?: unknown;
  model?: unknown;
  preferred_location?: unknown;
};

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  let body: PipelineRequestBody;

  try {
    body = (await request.json()) as PipelineRequestBody;
  } catch {
    return jsonNoStore({ error: "Invalid JSON body." }, 400);
  }

  if (typeof body.job !== "string") {
    return jsonNoStore(
      {
        error: 'Body must include string field: "job".',
      },
      400,
    );
  }

  const jobCheck = validateJobDescription(body.job);
  if (!jobCheck.ok) {
    return jsonNoStore({ error: jobCheck.error }, 400);
  }

  const rawModel =
    typeof body.model === "string" && body.model.trim().length > 0 ? body.model.trim() : "llama3";
  const modelCheck = validateOllamaModelTag(rawModel);
  if (!modelCheck.ok) {
    return jsonNoStore({ error: modelCheck.error }, 400);
  }
  const model = modelCheck.model;
  console.log(`[Backend] pipeline ${requestId} start model=${model}`);

  try {
    await assertOllamaModelInstalled(model);
  } catch (err) {
    const message =
      err instanceof OllamaRequestError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Ollama model check failed.";
    console.error(`[Backend] pipeline ${requestId} model check failed:`, message);
    return jsonNoStore({ error: message, request_id: requestId }, 500);
  }

  const plocCheck = validatePreferredLocationField(body.preferred_location);
  if (!plocCheck.ok) {
    return jsonNoStore({ error: plocCheck.error }, 400);
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
      `[Backend] pipeline ${requestId} done fit_score=${resultData.result.fit_score} analysis_model=${resultData.result.analysis_model}`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Pipeline failed due to an unexpected error.";
    console.error(`[Backend] pipeline ${requestId} failed (500):`, message);
    return jsonNoStore({ error: message, request_id: requestId }, 500);
  }
  const { result } = resultData;

  return jsonNoStore(result, 200);
}
