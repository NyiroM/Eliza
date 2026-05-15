// Eliza Engine v0.3 - Model-specific tuning & Loop Protection

import { DEFAULT_OLLAMA_MODEL } from "../../config/constants";
import { extractCompleteJSON } from "./extractCompleteJSON";
import { isBackendLlmVerboseLog } from "../logging/backendLlmVerbose";
import { redactSensitiveData } from "../security/redactSensitiveData";

/** Single ceiling for every Ollama HTTP call from this module (generate + tags). */
export const OLLAMA_TIMEOUT = 300_000;

/** Safety ceiling for num_predict (unlimited is -1 in Ollama). */
export const OLLAMA_MAX_PREDICT = 8192;

/** Default context window for all Ollama calls. */
export const OLLAMA_NUM_CTX = 16384;

/** Semantic / job–CV analysis (`role: analysis`) — Cell_Robot_Flow_V2 benchmark winner. */
export const OLLAMA_SEMANTIC_TEMPERATURE = 0.1;
export const OLLAMA_SEMANTIC_TOP_K = 40;
export const OLLAMA_SEMANTIC_REPEAT_PENALTY = 1.15;

/** Strict structured extraction (`role: extract_cv`) — Cell_Robot_Stiff benchmark profile. */
export const OLLAMA_EXTRACT_TEMPERATURE = 0;
export const OLLAMA_EXTRACT_TOP_K = 1;
export const OLLAMA_EXTRACT_REPEAT_PENALTY = 1.1;

/** @deprecated Use OLLAMA_SEMANTIC_TEMPERATURE; kept as alias for callers. */
export const OLLAMA_DEFAULT_TEMPERATURE = OLLAMA_SEMANTIC_TEMPERATURE;

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
  /** Ollama model name (must exist locally). Default: app `DEFAULT_OLLAMA_MODEL` when omitted. */
  model?: string;
  /**
   * analysis: semantic scoring / fit review (benchmark Flow_V2 sampling).
   * extract_cv: stiff structured extraction (benchmark Stiff sampling).
   * creative_coach / creative_rewrite: human-facing prose JSON; factory sampling unless options override.
   */
  role?: JsonGenerateRole;
  /**
   * When `role` is `analysis`, appended to the system prompt (e.g. user corrections file).
   */
  systemAppend?: string;
  /**
   * Optional sampling overrides. Defaults depend on `role`:
   * - `analysis`: semantic match (T=0.1, top_k=40, repeat_penalty=1.15).
   * - `extract_cv`: stiff extraction (T=0, top_k=1, repeat_penalty=1.1).
   * - `creative_*`: only `num_ctx` / `num_predict` unless you set these explicitly (model “factory” sampling).
   */
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  num_predict?: number;
  /** Override default `OLLAMA_NUM_CTX` for `/api/generate` options. */
  num_ctx?: number;
  /**
   * Ollama `/api/generate` root `format`: `"json"` or a JSON Schema object (Ollama >= 0.1.30).
   * When omitted, defaults to `"json"` (callers that need schema must set this explicitly).
   */
  ollamaFormat?: "json" | Record<string, unknown>;
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
const OLLAMA_ANALYSIS_SYSTEM = `${OLLAMA_JSON_ENGINE} ${OLLAMA_CYNICAL_AUDITOR} Produce one valid JSON object; keep score_components and mathematical_breakdown internally consistent with fit_score.`;

/** CV structured extraction: strict grounding, no “auditor” tone */
const OLLAMA_EXTRACT_CV_SYSTEM = `${OLLAMA_JSON_ENGINE} Extract only information clearly grounded in the CV text; do not invent roles, dates, employers, or skills.`;

/** Creative Coach: interview prep with Cheat Sheet answers */
const OLLAMA_CREATIVE_COACH_SYSTEM = `${OLLAMA_JSON_ENGINE}
You are a professional career coach. Generate exactly 3 targeted interview questions based on the provided CRITICAL_GAPS and TRANSFERABLE_SKILLS. For each question, provide a concise Cheat Sheet answer leveraging the user's CV context. Keep questions concise and relevant to the job posting. Output strictly valid JSON with fields: questions: Array<{question: string, cheat_sheet: string}>. Do not invent skills or employers; use only provided CV context.`;

/** CV bullet rewrite */
const OLLAMA_CREATIVE_REWRITE_SYSTEM = `${OLLAMA_JSON_ENGINE} You are an expert CV editor: improve clarity and impact without inventing facts, metrics, or tools.`;

const NUM_CTX_GLOBAL = OLLAMA_NUM_CTX;

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
  return /\bgemma/i.test(modelLower);
}

