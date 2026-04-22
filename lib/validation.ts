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
