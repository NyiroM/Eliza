// scripts/benchmark-ollama-tuning.mts
// Gemma 4 e4b Absolute Limits: gemma4:e4b only; matrix Cell_Factory / Robot / Creative / Thin_Context with fixed Ollama options.
// failed_responses.log: only Cell_Robot + Cell_Creative (parse or HTTP); Factory/Thin/baseline → console.warn + raw_head.
// tuning_results.json: benchmarkMode gemma4_e4b_absolute_limits; matrix[].is_factory_default marks Cell_Factory.

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

/** Gemma 4 e4b Absolute Limits — exact Ollama `options` on the wire (not overridden by env). */
const PROTOCOL_NUM_CTX_FULL = 16_384;
const PROTOCOL_NUM_CTX_THIN = 8192;
const PROTOCOL_NUM_PREDICT = 2048;
const PROTOCOL_NUM_GPU = 99;

/** Context sizes for truncation warnings only (defaults match protocol). */
const BENCH_NUM_CTX = Number(process.env.BENCHMARK_NUM_CTX ?? PROTOCOL_NUM_CTX_FULL);
const BENCH_THIN_NUM_CTX = Number(process.env.BENCHMARK_THIN_NUM_CTX ?? PROTOCOL_NUM_CTX_THIN);
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

type MatrixCellId = "Cell_Factory" | "Cell_Robot" | "Cell_Creative" | "Cell_Thin_Context";

type MatrixBenchCell = {
  cellId: MatrixCellId;
  /** When true, tuning_results marks this row as the factory-default sampling run (no temp/top_k in request). */
  is_factory_sampling_row: boolean;
  description: string;
};

const MATRIX_CELLS: MatrixBenchCell[] = [
  {
    cellId: "Cell_Factory",
    is_factory_sampling_row: true,
    description:
      "Cell_Factory: only num_ctx=16384, num_predict=2048, num_gpu=99 — no other sampling keys (Ollama runner defaults).",
  },
  {
    cellId: "Cell_Robot",
    is_factory_sampling_row: false,
    description: "Cell_Robot: num_ctx=16384, num_predict=2048, num_gpu=99, temperature=0, top_k=1, repeat_penalty=1.5.",
  },
  {
    cellId: "Cell_Creative",
    is_factory_sampling_row: false,
    description:
      "Cell_Creative: num_ctx=16384, num_predict=2048, num_gpu=99, temperature=1.5, top_p=0.95, mirostat=2.",
  },
  {
    cellId: "Cell_Thin_Context",
    is_factory_sampling_row: false,
    description: "Cell_Thin_Context: only num_ctx=8192, num_predict=2048, num_gpu=99; sampling omitted.",
  },
];

function ollamaOptionsForCellId(cellId: MatrixCellId): Record<string, unknown> {
  switch (cellId) {
    case "Cell_Factory":
      return {
        num_ctx: PROTOCOL_NUM_CTX_FULL,
        num_predict: PROTOCOL_NUM_PREDICT,
        num_gpu: PROTOCOL_NUM_GPU,
      };
    case "Cell_Robot":
      return {
        num_ctx: PROTOCOL_NUM_CTX_FULL,
        num_predict: PROTOCOL_NUM_PREDICT,
        num_gpu: PROTOCOL_NUM_GPU,
        temperature: 0,
        top_k: 1,
        repeat_penalty: 1.5,
      };
    case "Cell_Creative":
      return {
        num_ctx: PROTOCOL_NUM_CTX_FULL,
        num_predict: PROTOCOL_NUM_PREDICT,
        num_gpu: PROTOCOL_NUM_GPU,
        temperature: 1.5,
        top_p: 0.95,
        mirostat: 2,
      };
    case "Cell_Thin_Context":
      return {
        num_ctx: PROTOCOL_NUM_CTX_THIN,
        num_predict: PROTOCOL_NUM_PREDICT,
        num_gpu: PROTOCOL_NUM_GPU,
      };
    default: {
      const _x: never = cellId;
      throw new Error(`unknown cell ${_x}`);
    }
  }
}

/** Baseline runs use Cell_Robot options (deterministic strict sampling). */
const BASELINE_OLLAMA_OPTIONS = ollamaOptionsForCellId("Cell_Robot");

/** Factory \`valueScoreDepthAdjusted\` below this fraction of best tuned cell → “significantly worse” in notes. */
const FACTORY_VS_TUNED_WORSE_RATIO = 0.55;