export function getOllamaSystemPrompt(role: JsonGenerateRole): string {
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
 * Builds the `options` object for Ollama `/api/generate`: `num_ctx`, sampling.
 * JSON mode is set only at the request root as `format: "json"` (see `ollamaGenerateRaw`).
 */
export function getOllamaOptions(model: string, role: JsonGenerateRole, options?: GenerateJsonOptions): Record<string, unknown> {
  const num_ctx = options?.num_ctx ?? NUM_CTX_GLOBAL;
  const num_predict = options?.num_predict ?? OLLAMA_MAX_PREDICT;

  if (role === "creative_coach" || role === "creative_rewrite") {
    const opts: Record<string, unknown> = { num_ctx, num_predict };
    if (options?.temperature !== undefined) opts.temperature = options.temperature;
    if (options?.top_p !== undefined) opts.top_p = options.top_p;
    if (options?.top_k !== undefined) opts.top_k = options.top_k;
    if (options?.repeat_penalty !== undefined) opts.repeat_penalty = options.repeat_penalty;
    return opts;
  }

  if (role === "extract_cv") {
    const opts: Record<string, unknown> = {
      num_ctx,
      num_predict,
      temperature: options?.temperature ?? OLLAMA_EXTRACT_TEMPERATURE,
      top_k: options?.top_k ?? OLLAMA_EXTRACT_TOP_K,
      repeat_penalty: options?.repeat_penalty ?? OLLAMA_EXTRACT_REPEAT_PENALTY,
    };
    if (options?.top_p !== undefined) opts.top_p = options.top_p;
    return opts;
  }

  const opts: Record<string, unknown> = {
    num_ctx,
    num_predict,
    temperature: options?.temperature ?? OLLAMA_SEMANTIC_TEMPERATURE,
    top_k: options?.top_k ?? OLLAMA_SEMANTIC_TOP_K,
    repeat_penalty: options?.repeat_penalty ?? OLLAMA_SEMANTIC_REPEAT_PENALTY,
  };
  if (options?.top_p !== undefined) opts.top_p = options.top_p;
  return opts;
}

export function getOllamaStopForRole(role: JsonGenerateRole): string[] | undefined {
  return isStrictRole(role) ? ["\n}\n", "\n}\r\n"] : undefined;
}

/** JSON Schema for job–CV relevance scoring (Ollama `format` object). */
export const RELEVANCE_SCORE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    relevance_score: { type: "number", minimum: 0, maximum: 100 },
    decision: { type: "string", enum: ["YES", "NO", "MAYBE"] },
    reasoning_summary: { type: "string", maxLength: 500 },
  },
  required: ["relevance_score", "decision", "reasoning_summary"],
};

/** Schema-capable families for relevance tuning; others use `format: "json"`. */
export function getRelevanceScoreOllamaFormat(model: string): "json" | Record<string, unknown> {
  const m = model.toLowerCase();
  if (isLlama31_8B(m) || isGemmaModel(m) || isQwen25Family(m)) {
    return RELEVANCE_SCORE_JSON_SCHEMA;
  }
  return "json";
}

/**
 * JSON Schema for the semantic fit review payload (Ollama `format` object).
 * Property order matches the prompt's required output order; Ollama's structured-output
 * generation emits keys in this order, which keeps the model's reasoning aligned with
 * the prompt instructions (logic + veto before narrative).
 * Mirrors `parseSemanticFitReviewPayload` in `lib/pipeline.ts`.
 */
export const SEMANTIC_FIT_REVIEW_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    vetoed: { type: "boolean" },
    veto_reason: { type: ["string", "null"] },
    score_components: {
      type: "object",
      properties: {
        base_semantic: { type: "integer" },
        skill_overlap_delta: { type: "integer" },
        experience_delta: { type: "integer" },
        constraint_delta: { type: "integer" },
        advantage_bonus: { type: "integer", minimum: 0 },
      },
      required: [
        "base_semantic",
        "skill_overlap_delta",
        "experience_delta",
        "constraint_delta",
        "advantage_bonus",
      ],
    },
    fit_score: { type: "integer", minimum: 0, maximum: 100 },
    mathematical_breakdown: { type: "string" },
    one_sentence_summary: { type: "string", maxLength: 400 },
    narrative_summary: { type: "string" },
    matched_skills: { type: "array", items: { type: "string" } },
    missing_skills: { type: "array", items: { type: "string" } },
    irrelevant_extra_skills: { type: "array", items: { type: "string" } },
    interview_prep: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          cheat_sheet: { type: "string" },
        },
        required: ["question", "cheat_sheet"],
      },
    },
    seniority_match: { type: "boolean" },
    metadata_fit_badge: {
      type: ["string", "null"],
      enum: ["Location Conflict", "Preference Match", null],
    },
    vibe_warnings: { type: "array", items: { type: "string" } },
    semantic_highlights: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          phrase: { type: "string" },
          sentiment: { type: "string", enum: ["positive", "negative"] },
          reason: { type: "string" },
        },
        required: ["phrase", "sentiment", "reason"],
      },
    },
  },
  required: [
    "vetoed",
    "fit_score",
    "mathematical_breakdown",
    "one_sentence_summary",
    "matched_skills",
    "missing_skills",
    "seniority_match",
  ],
};

/**
 * Schema-capable families for the semantic fit review (same gating logic as
 * {@link getRelevanceScoreOllamaFormat}); other models fall back to `format: "json"`.
 * Constrained generation eliminates the mid-output JSON corruption Gemma e4b hit at
 * ~2300 chars on long postings.
 */
