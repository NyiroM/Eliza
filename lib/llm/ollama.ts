// Eliza Engine v0.3 - Model-specific tuning & Loop Protection

import { DEFAULT_OLLAMA_MODEL } from "../../config/constants";
import { CREATIVE_STRUCTURAL_NOISE_INSTRUCTION } from "../prompts/creative";
import { redactSensitiveData } from "../security/redactSensitiveData";

/** Single ceiling for every Ollama HTTP call from this module (generate + tags). */
export const OLLAMA_TIMEOUT = 300_000;

type OllamaGenerateResponse = {
  response?: unknown;
};

export type ParserSource = "llm" | "fallback";

export type OllamaJsonResult<T> = {
  data: T;
  source: ParserSource;
};

/** Who is calling: drives system prompt + sampling (strict analysis vs creative prose). */
export type JsonGenerateRole =
  | "analysis"
  | "extract_cv"
  | "creative_coach"
  | "creative_rewrite";

export type GenerateJsonOptions = {
  /** Ollama model name (must exist locally). Default: llama3 */
  model?: string;
  /**
   * analysis: strict sampling + auditor system; see `getOllamaOptions` for per-model overrides.
   * extract_cv: strict sampling, grounded system (cvParser).
   * creative_coach / creative_rewrite: Mirostat or top_p path; see `getOllamaOptions`.
   */
  role?: JsonGenerateRole;
  /**
   * When `role` is `analysis`, appended to the system prompt (e.g. user corrections file).
   */
  systemAppend?: string;
};

export class OllamaRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaRequestError";
  }
}

const isDevelopment = false;

const OLLAMA_JSON_ENGINE =
  "You are a JSON-only response engine. Do not include markdown blocks like ```json, and do not provide conversational text. Output ONLY the raw JSON object.";

const OLLAMA_CYNICAL_AUDITOR =
  "You operate as a ruthless, cynical auditor of evidence: treat every claim as guilty until the supplied text proves it. Anti-hallucination: never invent skills, employers, degrees, locations, salaries, or constraints. If evidence is thin, use null, empty arrays, \"unknown\", or conservative values—never fabricate to fill fields.";

/** Pipeline + job posting analysis / scoring */
const OLLAMA_ANALYSIS_SYSTEM = `${OLLAMA_JSON_ENGINE} ${OLLAMA_CYNICAL_AUDITOR}`;

/** CV structured extraction: strict grounding, no “auditor” tone */
const OLLAMA_EXTRACT_CV_SYSTEM = `${OLLAMA_JSON_ENGINE} Extract only information clearly grounded in the CV text; do not invent roles, dates, employers, or skills.`;

/** Cover letter: fluent, persuasive JSON output */
const OLLAMA_CREATIVE_COACH_SYSTEM = `${OLLAMA_JSON_ENGINE} You are a professional career coach: warm, persuasive, human-sounding prose in the requested JSON fields—still strictly valid JSON and faithful to the facts provided (no invented employers, titles, or credentials).`;

/** CV bullet rewrite */
const OLLAMA_CREATIVE_REWRITE_SYSTEM = `${OLLAMA_JSON_ENGINE} You are an expert CV editor: improve clarity and impact without inventing facts, metrics, or tools.`;

const CREATIVE_NUM_PREDICT = 4096;
/** Default strict generation budget before model-specific bumps. */
const STRICT_NUM_PREDICT_BASE = 1024;
/** DeepSeek-R1: long hidden reasoning before JSON — keep headroom for CoT + payload. */
const STRICT_NUM_PREDICT_DEEPSEEK_R1 = 12_288;
/** Any tag containing R1-style reasoning needs at least this much headroom. */
const STRICT_NUM_PREDICT_R1_MIN = 4096;

const NUM_CTX_GLOBAL = 16_384;
/** v0.3 Gemma-style loop mitigation: applied to every generate call after role-specific options. */
const GLOBAL_REPEAT_PENALTY = 1.2;

function isStrictRole(role: JsonGenerateRole): boolean {
  return role === "analysis" || role === "extract_cv";
}

function isDeepSeekR1Model(modelLower: string): boolean {
  return /deepseek/i.test(modelLower) && /\br1\b/i.test(modelLower);
}

function isReasoningR1Family(modelLower: string): boolean {
  if (isDeepSeekR1Model(modelLower)) return true;
  return /\br1\b/i.test(modelLower) || /[-_]r1(?:[:\-_]|$)/i.test(modelLower);
}

function isLlama31_8B(modelLower: string): boolean {
  return /llama3\.1/i.test(modelLower) && /8b/i.test(modelLower);
}