const BASELINE_RUNS = Number(process.env.BENCHMARK_BASELINE_RUNS ?? 5);
const MATRIX_RUNS_DEFAULT = Number(process.env.BENCHMARK_MATRIX_RUNS ?? 2);
const MATRIX_RUNS_BATTLE = Number(process.env.BENCHMARK_MATRIX_RUNS_HIGH ?? 3);
const MATRIX_RUNS_EXPERIMENTAL = Number(process.env.BENCHMARK_MATRIX_RUNS_LOW ?? 1);

const BATTLE_MODEL_TAGS = new Set<string>(["gemma4:e4b"]);

const EXPERIMENTAL_MODEL_TAGS = new Set<string>();

/** Only these skip remaining temperature configs when a cell is slower than HEAVY_LATENCY_SKIP_MS. */
const HEAVY_REFERENCE_SKIP_TAGS = new Set<string>();

/** Extra scoring discipline for this benchmark (does not change production prompts). */
const BENCHMARK_SYSTEM_APPEND_SEMANTIC_RULES = `BENCHMARK_SEMANTIC_RULES (this run only):
- Use ONLY facts stated in the job posting text and the CV / evidence blocks supplied in the user message. Do not invent requirements, tools, industries, or skills that are not explicitly or clearly implied there.
- Penalize missing skills or experience ONLY when those items are stated as required or essential in the job expectations you were given. Do NOT subtract points for skills the posting does not ask for (including skills you might expect for the role title but that never appear in the supplied text).`;

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

function reportedTemperatureForCell(cellId: MatrixCellId): number | null {
  if (cellId === "Cell_Robot") return 0;
  if (cellId === "Cell_Creative") return 1.5;
  return null;
}

/** failed_responses.log: only Cell_Robot / Cell_Creative parse errors, or HTTP errors on those same cells. */
function shouldAppendMatrixFailureToLog(cellId: MatrixCellId, httpOk: boolean, parseOk: boolean): boolean {
  if (cellId !== "Cell_Robot" && cellId !== "Cell_Creative") return false;
  if (!httpOk) return true;
  if (parseOk) return false;
  return true;
}

