import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseCvPdfBuffer, parseCvText, type CvParseResult } from "../parsers/cvParser";

const STORAGE_DIR = path.join(process.cwd(), "storage");
const USER_CV_PATH = path.join(STORAGE_DIR, "user_cv.json");

type StoredCvPayload = {
  raw_text: string;
  parsed: CvParseResult;
  uploaded_at: string;
  /** Original upload filename for cache logging (optional). */
  source_filename?: string | null;
};

export async function saveParsedCvToStorage(payload: StoredCvPayload): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
  await writeFile(USER_CV_PATH, JSON.stringify(payload, null, 2), "utf-8");
}

export async function loadStoredCvFromStorage(): Promise<StoredCvPayload | null> {
  try {
    const content = await readFile(USER_CV_PATH, "utf-8");
    return JSON.parse(content) as StoredCvPayload;
  } catch {
    return null;
  }
}

export async function parseAndStoreCvFromPdfBuffer(
  pdfBuffer: Buffer,
  ollamaModel = "llama3",
  sourceFilename?: string | null,
): Promise<StoredCvPayload> {
  const rawText = await parseCvPdfBuffer(pdfBuffer);
  const parsed = await parseCvText(rawText, ollamaModel);
  const payload: StoredCvPayload = {
    raw_text: rawText,
    parsed,
    uploaded_at: new Date().toISOString(),
    ...(sourceFilename != null && sourceFilename.trim()
      ? { source_filename: sourceFilename.trim() }
      : {}),
  };
  await saveParsedCvToStorage(payload);
  return payload;
}

export async function hasStoredCv(): Promise<boolean> {
  const data = await loadStoredCvFromStorage();
  return data !== null;
}