function isQwen25Family(modelLower: string): boolean {
  return /qwen2\.5|qwen-2\.5|qwen2_5/i.test(modelLower);
}

function isGemmaModel(modelLower: string): boolean {
  return /\bgemma\b/i.test(modelLower);
}

/** Models where Mirostat tends to behave poorly — fall back to top_p + temperature. */
function creativePrefersClassicSampling(modelLower: string): boolean {
  return /embed|embedding|rerank|clip|vl-|vision|mm-/i.test(modelLower);
}

function getOllamaSystemPrompt(role: JsonGenerateRole): string {
  switch (role) {
    case "creative_coach":
      return OLLAMA_CREATIVE_COACH_SYSTEM;
    case "creative_rewrite":
      return OLLAMA_CREATIVE_REWRITE_SYSTEM;
    case "extract_cv":
      return OLLAMA_EXTRACT_CV_SYSTEM;
    case "analysis":
    default:
      return OLLAMA_ANALYSIS_SYSTEM;
  }
}

/**
 * Builds the `options` object for Ollama `/api/generate`: hard-coded `num_ctx: 16384`, model/role tuning,
 * then global `repeat_penalty: 1.2` (Gemma loop fix). Strict roles use root-level `stop` via `getOllamaStopForRole`.
 */
export function getOllamaOptions(model: string, role: JsonGenerateRole): Record<string, unknown> {
  const m = model.trim().toLowerCase();
  const opts: Record<string, unknown> = {
    num_ctx: NUM_CTX_GLOBAL,
  };

  if (isStrictRole(role)) {
    opts.temperature = 0;
    if (role === "analysis" && isGemmaModel(m)) {
      opts.temperature = 0.1;
      opts.top_k = 30;
    }

    let num_predict = STRICT_NUM_PREDICT_BASE;
    if (isDeepSeekR1Model(m)) {
      num_predict = STRICT_NUM_PREDICT_DEEPSEEK_R1;
    } else if (isReasoningR1Family(m)) {
      num_predict = Math.max(num_predict, STRICT_NUM_PREDICT_R1_MIN);
    }
    opts.num_predict = num_predict;

    if (isLlama31_8B(m)) {
      opts.top_p = 0.1;
      opts.top_k = 20;
    } else if (isQwen25Family(m)) {
      opts.top_p = 0.05;
    }

    opts.repeat_penalty = GLOBAL_REPEAT_PENALTY;
    return opts;
  }

  if (!creativePrefersClassicSampling(m)) {
    opts.mirostat = 2;
    opts.mirostat_eta = 0.1;
    opts.mirostat_tau = 5.0;
    opts.temperature = 0;
  } else {
    opts.temperature = 0.7;
    opts.top_p = 0.9;
  }
  opts.num_predict = CREATIVE_NUM_PREDICT;
  opts.repeat_penalty = GLOBAL_REPEAT_PENALTY;
  return opts;
}

export function getOllamaStopForRole(role: JsonGenerateRole): string[] | undefined {
  return isStrictRole(role) ? ["\n}\n", "\n}\r\n"] : undefined;
}

/**
 * Strips DeepSeek-R1-style thinking blocks, then applies the "golden JSON" slice (first `{` through last `}`).
 * Exported for tests and any caller that post-processes Ollama text.
 */
export function cleanOllamaResponse(raw: string): string {
  let thinkingRemovedChars = 0;
  const withoutThinking = raw.replace(
    /<think>\s*[\s\S]*?<\/redacted_thinking>/gi,
    (block) => {
      thinkingRemovedChars += block.length;
      return "";
    },
  );
  if (thinkingRemovedChars > 0) {
    console.log(`[Backend] Thinking block removed: ${thinkingRemovedChars} characters.`);
  }
  const s = withoutThinking.trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return s;
  }
  return s.slice(start, end + 1).trim();
}

function parseOllamaJsonContent<T>(raw: string): { ok: true; data: T } | { ok: false; cleaned: string; message: string } {
  const cleaned = cleanOllamaResponse(raw);
  try {
    return { ok: true, data: JSON.parse(cleaned) as T };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, cleaned, message };
  }
}

function logUnparseableOllamaJson(raw: string, cleaned: string, message: string): void {
  console.error(
    "[Ollama Error] JSON.parse failed after cleanOllamaResponse (thinking stripped, golden {…} slice).",
    "Parse message:",
    redactSensitiveData(message),
  );
  if (isDevelopment) {
    console.error("[Ollama Debug] Raw model response length=%d", raw.length);
    console.error("[Ollama Debug] Cleaned candidate length=%d", cleaned.length);
  }
}

