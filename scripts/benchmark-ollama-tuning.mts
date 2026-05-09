// scripts/benchmark-ollama-tuning.mts
// Gemma 4 e4b: matrix Cell_Robot_Vibrant / Cell_Robot_Flow_V2 / Cell_Robot_Stiff — num_ctx 16384; 0.08–0.1 “heat” vs T=0 anchor.
// failed_responses.log: all matrix cells on parse=false or HTTP failure (full raw). Baseline failures → console.warn + raw_head only.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as cvParserNs from "../lib/parsers/cvParser";
import * as ollamaNs from "../lib/llm/ollama";
import * as extractNs from "../lib/llm/extractCompleteJSON";
import * as pipelineNs from "../lib/pipeline";
import * as stressEvalNs from "../lib/benchmark/stressEvalBundle";
import type { FitScoreResult } from "../types/scoring";

type OllamaModule = typeof import("../lib/llm/ollama");
type CvParserModule = typeof import("../lib/parsers/cvParser");
type ExtractModule = typeof import("../lib/llm/extractCompleteJSON");
type PipelineModule = typeof import("../lib/pipeline");
type StressEvalModule = typeof import("../lib/benchmark/stressEvalBundle");

function unwrapDefault<T>(ns: unknown): T {
  const n = ns as { default?: T };
  return (n.default ?? ns) as T;
}

const ollama = unwrapDefault<OllamaModule>(ollamaNs);
const cvParser = unwrapDefault<CvParserModule>(cvParserNs);
const extractMod = unwrapDefault<ExtractModule>(extractNs);
const pipeline = unwrapDefault<PipelineModule>(pipelineNs);
const stressEval = unwrapDefault<StressEvalModule>(stressEvalNs);
const { buildStressEvalBundle } = stressEval;

const {
  appendAnalysisReasoningJsonCue,
  getOllamaBaseUrl,
  getOllamaStopForRole,
  getOllamaSystemPrompt,
  parseOllamaJsonContent,
} = ollama;
const { parseSemanticFitReviewPayload } = pipeline;
const { parseCvPdfBuffer } = cvParser;
const { extractCompleteJSON } = extractMod;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const BASELINE_MODEL = "gemma4:e4b";
const CV_REL_PATH = path.join("storage", "TEST_CV_202604.pdf");
const OUTPUT_PATH = path.join(REPO_ROOT, "benchmarks", "tuning_results.json");
const FAILED_RAW_LOG = path.join(REPO_ROOT, "benchmarks", "failed_responses.log");
const CHARS_TO_INPUT_TOKENS = 0.3;
const SYSTEM_APPENDIX_CHARS_EST = 4500;
const LOW_ACCURACY_FIT_DELTA = 20;
const RAW_LOG_MAX_CHARS = 120_000;

/** Gemma 4 e4b — exact Ollama `options` on the wire (num_ctx fixed at 16k; not overridden by env for matrix). */
const PROTOCOL_NUM_CTX = 16_384;
const PROTOCOL_NUM_PREDICT = 2048;
const PROTOCOL_NUM_GPU = 99;

const BENCH_NUM_CTX = Number(process.env.BENCHMARK_NUM_CTX ?? PROTOCOL_NUM_CTX);
const BENCH_NUM_PREDICT = PROTOCOL_NUM_PREDICT;
const HEAVY_LATENCY_SKIP_MS = Number(process.env.BENCHMARK_HEAVY_LATENCY_SKIP_MS ?? 45_000);
const REASONING_DEPTH_RATIO_MIN = Number(process.env.BENCHMARK_REASONING_DEPTH_RATIO_MIN ?? 1.15);
const REASONING_DEPTH_VALUE_PENALTY = Number(process.env.BENCHMARK_REASONING_DEPTH_VALUE_PENALTY ?? 0.85);

const FULL_JOB_DESCRIPTION =`
  Company logo for, Nilfisk.

Nilfisk





IVS Sales Engineer



Szigetszentmiklós, Pest, Hungary · Reposted 9 hours ago · 20 people clicked apply



Promoted by hirer · Responses managed off LinkedIn



Full-time

Apply



Save

See how you compare to 20 others who clicked apply



Access exclusive applicant insights, see jobs where you have the highest chance of hearing back, and more.



Reactivate Premium: 50% Off



About the job

Do you want to become an expert in delivering tailored industrial solutions that truly make a difference?



As an IVS Sales Engineer at Nilfisk, you’ll be at the forefront of bridging technical innovation with customer challenges. Based in anywhere in Hungary, you’ll drive long-cycle, consultative sales and help customers across a range of industries implement cutting-edge vacuum and filtration solutions. You’ll travel will be an essential component of this role, including regular visits to our IVS Competence Center in Zocca, Italy.



At Nilfisk, we believe in developing talent for the long term. If you're selected, you'll embark on a continuous learning journey designed to make you a subject matter expert in industrial vacuum solutions.



Essential Responsibilities



Visit industrial sites to assess production environments and design the right vacuum/filtration setup

Own the sales lifecycle: from lead generation and site surveys to proposal development, negotiation, and closing

Provide technical consultancy in close partnership with our global IVS Competence Center and internal stakeholders

Oversee solution implementation, including training, site acceptance, and after-sales support

Manage customer relationships with operations and production managers, and occasionally purchasing

Ensure accurate CRM tracking and project reporting

Proactively support strategic growth of the IVS segment across your region



Your New Team



You’ll join a dynamic Specialty Business team focused on the IVS segment. The team includes technical consultants, business developers, and product experts based across Europe, with Zocca as our core knowledge hub. We collaborate across borders to create meaningful value for our customers.



“Here, no day is the same—and the trust you’re given lets you shape projects from day one,” shares a colleague from the IVS team in Italy.



Why Join Us



At Nilfisk, we know that amazing people make amazing companies. You will join a company culture with a lot of freedom and trust, and where we have a growth mindset. At Nilfisk, it’s OK to make mistakes, as long as you learn from them. Further, we want you to question ideas and speak your mind, so we can, together, find the best solutions. If you are ready for this, we would be keen to hear from you.



Qualifications To Succeed



You’ll thrive in this role if you bring a balance of commercial drive and technical curiosity. Perhaps you’ve previously worked with compressors, dust extractors, or other heavy-duty solutions in B2B environments. You’re confident communicating with engineers and translating complex specs into value-driven narratives.



Solid experience in industrial equipment sales or technical B2B consultancy

Previous experience in OEM, vacuum systems, dust extraction, or similar technology is a plus

Technical education (diploma or higher), or equivalent experience

Fluent in English and Hungarian

Skilled in CRM tools like Salesforce

Comfortable navigating long consultative sales cycles (6–12 months)

Willing and able to travel frequently across assigned region



Interested?



If this sounds like your next step, we encourage you to apply with an English CV.



Let’s create a cleaner future together



Cleaning has emerged as a key contributor to health and safety, sparked by technology and innovation. At Nilfisk we are a driving force in this development. Being part of Nilfisk means thinking outside of the box, bringing your inspiring ideas to life, sharing the results, and learning from your setbacks. We believe that diversity is our greatest strength – as we achieve the best results from a wide variety of views and approaches. At Nilfisk, you have the freedom to be yourself and express your opinions. Nilfisk is firmly committed to growth and sustainability in everything we do. You will be empowered in your role as you collaborate with passionate colleagues on a quest to create a cleaner future.



Are you ready to make a change for a cleaner future?



We embrace diversity and equality with an environment of inclusion. We encourage everyone to apply for the position, regardless of origin, race, ethnicity, religion, physical or mental ability, gender, gender-identity or expression, sexual orientation, and age.



Job applicant FAQ



Do you have questions regarding the recruitment process or alike? Please visit our FAQ for job applicants.`;

