/** Maximum job description length (characters) accepted by the API. */
export const JOB_DESCRIPTION_MAX_CHARS = 100_000;

/** Minimum non-whitespace length for a meaningful job posting. */
export const JOB_DESCRIPTION_MIN_CHARS = 20;

/** Maximum PDF upload size (bytes). */
export const CV_PDF_MAX_BYTES = 12 * 1024 * 1024;

const OLLAMA_MODEL_MAX_LEN = 128;
const OLLAMA_MODEL_PATTERN = /^[a-zA-Z0-9._:-]+$/;

export function validateJobDescription(raw: string): { ok: true; job: string } | { ok: false; error: string } {
  const job = typeof raw === "string" ? raw.trim() : "";
  if (job.length < JOB_DESCRIPTION_MIN_CHARS) {
    return {
      ok: false,
      error: `Job description must be at least ${JOB_DESCRIPTION_MIN_CHARS} characters after trimming.`,
    };
  }
  if (job.length > JOB_DESCRIPTION_MAX_CHARS) {
    return {
      ok: false,
      error: `Job description exceeds maximum length of ${JOB_DESCRIPTION_MAX_CHARS} characters.`,
    };
  }
  return { ok: true, job };
}

export function validateOllamaModelTag(raw: string): { ok: true; model: string } | { ok: false; error: string } {
  const model = raw.trim();
  if (!model) {
    return { ok: false, error: "Model tag cannot be empty." };
  }
  if (model.length > OLLAMA_MODEL_MAX_LEN) {
    return { ok: false, error: `Model tag must be at most ${OLLAMA_MODEL_MAX_LEN} characters.` };
  }
  if (!OLLAMA_MODEL_PATTERN.test(model)) {
    return {
      ok: false,
      error: "Model tag may only contain letters, digits, and . _ : - characters.",
    };
  }
  return { ok: true, model };
}

/** Max length for saved or request `preferred_location` (pipeline + preferences API). */
export const PREFERRED_LOCATION_MAX_CHARS = 500;

/**
 * Validates optional `preferred_location` on POST /api/pipeline.
 * Omitted → undefined (use saved preference). `null` or `""` → clear for this run.
 */
export function validatePreferredLocationField(
  raw: unknown,
):
  | { ok: true; preferred_location: string | undefined }
  | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, preferred_location: undefined };
  }
  if (raw === null) {
    return { ok: true, preferred_location: "" };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: 'Field "preferred_location" must be a string, null, or omitted.' };
  }
  const t = raw.trim();
  if (t.length > PREFERRED_LOCATION_MAX_CHARS) {
    return {
      ok: false,
      error: `preferred_location must be at most ${PREFERRED_LOCATION_MAX_CHARS} characters.`,
    };
  }
  return { ok: true, preferred_location: t };
}

/** For POST /api/user-preferences: `null` clears; non-empty string must fit max length. */
export function validatePreferredLocationForStorage(
  raw: unknown,
): { ok: true; preferred_location: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, preferred_location: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: 'Field "preferred_location" must be a string or null.' };
  }
  const t = raw.trim();
  if (t.length > PREFERRED_LOCATION_MAX_CHARS) {
    return {
      ok: false,
      error: `preferred_location must be at most ${PREFERRED_LOCATION_MAX_CHARS} characters.`,
    };
  }
  return { ok: true, preferred_location: t.length > 0 ? t : null };
}

export function validateCvPdfUpload(file: File, bufferByteLength: number): { ok: true } | { ok: false; error: string } {
  if (file.type !== "application/pdf") {
    return { ok: false, error: "Only PDF files are supported for CV upload." };
  }
  if (bufferByteLength > CV_PDF_MAX_BYTES) {
    return {
      ok: false,
      error: `PDF exceeds maximum size of ${Math.floor(CV_PDF_MAX_BYTES / (1024 * 1024))} MB.`,
    };
  }
  if (bufferByteLength === 0) {
    return { ok: false, error: "Uploaded file is empty." };
  }
  return { ok: true };
}