/** Ollama HTTP API base when env is unset or invalid (0.0.0.0 is not valid for client fetch). */
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_PORT = "11434";

/**
 * Normalizes OLLAMA_HOST: prepends http(s), replaces 0.0.0.0 with 127.0.0.1, adds :11434 if no port.
 * Returns a string suitable as base for `new URL(path, base)` (no trailing slash).
 */
function normalizeOllamaHostString(rawInput: string | undefined): string {
  let s = (rawInput ?? "").trim();
  if (!s) return DEFAULT_OLLAMA_BASE_URL;

  // Bind address is valid for servers but invalid / misleading for outbound fetch from this app.
  s = s.replace(/\b0\.0\.0\.0\b/g, "127.0.0.1");

  if (!/^https?:\/\//i.test(s)) {
    s = `http://${s}`;
  }

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    console.warn(`[Ollama] Invalid OLLAMA_HOST "${rawInput}", using ${DEFAULT_OLLAMA_BASE_URL}`);
    return DEFAULT_OLLAMA_BASE_URL;
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    console.warn(`[Ollama] Unsupported protocol in OLLAMA_HOST "${rawInput}", using ${DEFAULT_OLLAMA_BASE_URL}`);
    return DEFAULT_OLLAMA_BASE_URL;
  }

  // If no explicit port, assume Ollama default API port (http://host alone would otherwise be :80).
  if (u.port === "") {
    u.port = DEFAULT_OLLAMA_PORT;
  }

  return u.origin;
}

export function getOllamaBaseUrl(): string {
  return normalizeOllamaHostString(process.env.OLLAMA_HOST);
}

function ollamaApiUrl(path: string): string {
  const base = getOllamaBaseUrl();
  return new URL(path, `${base}/`).href;
}

function getOllamaGenerateUrl(): string {
  return ollamaApiUrl("/api/generate");
}

function isAbortError(err: unknown): boolean {
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") {
    return true;
  }
  return err instanceof Error && err.name === "AbortError";
}

function throwOllamaSlowTimeout(): never {
  const msg = `[Ollama Error] Model was too slow (timeout after ${OLLAMA_TIMEOUT}ms). Consider using a smaller model or checking GPU usage.`;
  console.error(msg);
  throw new OllamaRequestError(msg);
}

/** Surfaces ECONNREFUSED etc. instead of a bare "fetch failed" when possible. */
function describeNetworkFailure(url: string, err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = String((cause as { code?: unknown }).code ?? "");
    if (code === "ECONNREFUSED") {
      return `Connection refused (Ollama not listening at ${getOllamaBaseUrl()})`;
    }
    if (code === "ENOTFOUND") {
      return `Host not found for ${url}`;
    }
    if (code) return `${code}: ${err.message}`;
  }
  return err.message;
}

/**
 * Verifies that a model tag exists locally (GET /api/tags).
 * Throws OllamaRequestError if Ollama is unreachable or the model is not installed.
 */