/** Only gemma4:e4b (BF16 tag as installed in Ollama). */
const MATRIX_MODELS = ["gemma4:e4b"] as const;

type MatrixCellId = "Cell_Robot_Vibrant" | "Cell_Robot_Flow_V2" | "Cell_Robot_Stiff";

type MatrixBenchCell = {
  cellId: MatrixCellId;
  description: string;
};

const MATRIX_CELLS: MatrixBenchCell[] = [
  {
    cellId: "Cell_Robot_Vibrant",
    description:
      "Cell_Robot_Vibrant: num_ctx=16384, num_predict=2048, num_gpu=99, temperature=0.08, top_k=20, repeat_penalty=1.15 (lower bound of expressive zone).",
  },
  {
    cellId: "Cell_Robot_Flow_V2",
    description:
      "Cell_Robot_Flow_V2: num_ctx=16384, num_predict=2048, num_gpu=99, temperature=0.1, top_k=40, repeat_penalty=1.15 (prior Flow T with stricter repeat for JSON).",
  },
  {
    cellId: "Cell_Robot_Stiff",
    description:
      "Cell_Robot_Stiff: num_ctx=16384, num_predict=2048, num_gpu=99, temperature=0, top_k=1, repeat_penalty=1.1 (T=0 anchor / baseline).",
  },
];

function ollamaOptionsForCellId(cellId: MatrixCellId): Record<string, unknown> {
  const base = {
    num_ctx: PROTOCOL_NUM_CTX,
    num_predict: PROTOCOL_NUM_PREDICT,
    num_gpu: PROTOCOL_NUM_GPU,
  };
  switch (cellId) {
    case "Cell_Robot_Vibrant":
      return { ...base, temperature: 0.08, top_k: 20, repeat_penalty: 1.15 };
    case "Cell_Robot_Flow_V2":
      return { ...base, temperature: 0.1, top_k: 40, repeat_penalty: 1.15 };
    case "Cell_Robot_Stiff":
      return { ...base, temperature: 0, top_k: 1, repeat_penalty: 1.1 };
    default: {
      const _x: never = cellId;
      throw new Error(`unknown cell ${_x}`);
    }
  }
}

/** Baseline runs use Cell_Robot_Stiff (T=0, top_k=1, repeat_penalty=1.1) as the strict JSON anchor. */
const BASELINE_OLLAMA_OPTIONS = ollamaOptionsForCellId("Cell_Robot_Stiff");

const BASELINE_RUNS = Number(process.env.BENCHMARK_BASELINE_RUNS ?? 5);
const MATRIX_RUNS_DEFAULT = Number(process.env.BENCHMARK_MATRIX_RUNS ?? 2);
const MATRIX_RUNS_BATTLE = Number(process.env.BENCHMARK_MATRIX_RUNS_HIGH ?? 3);
const MATRIX_RUNS_EXPERIMENTAL = Number(process.env.BENCHMARK_MATRIX_RUNS_LOW ?? 1);

const BATTLE_MODEL_TAGS = new Set<string>(["gemma4:e4b"]);

const EXPERIMENTAL_MODEL_TAGS = new Set<string>();

/** Only these skip remaining temperature configs when a cell is slower than HEAVY_LATENCY_SKIP_MS. */
const HEAVY_REFERENCE_SKIP_TAGS = new Set<string>();

/** Extra scoring discipline for this benchmark (aligns with user prompt; production uses semanticFitScoreReviewPrompt only). */
const BENCHMARK_SYSTEM_APPEND_SEMANTIC_RULES = `BENCHMARK_SEMANTIC_RULES (this run only):
- Use ONLY facts stated in the job posting text and the CV / evidence blocks supplied in the user message. Do not invent requirements, tools, industries, or skills that are not explicitly or clearly implied there.
- Penalize missing skills or experience ONLY when those items are stated as required or essential in the job expectations you were given. Do NOT subtract points for skills the posting does not ask for (including skills you might expect for the role title but that never appear in the supplied text).
- Follow LOGISTICS_AND_PHYSICAL_REQUIREMENTS (common-sense deduction) in the user message: implied mobility/logistics from prior roles satisfy the substance without verbatim keywords.`;