export function getSemanticFitReviewOllamaFormat(model: string): "json" | Record<string, unknown> {
  const m = model.toLowerCase();
  if (isLlama31_8B(m) || isGemmaModel(m) || isQwen25Family(m)) {
    return SEMANTIC_FIT_REVIEW_JSON_SCHEMA;
  }
  return "json";
}

/**
 * Strips reasoning blocks and markdown JSON fences, then extracts the first balanced `{`…`}`
 * JSON object (string-aware). Falls back to returning trimmed text if no balanced object exists.
 */
export function cleanOllamaResponse(raw: string): string {
  let strippedChars = 0;
  const countStrip = (re: RegExp, src: string): string =>
    src.replace(re, (block) => {
      strippedChars += block.length;
      return "";
    });

  const redactedThinkingTag = "redacted" + "_" + "thinking";
  let s = raw;
  s = countStrip(new RegExp(`<${redactedThinkingTag}>\\s*[\\s\\S]*?<\\/${redactedThinkingTag}>`, "gi"), s);
  const thinkTag = "th" + "ink";
  s = countStrip(new RegExp(`<${thinkTag}>\\s*[\\s\\S]*?<\\/${thinkTag}>`, "gi"), s);
  if (strippedChars > 0 && isBackendLlmVerboseLog()) {
    console.log(`[Backend] Reasoning/thinking blocks removed: ${strippedChars} characters.`);
  }

  s = s.trim();
  const fence = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i.exec(s);
  if (fence) {
    s = fence[1].trim();
  } else {
    s = s.replace(/^```(?:json)?\s*\r?\n?/i, "").replace(/\r?\n?```\s*$/i, "");
  }

  s = s.trim();
  const balanced = extractCompleteJSON(s);
  if (balanced !== null) {
    return balanced.trim();
  }
  return s;
}

/** DeepSeek-R1-style: append a "JSON output:" cue at the end of the user prompt. */
const REASONING_STRICT_JSON_TAIL = `

---
Return exactly one JSON object. Your next character must be {. End immediately after the final } with no trailing commentary or markdown fences.

JSON output:
`;

function maybeAppendReasoningJsonTail(prompt: string, model: string, role: JsonGenerateRole): string {
  if (!isReasoningR1Family(model.toLowerCase()) || !isStrictRole(role)) {
    return prompt;
  }
  return `${prompt.trimEnd()}${REASONING_STRICT_JSON_TAIL}`;
}

/** Exported for benchmarks: same tail cue as strict analysis calls for R1-style models. */
export function appendAnalysisReasoningJsonCue(prompt: string, model: string): string {
  return maybeAppendReasoningJsonTail(prompt, model, "analysis");
}

export function parseOllamaJsonContent<T>(raw: string): { ok: true; data: T } | { ok: false; cleaned: string; message: string } {
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
    "[Ollama Error] JSON.parse failed after cleanOllamaResponse (thinking blocks, markdown fences removed; balanced {...} extract).",
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
  options?: GenerateJsonOptions,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);
  const url = getOllamaGenerateUrl();
  const r: JsonGenerateRole = role ?? "analysis";
  const resolvedOptions = getOllamaOptions(model, r, options);
  const gbnf = process.env.OLLAMA_JSON_GBNF_GRAMMAR?.trim();
  if (gbnf) {
    (resolvedOptions as Record<string, unknown>).grammar = gbnf;
  }
  const stop = getOllamaStopForRole(r);
  let system = getOllamaSystemPrompt(r);
  if (r === "analysis" && systemAppend?.trim()) {
    system = `${system}\n\nUSER_CORRECTIONS_REGISTER (absolute truth — override any conflicting inference, skill tags, industry guesses, or prior model outputs):\n${systemAppend.trim()}`;
  }

  const promptForModel = maybeAppendReasoningJsonTail(prompt, model, r);

  const requestBody: Record<string, unknown> = {
    model,
    stream: false,
    format: options?.ollamaFormat ?? "json",
    system,
    options: resolvedOptions,
    prompt: promptForModel,
  };
  if (stop !== undefined) {
    requestBody.stop = stop;
  }

  try {
    if (isBackendLlmVerboseLog()) {
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
    }
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
    if (isBackendLlmVerboseLog()) {
      console.log(
        "[Backend] Ollama response received:",
        JSON.stringify({ model, tokenCount }),
      );
    }
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
  const raw = await ollamaGenerateRaw(prompt, model, role, options?.systemAppend, options);
  const parsed = parseOllamaJsonContent<T>(raw);
  if (parsed.ok) {
    return parsed.data;
  }
  logUnparseableOllamaJson(raw, parsed.cleaned, parsed.message);
  const hint =
    "Model returned non-JSON or malformed JSON after stripping reasoning blocks / markdown fences and balanced {...} extraction. " +
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
    const raw = await ollamaGenerateRaw(prompt, model, role, options?.systemAppend, options);
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
      ollamaErr instanceof Error ? redactSensitiveData(ollamaErr.message) : ollamaErr,
    );
    return { data: fallback, source: "fallback" };
  }
}