type CellResult = {
  model: string;
  matrix_cell_id: MatrixCellId;
  matrix_cell_description: string;
  /** True only for Cell_Factory (Ollama default sampling — no temperature in options). */
  is_factory_default: boolean;
  ollama_options_used: Record<string, unknown>;
  num_ctx: number;
  num_predict: number;
  temperature: number | null;
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

function buildFactoryVsTunedNotes(matrix: CellResult[]): {
  lines: string[];
  perModel: Array<{
    model: string;
    bestTunedValueDepthAdj: number | null;
    factoryValueDepthAdj: number | null;
    factoryValidStrict: boolean;
    tunedHadAnyStrictValid: boolean;
    verdict:
      | "factory_significantly_worse"
      | "factory_comparable"
      | "factory_better_than_tuned_surprise"
      | "factory_fails_tuned_ok"
      | "no_factory_row"
      | "no_tuned_strict_baseline";
  }>;
} {
  if (!matrix.some((c) => c.is_factory_default)) {
    return {
      lines: ["This benchmark matrix has no factory-default (omitted temperature) row — factoryVsTuned N/A."],
      perModel: [],
    };
  }
  const models = [...new Set(matrix.map((c) => c.model))];
  const lines: string[] = [];
  const perModel: Array<{
    model: string;
    bestTunedValueDepthAdj: number | null;
    factoryValueDepthAdj: number | null;
    factoryValidStrict: boolean;
    tunedHadAnyStrictValid: boolean;
    verdict:
      | "factory_significantly_worse"
      | "factory_comparable"
      | "factory_better_than_tuned_surprise"
      | "factory_fails_tuned_ok"
      | "no_factory_row"
      | "no_tuned_strict_baseline";
  }> = [];

  for (const model of models) {
    const tuned = matrix.filter((c) => c.model === model && !c.is_factory_default);
    const factory = matrix.find((c) => c.model === model && c.is_factory_default);
    if (!factory) {
      perModel.push({
        model,
        bestTunedValueDepthAdj: null,
        factoryValueDepthAdj: null,
        factoryValidStrict: false,
        tunedHadAnyStrictValid: tuned.some((t) => t.validStrict),
        verdict: "no_factory_row",
      });
      continue;
    }
    const tunedStrict = tuned.filter((t) => t.validStrict && t.valueScoreDepthAdjusted !== null && Number.isFinite(t.valueScoreDepthAdjusted));
    const bestTunedValueDepthAdj =
      tunedStrict.length > 0 ? Math.max(...tunedStrict.map((t) => t.valueScoreDepthAdjusted!)) : null;
    const tunedHadAnyStrictValid = tuned.some((t) => t.validStrict);
    const fAdj = factory.valueScoreDepthAdjusted;
    const factoryValidStrict = factory.validStrict;

    let verdict:
      | "factory_significantly_worse"
      | "factory_comparable"
      | "factory_better_than_tuned_surprise"
      | "factory_fails_tuned_ok"
      | "no_factory_row"
      | "no_tuned_strict_baseline" = "factory_comparable";

    if (!tunedHadAnyStrictValid && !factoryValidStrict) {
      verdict = "no_tuned_strict_baseline";
    } else if (!factoryValidStrict && tunedHadAnyStrictValid) {
      verdict = "factory_fails_tuned_ok";
      lines.push(
        `${model}: factory default (temp omitted) failed strict parse while at least one tuned temp cell passed — red flag for loose sampling under noisy prompt.`,
      );
    } else if (
      factoryValidStrict &&
      bestTunedValueDepthAdj !== null &&
      fAdj !== null &&
      fAdj < bestTunedValueDepthAdj * FACTORY_VS_TUNED_WORSE_RATIO
    ) {
      verdict = "factory_significantly_worse";
      lines.push(
        `${model}: factory valueScoreDepthAdjusted (${fAdj.toFixed(4)}) << best tuned (${bestTunedValueDepthAdj.toFixed(4)} × ${FACTORY_VS_TUNED_WORSE_RATIO}) — strict low-temp tuning justified on value.`,
      );
    } else if (
      factoryValidStrict &&
      bestTunedValueDepthAdj !== null &&
      fAdj !== null &&
      fAdj > bestTunedValueDepthAdj * 1.08
    ) {
      verdict = "factory_better_than_tuned_surprise";
      lines.push(
        `${model}: factory default beat best tuned valueScoreDepthAdjusted (${fAdj.toFixed(4)} vs ${bestTunedValueDepthAdj.toFixed(4)}) — unexpected; inspect matrix row and raw logs.`,
      );
    } else {
      verdict = "factory_comparable";
    }

    perModel.push({
      model,
      bestTunedValueDepthAdj,
      factoryValueDepthAdj: fAdj,
      factoryValidStrict,
      tunedHadAnyStrictValid,
      verdict,
    });
  }

  if (lines.length === 0) {
    lines.push(
      "No strong factory-vs-tuned divergence detected (see perModel[].verdict). Factory row uses omitted options.temperature (Ollama runner default).",
    );
  }

  return { lines, perModel };
}

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
  is_factory_default?: boolean;
  matrix_cell_id?: MatrixCellId;
  reason: string;
  raw: string;
}): Promise<void> {
  const raw =
    entry.raw.length > RAW_LOG_MAX_CHARS
      ? `${entry.raw.slice(0, RAW_LOG_MAX_CHARS)}\n...[truncated ${entry.raw.length - RAW_LOG_MAX_CHARS} chars]`
      : entry.raw;
  const tempLabel =
    entry.is_factory_default || entry.temperature === null
      ? "ollama_runner_default(options.temperature_omitted)"
      : String(entry.temperature);
  const factoryTag = entry.is_factory_default ? "is_factory_default=yes" : "is_factory_default=no";
  const cellTag = entry.matrix_cell_id ? `matrix_cell=${entry.matrix_cell_id} ` : "";
  const block = `\n${"=".repeat(80)}\n${entry.iso} | ${cellTag}model=${entry.model} ctx=${entry.num_ctx} pred=${entry.num_predict} temp=${tempLabel} ${factoryTag}\nREASON: ${entry.reason}\nRAW:\n${raw}\n`;
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
  const baselineTempReported = reportedTemperatureForCell("Cell_Robot");

  console.log(
    `Stress prompt chars=${promptCharCount} (semantic fit + USER_CORRECTIONS + evidence appendix). Warm-up (discarded):`,
    matrixModel,
    `(baseline = Cell_Robot options, num_ctx=${baselineNumCtx})`,
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
        `[benchmark] baseline_discarded_warmup | parse=false | ${wpr.message} (Cell_Robot options; not written to ${path.basename(FAILED_RAW_LOG)} per protocol).`,
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
    `Baseline ${matrixModel} (${BASELINE_RUNS} runs, Cell_Robot options; num_ctx=${baselineNumCtx} num_predict=${baselineNumPredict})...`,
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

  console.log(`\nMatrix warm-up (discarded, Cell_Factory / default sampling): ${matrixModel}`);
  const factoryWarmOpts = { ...ollamaOptionsForCellId("Cell_Factory") };
  const matrixDiscardedWarm = await ollamaGenerateBench({
    model: matrixModel,
    ollamaOptions: factoryWarmOpts,
    ollamaFormat: productionJsonFormat,
    userPrompt,
    systemAppend: correctionsBlock,
  });
  {
    const mwpr = strictParseSemanticFit(matrixDiscardedWarm.raw, baseline, offlineVeto);
    if (matrixDiscardedWarm.httpOk && !mwpr.ok) {
      const rw = matrixDiscardedWarm.raw;
      console.warn(
        `[benchmark] matrix_discarded_warmup Cell_Factory | parse=false | ${mwpr.message} (not written to ${path.basename(FAILED_RAW_LOG)} per protocol).`,
      );
      if (rw.length > 0) {
        console.warn(`raw_head (${Math.min(800, rw.length)} chars):\n${rw.slice(0, 800)}${rw.length > 800 ? "…" : ""}`);
      }
    } else if (!matrixDiscardedWarm.httpOk) {
      console.warn(
        `[benchmark] matrix_discarded_warmup Cell_Factory | http_failed | ${matrixDiscardedWarm.err ?? "?"} (not written to ${path.basename(FAILED_RAW_LOG)} per protocol).`,
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
            is_factory_default: cellDef.is_factory_sampling_row,
            matrix_cell_id: cellDef.cellId,
            reason: `${cellDef.cellId} | ${baseReason}`,
            raw: out.raw ?? "",
          });
        } else {
          console.warn(
            `[benchmark] ${cellDef.cellId} | ${baseReason} (not written to ${path.basename(FAILED_RAW_LOG)} — only Cell_Robot / Cell_Creative go to file).`,
          );
          const rw = out.raw ?? "";
          if (rw.length > 0) {
            console.warn(`raw_head (${Math.min(800, rw.length)} chars):\n${rw.slice(0, 800)}${rw.length > 800 ? "…" : ""}`);
          }
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
      console.log(
        `  ${cellDef.cellId} ctx=${cellNumCtx} pred=${PROTOCOL_NUM_PREDICT} run ${r + 1}/${runs}: ${Math.round(out.wallMs)}ms parse=${ok}${fitHint}${lowHint}${errHint}`,
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
      is_factory_default: cellDef.is_factory_sampling_row,
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

  const factoryVsTuned = buildFactoryVsTunedNotes(matrixResults);

  const candidates = matrixResults.filter(
    (c) => !c.is_factory_default && c.validStrict && Number.isFinite(c.medianMs) && c.medianMs <= ceiling,
  );
  const sorted = [...candidates].sort((a, b) => a.medianMs - b.medianMs);
  const champion = sorted[0] ?? null;

  const valueCandidates = matrixResults.filter(
    (c) =>
      !c.is_factory_default &&
      c.validStrict &&
      c.valueScoreDepthAdjusted !== null &&
      Number.isFinite(c.valueScoreDepthAdjusted),
  );
  const championByValue =
    [...valueCandidates].sort((a, b) => (b.valueScoreDepthAdjusted ?? 0) - (a.valueScoreDepthAdjusted ?? 0))[0] ?? null;

  const payload = {
    generatedAt: new Date().toISOString(),
    benchmarkMode: "gemma4_e4b_absolute_limits",
    stressPromptCharCount: promptCharCount,
    jobDescription: FULL_JOB_DESCRIPTION,
    cvPath: path.join(REPO_ROOT, CV_REL_PATH),
    vramCleanup: "keep_alive:0 on each /api/generate (single-model gemma4:e4b run; no ollama stop between cells).",
    factoryRunColumn:
      "In matrix[], is_factory_default is true only for Cell_Factory (sampling params omitted from the Ollama options object — runner defaults). Other cells set explicit sampling as documented in benchParams.matrixCells.",
    skippedModels,
    benchParams: {
      matrixModels: [...MATRIX_MODELS],
      protocol: {
        num_ctx_full: PROTOCOL_NUM_CTX_FULL,
        num_ctx_thin: PROTOCOL_NUM_CTX_THIN,
        num_predict: PROTOCOL_NUM_PREDICT,
        num_gpu: PROTOCOL_NUM_GPU,
      },
      full_context_num_ctx: PROTOCOL_NUM_CTX_FULL,
      thin_context_num_ctx: PROTOCOL_NUM_CTX_THIN,
      num_predict: PROTOCOL_NUM_PREDICT,
      num_gpu: PROTOCOL_NUM_GPU,
      matrixCells: MATRIX_CELLS.map((c) => ({
        cell_id: c.cellId,
        is_factory_default: c.is_factory_sampling_row,
        is_factory_sampling_row: c.is_factory_sampling_row,
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
      baseline_cell: "Cell_Robot",
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
      /** Median reconciled \`fit_score\` from baseline (Cell_Robot options; reference for delta / lowAccuracy / valueScore). */
      baselineFitScoreMedianR1: Number.isFinite(baselineR1MedianFit) ? baselineR1MedianFit : null,
      baselineReasoningDepthMetrics,
      medianMs: baselineForCompare,
      ceilingMs15Pct: ceiling,
    },
    matrix: matrixResults,
    champion,
    championByValue,
    selectionNotes: {
      championUsesTunedCellsOnly:
        "champion and championByValue exclude matrix rows with is_factory_default=true (Cell_Factory only). Baseline uses Cell_Robot options.",
      factorySanityRow:
        "Cell_Factory / Cell_Thin_Context: options contain only num_ctx, num_predict, num_gpu (16384/2048/99 and 8192/2048/99). failed_responses.log receives only Cell_Robot + Cell_Creative parse errors and HTTP failures on those cells; other errors are console.warn only.",
      factoryVsTuned: factoryVsTuned,
      ruleLatency:
        "Among non-factory matrix cells, 100% strict JSON + semantic-fit shape on all runs, median wall ms <= baseline median * 1.15; pick lowest median.",
      ruleValueScore:
        "valueScore = max(1, 100 - abs(relevance_score_median - baselineFitScoreMedianR1)) / ((medianMs/1000) * vramTierUsed); vramTier is a name heuristic unless BENCHMARK_VRAM_TIER_OVERRIDE is set. championByValue uses valueScoreDepthAdjusted (see reasoningDensity), non-factory cells only.",
      reasoningDensity:
        "Cell narrative (reasoning_summary_sample) is scored as composite = charLen + 45 * keywordHits. reasoningDensityRatioVsR1 = cellComposite / baselineReasoningDepthMetrics.composite (last good baseline run). For 14B-class tags only: shallow reasoning penalty may apply per env thresholds.",
      lowAccuracyRule: `lowAccuracyVsR1 when |relevance_score_median - baselineFitScoreMedianR1| > ${LOW_ACCURACY_FIT_DELTA} (JSON can still be valid).`,
      failedRawLog: FAILED_RAW_LOG,
      failedRawLogReasonPrefixes:
        "File receives full raw body only for: (1) JSON parse errors on Cell_Robot or Cell_Creative, (2) HTTP failures on Cell_Robot or Cell_Creative. Cell_Factory, Cell_Thin_Context, and baseline warm/runs emit console.warn with raw_head only. REASON lines include matrix_cell=… when applicable.",
      fallback: champion
        ? null
        : "No cell met validity+latency constraint; inspect matrix[].sampleErrors and benchmarks/failed_responses.log; raise num_predict/ctx if models truncate.",
    },
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2), "utf8");
  console.log(`\nWrote ${OUTPUT_PATH}`);
  if (champion) {
    const tlab = champion.temperature === null ? "sampling_omitted" : String(champion.temperature);
    console.log(
      `Champion (latency): ${champion.model} ${champion.matrix_cell_id} ctx=${champion.num_ctx} pred=${champion.num_predict} temp=${tlab} medianMs=${Math.round(champion.medianMs)} valueAdj=${champion.valueScoreDepthAdjusted?.toFixed(4) ?? "n/a"} lowAcc=${champion.lowAccuracyVsR1}`,
    );
  } else {
    console.log("No latency champion selected; see tuning_results.json matrix.");
  }
  if (championByValue) {
    const tlab = championByValue.temperature === null ? "sampling_omitted" : String(championByValue.temperature);
    console.log(
      `Champion (value, depth-adjusted): ${championByValue.model} ${championByValue.matrix_cell_id} valueAdj=${championByValue.valueScoreDepthAdjusted?.toFixed(4) ?? "n/a"} raw=${championByValue.valueScore?.toFixed(4) ?? "n/a"} ratioR1=${championByValue.reasoningDensityRatioVsR1?.toFixed(2) ?? "n/a"} medianMs=${Math.round(championByValue.medianMs)} temp=${tlab} fitMed=${championByValue.relevance_score_median} lowAcc=${championByValue.lowAccuracyVsR1}`,
    );
  }
  console.log(`Failed-parse raw dumps (if any): ${FAILED_RAW_LOG}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