const BENCH_TIMEOUT_MS = Number(process.env.BENCHMARK_TIMEOUT_MS ?? 180_000);
const SLOWDOWN_MAX = 1.15;

function assertBalancedExtract(name: string, input: string, expected: string | null): void {
  const got = extractCompleteJSON(input);
  if (got !== expected) {
    throw new Error(`extractCompleteJSON sanity "${name}": want ${JSON.stringify(expected)} got ${JSON.stringify(got)}`);
  }
}

function sanityCheckExtractCompleteJSON(): void {
  assertBalancedExtract("nested", 'noise {"a":{"b":1}} tail', '{"a":{"b":1}}');
  assertBalancedExtract("brace in string", 'x {"k": "}" } z', '{"k": "}" }');
  assertBalancedExtract("no object", "no json here", null);
}

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Rough VRAM tier for value score (no runtime nvidia-smi); tune with BENCHMARK_VRAM_OVERRIDE if needed. */
function vramTierHeuristic(model: string): number {
  const m = model.toLowerCase();
  const env = process.env.BENCHMARK_VRAM_TIER_OVERRIDE?.trim();
  const parsed = env ? Number.parseFloat(env) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (/70b|72b|65b/.test(m)) return 4.5;
  if (/32b|34b|30b/.test(m)) return 3.2;
  if (/26b/.test(m)) return 3;
  if (/22b|24b/.test(m)) return 2.6;
  if (/14b|13b|16b|15b|12b/.test(m)) return 2;
  if (/9b|8b|7b|6b/.test(m)) return 1;
  if (/phi|nemo|hermes|mistral|gemma|llama|qwen|deepseek|coder/.test(m)) return 1.15;
  return 1.25;
}

function matrixRunsForModel(model: string): number {
  if (EXPERIMENTAL_MODEL_TAGS.has(model)) return MATRIX_RUNS_EXPERIMENTAL;
  if (BATTLE_MODEL_TAGS.has(model)) return MATRIX_RUNS_BATTLE;
  return MATRIX_RUNS_DEFAULT;
}

/** Length + keyword hits for “Reasoning density” vs R1 narrative (selectionNotes + 14B value penalty). */
function reasoningDepthMetrics(text: string): { charLen: number; keywordHits: number; composite: number } {
  const t = (text ?? "").trim();
  const re =
    /\b(because|due to|weight|therefore|however|consequently|although|specifically|overlap|constraint|semantic|evidence|skill|experience)\b/gi;
  const keywordHits = (t.match(re) ?? []).length;
  const charLen = t.length;
  const composite = charLen + keywordHits * 45;
  return { charLen, keywordHits, composite };
}

function isHeavyDepthPenaltyModel(model: string): boolean {
  return /14b|13b|16b|15b|12b/.test(model.toLowerCase());
}

function reportedTemperatureForCell(cellId: MatrixCellId): number {
  if (cellId === "Cell_Robot_Stiff") return 0;
  if (cellId === "Cell_Robot_Flow_V2") return 0.1;
  return 0.08;
}

/** Append full raw to failed_responses.log for any matrix cell on HTTP failure or strict parse failure. */
function shouldAppendMatrixFailureToLog(_cellId: MatrixCellId, httpOk: boolean, parseOk: boolean): boolean {
  if (!httpOk) return true;
  if (parseOk) return false;
  return true;
}

type CellResult = {
  model: string;
  matrix_cell_id: MatrixCellId;
  matrix_cell_description: string;
  ollama_options_used: Record<string, unknown>;
  num_ctx: number;
  num_predict: number;
  temperature: number;
  ollamaFormatKind: "json";
  wallMsRuns: number[];
  parseOkRuns: boolean[];
  medianMs: number;
  jsonSuccessRate: number;
  validStrict: boolean;
  sampleErrors: string[];
  fitScorePerRun: (number | null)[];
  relevance_score_median: number | null;
  reasoning_summary_sample: string;
  one_sentence_summary_sample: string;
  deltaFromBaselineR1Median: number | null;
  lowAccuracyVsR1: boolean;
  valueScore: number | null;
  valueScoreDepthAdjusted: number | null;
  reasoningDepthCell: { charLen: number; keywordHits: number; composite: number };
  reasoningDensityRatioVsR1: number | null;
  reasoningDepthPenaltyApplied: boolean;
  matrixRuns: number;
  vramTierUsed: number;
};

function estimateInputTokensRough(userPromptChars: number, correctionsChars: number): number {
  return (userPromptChars + correctionsChars + SYSTEM_APPENDIX_CHARS_EST) * CHARS_TO_INPUT_TOKENS;
}

function logContextWarningIfTight(numCtx: number, userPromptChars: number, correctionsChars: number, label: string): void {
  const inputTokEst = estimateInputTokensRough(userPromptChars, correctionsChars);
  const headroom = 2048;
  if (numCtx < inputTokEst + headroom) {
    console.warn(
      `[benchmark] Context warning (${label}): num_ctx=${numCtx} may be tight vs estimated input ~${Math.round(inputTokEst)} tok (chars×${CHARS_TO_INPUT_TOKENS} heuristic + ~${SYSTEM_APPENDIX_CHARS_EST} system est). Risk: prompt truncation / worse JSON.`,
    );
  }
}