export async function assertOllamaModelInstalled(modelTag: string): Promise<void> {
  const base = getOllamaBaseUrl();
  const tagsUrl = ollamaApiUrl("/api/tags");
  const requested = modelTag.trim().toLowerCase();
  if (!requested) {
    throw new OllamaRequestError("[Ollama Error] Model tag is empty.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);
  let response: Response;
  try {
    response = await fetch(tagsUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throwOllamaSlowTimeout();
    }
    const detail = describeNetworkFailure(tagsUrl, err);
    const msg = `[Ollama Error] Cannot reach Ollama at ${base} (GET /api/tags): ${detail}`;
    console.error(msg);
    throw new OllamaRequestError(msg);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const msg = `[Ollama Error] GET /api/tags HTTP ${response.status} ${response.statusText}: ${body.slice(0, 2000)}`;
    console.error(msg);
    throw new OllamaRequestError(msg);
  }

  const data = (await response.json()) as { models?: { name: string }[] };
  const names = (data.models ?? []).map((m) => m.name.toLowerCase());
  const baseName = requested.includes(":") ? requested.split(":")[0] : requested;

  const found = names.some(
    (n) =>
      n === requested ||
      n.startsWith(`${requested}:`) ||
      n.startsWith(`${baseName}:`) ||
      n.split(":")[0] === baseName,
  );

  if (!found) {
    const sample = names.slice(0, 24).join(", ") || "(none)";
    const msg = `[Ollama Error] Model "${modelTag}" not found in ollama list. Examples: ${sample}`;
    console.error(msg);
    throw new OllamaRequestError(msg);
  }
}

async function ollamaGenerateRaw(
  prompt: string,
  model: string,
  role?: JsonGenerateRole,
  systemAppend?: string,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);
  const url = getOllamaGenerateUrl();
  const r: JsonGenerateRole = role ?? "analysis";
  const resolvedOptions = getOllamaOptions(model, r);
  const stop = getOllamaStopForRole(r);
  let system = getOllamaSystemPrompt(r);
  if (r === "analysis" && systemAppend?.trim()) {
    system = `${system}\n\nUSER_CORRECTIONS_REGISTER (absolute truth — override any conflicting inference, skill tags, industry guesses, or prior model outputs):\n${systemAppend.trim()}`;
  }

  const requestBody: Record<string, unknown> = {
    model,
    stream: false,
    format: "json",
    system,
    options: resolvedOptions,
    prompt,
  };
  if (stop !== undefined) {
    requestBody.stop = stop;
  }

  try {
    console.log(`[Backend] Sending prompt to Ollama... (model=${model}, role=${r})`);
    console.log(
      "[Backend] Ollama resolved request:",
      JSON.stringify(
        {
          model,
          role: r,
          options: resolvedOptions,
          stop: stop ?? null,
        },
        null,
        2,
      ),
    );
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const msg = `[Ollama Error] HTTP ${response.status} ${response.statusText}: ${body.slice(0, 2000)}`;
      console.error(msg);
      throw new OllamaRequestError(msg);
    }

    const data = (await response.json()) as OllamaGenerateResponse;

    if (typeof data !== "object" || data === null || typeof data.response !== "string") {
      const msg =
        "[Ollama Error] Invalid Ollama response shape: expected JSON object with string field \"response\"";
      console.error(msg, data);
      throw new OllamaRequestError(msg);
    }

    const rawResponse = data.response;
    const tokenCount = Math.max(1, Math.ceil(rawResponse.length / 4));
    console.log(
      "[Backend] Ollama response received:",
      JSON.stringify({ model, tokenCount }),
    );
    if (isDevelopment) {
      console.log("[Ollama Debug] Raw response length=%d", rawResponse.length);
    }
    return rawResponse;
  } catch (err) {
    if (err instanceof OllamaRequestError) {
      throw err;
    }
    if (isAbortError(err)) {
      throwOllamaSlowTimeout();
    }
    const detail = describeNetworkFailure(url, err);
    const msg = `[Ollama Error] ${redactSensitiveData(detail)}`;
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    } else {
      console.error(msg);
    }
    throw new OllamaRequestError(msg);
  } finally {
    clearTimeout(timeout);
  }
}

/** Ollama must succeed and return valid JSON; otherwise throws OllamaRequestError (no silent fallback). */
export async function generateJsonWithOllamaStrict<T>(
  prompt: string,
  options?: GenerateJsonOptions,
): Promise<T> {
  const model = options?.model?.trim() || DEFAULT_OLLAMA_MODEL;
  const role = options?.role ?? "analysis";
  const raw = await ollamaGenerateRaw(prompt, model, role, options?.systemAppend);
  const parsed = parseOllamaJsonContent<T>(raw);
  if (parsed.ok) {
    return parsed.data;
  }
  logUnparseableOllamaJson(raw, parsed.cleaned, parsed.message);
  const hint =
    "Model returned non-JSON or malformed JSON after stripping <think> and taking the outermost {…} slice. " +
    "Try a JSON-tuned model, disable reasoning/thinking in the runner, or shorten the prompt.";
  throw new OllamaRequestError(
    `[Ollama Error] JSON parse failed after cleaning: ${parsed.message}. ${hint}`,
  );
}

export async function generateJsonWithOllama<T>(
  prompt: string,
  fallback: T,
  options?: GenerateJsonOptions,
): Promise<OllamaJsonResult<T>> {
  const model = options?.model?.trim() || DEFAULT_OLLAMA_MODEL;
  const role = options?.role ?? "analysis";
  try {
    const raw = await ollamaGenerateRaw(prompt, model, role, options?.systemAppend);
    const parsed = parseOllamaJsonContent<T>(raw);
    if (parsed.ok) {
      return { data: parsed.data, source: "llm" };
    }
    logUnparseableOllamaJson(raw, parsed.cleaned, parsed.message);
    console.error(
      "[Ollama Error] JSON parse failed after cleaning (soft fallback to caller-provided default).",
    );
    return { data: fallback, source: "fallback" };
  } catch (ollamaErr) {
    console.error(
      "[Ollama Error] Request failed (soft fallback):",
      ollamaErr instanceof Error ? ollamaErr.message : ollamaErr,
    );
    return { data: fallback, source: "fallback" };
  }
}