async function appendFailedRawLog(entry: {
  iso: string;
  model: string;
  num_ctx: number;
  num_predict: number;
  temperature: number | null;
  matrix_cell_id?: MatrixCellId;
  reason: string;
  raw: string;
}): Promise<void> {
  const raw =
    entry.raw.length > RAW_LOG_MAX_CHARS
      ? `${entry.raw.slice(0, RAW_LOG_MAX_CHARS)}\n...[truncated ${entry.raw.length - RAW_LOG_MAX_CHARS} chars]`
      : entry.raw;
  const tempLabel = entry.temperature === null ? "n/a" : String(entry.temperature);
  const cellTag = entry.matrix_cell_id ? `matrix_cell=${entry.matrix_cell_id} ` : "";
  const block = `\n${"=".repeat(80)}\n${entry.iso} | ${cellTag}model=${entry.model} ctx=${entry.num_ctx} pred=${entry.num_predict} temp=${tempLabel}\nREASON: ${entry.reason}\nRAW:\n${raw}\n`;
  await mkdir(path.dirname(FAILED_RAW_LOG), { recursive: true });
  await appendFile(FAILED_RAW_LOG, block, "utf8");
}

async function fetchInstalledModelNames(): Promise<string[]> {
  const url = new URL("/api/tags", `${getOllamaBaseUrl()}/`).href;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
}

function isModelTagAvailable(requested: string, installed: string[]): boolean {
  const req = requested.trim().toLowerCase();
  return installed.some((n) => {
    const low = n.toLowerCase();
    if (low === req) return true;
    if (low.startsWith(`${req}:`)) return true;
    return false;
  });
}

/** Installed tag to pass to Ollama (exact name or first `requested:` variant). */
function resolveInstalledModelTag(requested: string, installed: string[]): string | null {
  const req = requested.trim().toLowerCase();
  for (const n of installed) {
    if (n.toLowerCase() === req) return n;
  }
  for (const n of installed) {
    const low = n.toLowerCase();
    if (low.startsWith(`${req}:`)) return n;
  }
  return null;
}

async function readCvText(): Promise<string> {
  const abs = path.join(REPO_ROOT, CV_REL_PATH);
  const buf = await readFile(abs);
  return parseCvPdfBuffer(buf);
}

async function ollamaGenerateBench(params: {
  model: string;
  /** Full Ollama \`/api/generate\` \`options\` object (num_ctx, num_predict, num_gpu, optional sampling). */
  ollamaOptions: Record<string, unknown>;
  ollamaFormat: "json" | Record<string, unknown>;
  userPrompt: string;
  /** Same contract as production \`generateJsonWithOllamaStrict(..., { systemAppend })\`. */
  systemAppend?: string;
}): Promise<{ wallMs: number; raw: string; httpOk: boolean; err?: string }> {
  const url = new URL("/api/generate", `${getOllamaBaseUrl()}/`).href;
  const role = "analysis" as const;
  let system = getOllamaSystemPrompt(role);
  system = `${system}\n\n${BENCHMARK_SYSTEM_APPEND_SEMANTIC_RULES}`;
  if (params.systemAppend?.trim()) {
    system = `${system}\n\nUSER_CORRECTIONS_REGISTER (absolute truth — override any conflicting inference, skill tags, industry guesses, or prior model outputs):\n${params.systemAppend.trim()}`;
  }
  const prompt = appendAnalysisReasoningJsonCue(params.userPrompt, params.model);
  const resolvedOptions = { ...params.ollamaOptions };
  const stop = getOllamaStopForRole(role);

  const body: Record<string, unknown> = {
    model: params.model,
    stream: false,
    format: params.ollamaFormat,
    system,
    options: resolvedOptions,
    prompt,
    keep_alive: 0,
  };
  if (stop !== undefined) body.stop = stop;

  const t0 = performance.now();
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), BENCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const wallMs = performance.now() - t0;
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { wallMs, raw: "", httpOk: false, err: `HTTP ${res.status} ${txt.slice(0, 500)}` };
    }
    const data = (await res.json()) as { response?: unknown };
    const raw = typeof data.response === "string" ? data.response : "";
    return { wallMs, raw, httpOk: true };
  } catch (e) {
    const wallMs = performance.now() - t0;
    const msg = e instanceof Error ? e.message : String(e);
    return { wallMs, raw: "", httpOk: false, err: msg };
  } finally {
    clearTimeout(to);
  }
}

type SemanticFitBenchParse =
  | {
      ok: true;
      /** Reconciled fit score (same field production uses for “relevance” in semantic review). */
      fitScore: number;
      /** Alias for tooling that expects \`relevance_score\`; identical to \`fitScore\` here. */
      relevanceScore: number;
      vetoed: boolean;
      narrativeSummary: string;
      oneSentenceSummary: string;
    }
  | { ok: false; message: string };

/**
 * Strict gate aligned with production semantic scorer: valid JSON + required shape, then \`parseSemanticFitReviewPayload\`.
 */
function strictParseSemanticFit(
  raw: string,
  baseline: FitScoreResult,
  offlineVeto: { vetoed: boolean; veto_reason: string | null },
): SemanticFitBenchParse {
  const parsed = parseOllamaJsonContent<Record<string, unknown>>(raw);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const o = parsed.data;
  if (typeof o.vetoed !== "boolean") return { ok: false, message: "missing boolean vetoed" };
  if (o.vetoed === true) {
    if (typeof o.veto_reason !== "string" || o.veto_reason.trim().length < 8) {
      return { ok: false, message: "vetoed=true but veto_reason missing/too short" };
    }
    const review = parseSemanticFitReviewPayload(o, baseline, offlineVeto);
    const fs = review.fit_score;
    return {
      ok: true,
      fitScore: fs,
      relevanceScore: fs,
      vetoed: true,
      narrativeSummary: (review.narrative_summary ?? "").slice(0, 8000),
      oneSentenceSummary: (review.one_sentence_summary ?? "").slice(0, 2000),
    };
  }
  const sc = o.score_components;
  if (!sc || typeof sc !== "object") return { ok: false, message: "missing score_components" };
  const scObj = sc as Record<string, unknown>;
  for (const k of [
    "base_semantic",
    "skill_overlap_delta",
    "experience_delta",
    "constraint_delta",
    "advantage_bonus",
  ] as const) {
    const v = scObj[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, message: `invalid score_components.${k}` };
  }
  if (typeof o.fit_score !== "number" || !Number.isFinite(o.fit_score)) return { ok: false, message: "invalid fit_score" };
  const review = parseSemanticFitReviewPayload(o, baseline, offlineVeto);
  const fs = review.fit_score;
  return {
    ok: true,
    fitScore: fs,
    relevanceScore: fs,
    vetoed: false,
    narrativeSummary: (review.narrative_summary ?? "").slice(0, 8000),
    oneSentenceSummary: (review.one_sentence_summary ?? "").slice(0, 2000),
  };
}

async function main(): Promise<void> {
  sanityCheckExtractCompleteJSON();

  let cvText: string;
  try {
    cvText = await readCvText();
  } catch {
    console.error(`Missing or unreadable CV PDF at ${path.join(REPO_ROOT, CV_REL_PATH)}`);
    process.exit(1);
  }
  if (!cvText.trim()) {
    console.error("CV text extraction produced empty string.");
    process.exit(1);
  }

  const stress = buildStressEvalBundle(cvText, { scrapedJobListing: FULL_JOB_DESCRIPTION });
  const { userPrompt, correctionsBlock, baseline, offlineVeto, promptCharCount } = stress;

  const installed = await fetchInstalledModelNames();
  if (!isModelTagAvailable(BASELINE_MODEL, installed)) {
    console.error(`Baseline model not found in ollama list: ${BASELINE_MODEL}`);
    process.exit(1);
  }

  const modelsToRun = MATRIX_MODELS.filter((m) => isModelTagAvailable(m, installed));
  const skippedModels = MATRIX_MODELS.filter((m) => !modelsToRun.includes(m));
  if (skippedModels.length) {
    console.warn("Skipping models not in `ollama list`:", skippedModels.join(", "));
  }
  if (modelsToRun.length === 0) {
    console.error("This benchmark requires gemma4:e4b in `ollama list`.");
    process.exit(1);
  }
  const matrixModel = resolveInstalledModelTag("gemma4:e4b", installed)!;

  const productionJsonFormat = "json" as const;
  const baselineNumCtx = Number(BASELINE_OLLAMA_OPTIONS.num_ctx ?? BENCH_NUM_CTX);
  const baselineNumPredict = Number(BASELINE_OLLAMA_OPTIONS.num_predict ?? BENCH_NUM_PREDICT);
  const baselineTempReported = reportedTemperatureForCell("Cell_Robot_Stiff");

  console.log(
    `Stress prompt chars=${promptCharCount} (semantic fit + USER_CORRECTIONS + evidence appendix). Warm-up (discarded):`,
    matrixModel,
    `(baseline = Cell_Robot_Stiff options, num_ctx=${baselineNumCtx})`,
  );
  const baselineDiscardedWarm = await ollamaGenerateBench({
    model: matrixModel,
    ollamaOptions: { ...BASELINE_OLLAMA_OPTIONS },
    ollamaFormat: productionJsonFormat,
    userPrompt,
    systemAppend: correctionsBlock,
  });
  {
    const wpr = strictParseSemanticFit(baselineDiscardedWarm.raw, baseline, offlineVeto);
    if (baselineDiscardedWarm.httpOk && !wpr.ok) {
      const rw = baselineDiscardedWarm.raw;
      console.warn(
        `[benchmark] baseline_discarded_warmup | parse=false | ${wpr.message} (Cell_Robot_Stiff options; not written to ${path.basename(FAILED_RAW_LOG)} per protocol).`,
      );
      if (rw.length > 0) {
        console.warn(`raw_head (${Math.min(800, rw.length)} chars):\n${rw.slice(0, 800)}${rw.length > 800 ? "…" : ""}`);
      }
    } else if (!baselineDiscardedWarm.httpOk) {
      console.warn(
        `[benchmark] baseline_discarded_warmup | http_failed | ${baselineDiscardedWarm.err ?? "?"} (not written to ${path.basename(FAILED_RAW_LOG)} per protocol).`,
      );
    }
  }

  logContextWarningIfTight(baselineNumCtx, promptCharCount, correctionsBlock.length, "baseline");

  const baselineLatencies: number[] = [];
  const baselineParseOk: boolean[] = [];
  const baselineFitScores: (number | null)[] = [];
  let baselineReasoningSample = "";
  console.log(
    `Baseline ${matrixModel} (${BASELINE_RUNS} runs, Cell_Robot_Stiff options; num_ctx=${baselineNumCtx} num_predict=${baselineNumPredict})...`,
  );
  for (let i = 0; i < BASELINE_RUNS; i++) {
    const r = await ollamaGenerateBench({
      model: matrixModel,
      ollamaOptions: { ...BASELINE_OLLAMA_OPTIONS },
      ollamaFormat: productionJsonFormat,
      userPrompt,
      systemAppend: correctionsBlock,
    });
    baselineLatencies.push(r.wallMs);
    const pr = strictParseSemanticFit(r.raw, baseline, offlineVeto);
    const p = r.httpOk && pr.ok;
    baselineParseOk.push(p);
    if (!r.httpOk) {
      console.warn(
        `[benchmark] baseline_run ${i + 1} | http_failed | ${r.err ?? "?"} (not written to ${path.basename(FAILED_RAW_LOG)} per protocol).`,
      );
    } else if (!pr.ok) {
      console.warn(
        `[benchmark] baseline_run ${i + 1} | parse=false | ${pr.message} (not written to ${path.basename(FAILED_RAW_LOG)} per protocol).`,
      );
      if (r.raw.length > 0) {
        console.warn(`raw_head (${Math.min(800, r.raw.length)} chars):\n${r.raw.slice(0, 800)}${r.raw.length > 800 ? "…" : ""}`);
      }
    }
    baselineFitScores.push(pr.ok ? pr.relevanceScore : null);
    if (pr.ok) baselineReasoningSample = pr.narrativeSummary.slice(0, 8000);
    const fsNote = pr.ok ? ` fit=${pr.relevanceScore}` : "";
    console.log(`  run ${i + 1}: ${Math.round(r.wallMs)}ms parse=${p}${fsNote}`);
  }

  const baselineMedian = median(baselineLatencies.filter((_, idx) => baselineParseOk[idx]));
  const baselineMedianAllRuns = median(baselineLatencies);
  const baselineR1MedianFit = median(
    baselineFitScores.filter((x): x is number => x !== null && Number.isFinite(x)),
  ); // NaN if no successful baseline parses

  const matrixResults: CellResult[] = [];
  const baselineReasoningDepthMetrics = reasoningDepthMetrics(baselineReasoningSample);

  console.log(`\nMatrix warm-up (discarded, Cell_Robot_Stiff): ${matrixModel}`);
  const matrixWarmOpts = { ...ollamaOptionsForCellId("Cell_Robot_Stiff") };
  const matrixDiscardedWarm = await ollamaGenerateBench({
    model: matrixModel,
    ollamaOptions: matrixWarmOpts,
    ollamaFormat: productionJsonFormat,
    userPrompt,
    systemAppend: correctionsBlock,
  });
  {
    const mwpr = strictParseSemanticFit(matrixDiscardedWarm.raw, baseline, offlineVeto);
    if (matrixDiscardedWarm.httpOk && !mwpr.ok) {
      const rw = matrixDiscardedWarm.raw;
      console.warn(
        `[benchmark] matrix_discarded_warmup Cell_Robot_Stiff | parse=false | ${mwpr.message} (not written to ${path.basename(FAILED_RAW_LOG)} per protocol).`,
      );
      if (rw.length > 0) {
        console.warn(`raw_head (${Math.min(800, rw.length)} chars):\n${rw.slice(0, 800)}${rw.length > 800 ? "…" : ""}`);
      }
    } else if (!matrixDiscardedWarm.httpOk) {
      console.warn(
        `[benchmark] matrix_discarded_warmup Cell_Robot_Stiff | http_failed | ${matrixDiscardedWarm.err ?? "?"} (not written to ${path.basename(FAILED_RAW_LOG)} per protocol).`,
      );
    }
  }

  for (const cellDef of MATRIX_CELLS) {
    const ollamaOpts = { ...ollamaOptionsForCellId(cellDef.cellId) };
    const cellNumCtx = Number(ollamaOpts.num_ctx ?? BENCH_NUM_CTX);
    logContextWarningIfTight(cellNumCtx, promptCharCount, correctionsBlock.length, `${matrixModel} ${cellDef.cellId}`);

    const runs = matrixRunsForModel(matrixModel);
    const wallMsRuns: number[] = [];
    const parseOkRuns: boolean[] = [];
    const sampleErrors: string[] = [];
    const fitScorePerRun: (number | null)[] = [];
    let reasoningSample = "";
    let oneSentenceSample = "";
    const tempReported = reportedTemperatureForCell(cellDef.cellId);

    for (let r = 0; r < runs; r++) {
      const out = await ollamaGenerateBench({
        model: matrixModel,
        ollamaOptions: ollamaOpts,
        ollamaFormat: productionJsonFormat,
        userPrompt,
        systemAppend: correctionsBlock,
      });
      wallMsRuns.push(out.wallMs);
      const pr = strictParseSemanticFit(out.raw, baseline, offlineVeto);
      const ok = out.httpOk && pr.ok;
      parseOkRuns.push(ok);
      fitScorePerRun.push(pr.ok ? pr.relevanceScore : null);
      if (pr.ok) {
        reasoningSample = pr.narrativeSummary.slice(0, 6000);
        oneSentenceSample = pr.oneSentenceSummary.slice(0, 1500);
      }
      if (!ok) {
        const baseReason = !out.httpOk
          ? `http_failed | ${out.err ?? "unknown"}`
          : pr.ok
            ? "unexpected"
            : `json_parse_error | ${pr.message}`;
        if (shouldAppendMatrixFailureToLog(cellDef.cellId, out.httpOk, pr.ok)) {
          await appendFailedRawLog({
            iso: new Date().toISOString(),
            model: matrixModel,
            num_ctx: cellNumCtx,
            num_predict: PROTOCOL_NUM_PREDICT,
            temperature: tempReported,
            matrix_cell_id: cellDef.cellId,
            reason: `${cellDef.cellId} | ${baseReason}`,
            raw: out.raw ?? "",
          });
        }
      }
      if (!ok && sampleErrors.length < 2) {
        sampleErrors.push(!out.httpOk && out.err ? out.err : out.httpOk ? (pr.ok ? "ok" : pr.message) : "http failed");
      }
      const errHint = !ok && out.err ? ` err=${out.err.slice(0, 120)}` : "";
      const fitHint = pr.ok ? ` fit=${pr.relevanceScore}` : "";
      const lowHint =
        pr.ok && Number.isFinite(baselineR1MedianFit)
          ? Math.abs(pr.relevanceScore - baselineR1MedianFit) > LOW_ACCURACY_FIT_DELTA
            ? " LOW_ACC"
            : ""
          : "";
      const rp = ollamaOpts.repeat_penalty;
      const rpHint = typeof rp === "number" ? ` repeat_penalty=${rp}` : "";
      console.log(
        `  ${cellDef.cellId} ctx=${cellNumCtx} pred=${PROTOCOL_NUM_PREDICT} temp=${tempReported}${rpHint} run ${r + 1}/${runs}: ${Math.round(out.wallMs)}ms parse=${ok}${fitHint}${lowHint}${errHint}`,
      );
    }

    const okCount = parseOkRuns.filter(Boolean).length;
    const jsonSuccessRate = okCount / runs;
    const validStrict = okCount === runs;
    const medianMs = median(wallMsRuns.filter((_, i) => parseOkRuns[i])) || median(wallMsRuns);

    const numericFits = fitScorePerRun.filter((x): x is number => x !== null && Number.isFinite(x));
    const relevanceMedian = numericFits.length ? median(numericFits) : null;
    const deltaFromR1 =
      relevanceMedian !== null && Number.isFinite(baselineR1MedianFit)
        ? relevanceMedian - baselineR1MedianFit
        : null;
    const lowAccuracyVsR1 = deltaFromR1 !== null && Math.abs(deltaFromR1) > LOW_ACCURACY_FIT_DELTA;
    const vramTierUsed = vramTierHeuristic(matrixModel);
    const latSec = Number.isFinite(medianMs) && medianMs > 0 ? medianMs / 1000 : NaN;
    let valueScore: number | null = null;
    if (
      relevanceMedian !== null &&
      Number.isFinite(baselineR1MedianFit) &&
      Number.isFinite(latSec) &&
      latSec > 0 &&
      vramTierUsed > 0
    ) {
      const accuracy = Math.max(1, 100 - Math.abs(relevanceMedian - baselineR1MedianFit));
      valueScore = accuracy / (latSec * vramTierUsed);
    }

    const cellDepth = reasoningDepthMetrics(reasoningSample);
    const reasoningDensityRatioVsR1 =
      baselineReasoningDepthMetrics.composite > 0
        ? cellDepth.composite / baselineReasoningDepthMetrics.composite
        : null;
    let reasoningDepthPenaltyApplied = false;
    let valueScoreDepthAdjusted: number | null = valueScore;
    if (
      valueScore !== null &&
      Number.isFinite(valueScore) &&
      isHeavyDepthPenaltyModel(matrixModel) &&
      validStrict &&
      baselineReasoningDepthMetrics.composite > 0 &&
      cellDepth.composite / baselineReasoningDepthMetrics.composite < REASONING_DEPTH_RATIO_MIN
    ) {
      valueScoreDepthAdjusted = valueScore * REASONING_DEPTH_VALUE_PENALTY;
      reasoningDepthPenaltyApplied = true;
    }

    matrixResults.push({
      model: matrixModel,
      matrix_cell_id: cellDef.cellId,
      matrix_cell_description: cellDef.description,
      ollama_options_used: { ...ollamaOpts },
      num_ctx: cellNumCtx,
      num_predict: PROTOCOL_NUM_PREDICT,
      temperature: tempReported,
      ollamaFormatKind: "json",
      wallMsRuns,
      parseOkRuns,
      medianMs,
      jsonSuccessRate,
      validStrict,
      sampleErrors,
      fitScorePerRun,
      relevance_score_median: relevanceMedian,
      reasoning_summary_sample: reasoningSample,
      one_sentence_summary_sample: oneSentenceSample,
      deltaFromBaselineR1Median: deltaFromR1,
      lowAccuracyVsR1,
      valueScore,
      valueScoreDepthAdjusted,
      reasoningDepthCell: cellDepth,
      reasoningDensityRatioVsR1,
      reasoningDepthPenaltyApplied,
      matrixRuns: runs,
      vramTierUsed,
    });

    if (HEAVY_REFERENCE_SKIP_TAGS.has(matrixModel) && wallMsRuns.length > 0) {
      const maxWall = Math.max(...wallMsRuns);
      if (maxWall > HEAVY_LATENCY_SKIP_MS || medianMs > HEAVY_LATENCY_SKIP_MS) {
        console.warn(
          `[benchmark] Heavy reference ${matrixModel}: median=${Math.round(medianMs)}ms maxRun=${Math.round(maxWall)}ms > ${HEAVY_LATENCY_SKIP_MS}ms — skipping remaining matrix cells.`,
        );
        break;
      }
    }
  }

  const baselineForCompare = Number.isFinite(baselineMedian) ? baselineMedian : baselineMedianAllRuns;
  const ceiling = baselineForCompare * SLOWDOWN_MAX;

  const candidates = matrixResults.filter((c) => c.validStrict && Number.isFinite(c.medianMs) && c.medianMs <= ceiling);
  const sorted = [...candidates].sort((a, b) => a.medianMs - b.medianMs);
  const champion = sorted[0] ?? null;

  const valueCandidates = matrixResults.filter(
    (c) => c.validStrict && c.valueScoreDepthAdjusted !== null && Number.isFinite(c.valueScoreDepthAdjusted),
  );
  const championByValue =
    [...valueCandidates].sort((a, b) => (b.valueScoreDepthAdjusted ?? 0) - (a.valueScoreDepthAdjusted ?? 0))[0] ?? null;

  const payload = {
    generatedAt: new Date().toISOString(),
    benchmarkMode: "gemma4_e4b_heat_expansion",
    stressPromptCharCount: promptCharCount,
    jobDescription: FULL_JOB_DESCRIPTION,
    cvPath: path.join(REPO_ROOT, CV_REL_PATH),
    vramCleanup: "keep_alive:0 on each /api/generate (single-model gemma4:e4b run; no ollama stop between cells).",
    skippedModels,
    benchParams: {
      matrixModels: [...MATRIX_MODELS],
      protocol: {
        num_ctx: PROTOCOL_NUM_CTX,
        num_predict: PROTOCOL_NUM_PREDICT,
        num_gpu: PROTOCOL_NUM_GPU,
      },
      num_ctx: PROTOCOL_NUM_CTX,
      num_predict: PROTOCOL_NUM_PREDICT,
      num_gpu: PROTOCOL_NUM_GPU,
      matrixCells: MATRIX_CELLS.map((c) => ({
        cell_id: c.cellId,
        description: c.description,
        ollama_options: ollamaOptionsForCellId(c.cellId),
      })),
      matrixRunsPolicy: {
        battleModels: [...BATTLE_MODEL_TAGS],
        runsBattle: MATRIX_RUNS_BATTLE,
        experimentalModels: [...EXPERIMENTAL_MODEL_TAGS],
        runsExperimental: MATRIX_RUNS_EXPERIMENTAL,
        runsDefault: MATRIX_RUNS_DEFAULT,
      },
      heavyLatencySkipMs: HEAVY_LATENCY_SKIP_MS,
      heavyModelsSkipRemainingConfigs: [...HEAVY_REFERENCE_SKIP_TAGS],
    },
    baseline: {
      model: matrixModel,
      baseline_cell: "Cell_Robot_Stiff",
      ollama_options: { ...BASELINE_OLLAMA_OPTIONS },
      num_ctx: baselineNumCtx,
      num_predict: baselineNumPredict,
      num_gpu: PROTOCOL_NUM_GPU,
      temperature: baselineTempReported,
      format: "json",
      runs: BASELINE_RUNS,
      latenciesMs: baselineLatencies,
      parseOkPerRun: baselineParseOk,
      fitScorePerRun: baselineFitScores,
      /** Median reconciled \`fit_score\` from baseline (Cell_Robot_Stiff options; reference for delta / lowAccuracy / valueScore). */
      baselineFitScoreMedianR1: Number.isFinite(baselineR1MedianFit) ? baselineR1MedianFit : null,
      baselineReasoningDepthMetrics,
      medianMs: baselineForCompare,
      ceilingMs15Pct: ceiling,
    },
    matrix: matrixResults,
    champion,
    championByValue,
    selectionNotes: {
      matrixDesign:
        "Heat expansion (tuning_results_4: T≤0.05 matched T=0): Cell_Robot_Vibrant (T=0.08, top_k=20, repeat_penalty=1.15), Cell_Robot_Flow_V2 (T=0.1, top_k=40, repeat_penalty=1.15), Cell_Robot_Stiff (T=0, top_k=1, repeat_penalty=1.1, baseline anchor). All num_ctx=16384. Hunt the threshold where narrative becomes more vibrant vs T=0 without breaking strict JSON — watch fit_score drift, reasoningDensityRatioVsR1, and parseOkRuns vs Stiff.",
      ruleLatency:
        "Among matrix cells, 100% strict JSON + semantic-fit shape on all runs, median wall ms <= baseline median * 1.15; pick lowest median.",
      ruleValueScore:
        "valueScore = max(1, 100 - abs(relevance_score_median - baselineFitScoreMedianR1)) / ((medianMs/1000) * vramTierUsed); vramTier is a name heuristic unless BENCHMARK_VRAM_TIER_OVERRIDE is set. championByValue uses valueScoreDepthAdjusted (see reasoningDensity).",
      reasoningDensity:
        "Cell narrative (reasoning_summary_sample) is scored as composite = charLen + 45 * keywordHits. reasoningDensityRatioVsR1 = cellComposite / baselineReasoningDepthMetrics.composite (last good baseline run). For 14B-class tags only: shallow reasoning penalty may apply per env thresholds.",
      lowAccuracyRule: `lowAccuracyVsR1 when |relevance_score_median - baselineFitScoreMedianR1| > ${LOW_ACCURACY_FIT_DELTA} (JSON can still be valid).`,
      failedRawLog: FAILED_RAW_LOG,
      failedRawLogReasonPrefixes:
        "Any matrix cell: HTTP failure or strict JSON/semantic parse failure → full raw appended with matrix_cell=…. Baseline warm/runs still use console.warn + raw_head only (not written to file).",
      fallback: champion
        ? null
        : "No cell met validity+latency constraint; inspect matrix[].sampleErrors and benchmarks/failed_responses.log; raise num_predict/ctx if models truncate.",
    },
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\nWrote ${OUTPUT_PATH}`);
  if (champion) {
    const rp = champion.ollama_options_used.repeat_penalty;
    const rpStr = typeof rp === "number" ? String(rp) : "?";
    console.log(
      `Champion (latency): ${champion.model} ${champion.matrix_cell_id} ctx=${champion.num_ctx} pred=${champion.num_predict} temp=${champion.temperature} repeat_penalty=${rpStr} medianMs=${Math.round(champion.medianMs)} valueAdj=${champion.valueScoreDepthAdjusted?.toFixed(4) ?? "n/a"} lowAcc=${champion.lowAccuracyVsR1}`,
    );
  } else {
    console.log("No latency champion selected; see tuning_results.json matrix.");
  }
  if (championByValue) {
    const rp = championByValue.ollama_options_used.repeat_penalty;
    const rpStr = typeof rp === "number" ? String(rp) : "?";
    console.log(
      `Champion (value, depth-adjusted): ${championByValue.model} ${championByValue.matrix_cell_id} valueAdj=${championByValue.valueScoreDepthAdjusted?.toFixed(4) ?? "n/a"} raw=${championByValue.valueScore?.toFixed(4) ?? "n/a"} ratioR1=${championByValue.reasoningDensityRatioVsR1?.toFixed(2) ?? "n/a"} medianMs=${Math.round(championByValue.medianMs)} temp=${championByValue.temperature} repeat_penalty=${rpStr} fitMed=${championByValue.relevance_score_median} lowAcc=${championByValue.lowAccuracyVsR1}`,
    );
  }
  console.log(`Failed-parse raw dumps (if any): ${FAILED_RAW_LOG}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
