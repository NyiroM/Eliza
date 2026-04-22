import { generateJsonWithOllama, type ParserSource } from "../llm/ollama";
import PDFParser from "pdf2json";
import type { CvParseResult } from "../../types/cv";

export type { CvParseResult } from "../../types/cv";

// Central skill dictionary used by all parsers.
// Keep this list explicit and easy to update.
const SKILL_KEYWORDS = [
  "typescript",
  "javascript",
  "node.js",
  "node",
  "next.js",
  "nextjs",
  "react",
  "python",
  "sql",
  "postgresql",
  "mongodb",
  "docker",
  "kubernetes",
  "aws",
  "azure",
  "gcp",
  "rest",
  "graphql",
  "git",
  "tailwind",
  "html",
  "css",
  "jest",
  "cypress",
  "ci/cd",
] as const;

function normalize(text: string): string {
  return text.toLowerCase();
}

function normalizeSkillName(skill: string): string {
  const map: Record<string, string> = {
    nextjs: "next.js",
    "node.js": "node",
  };

  return map[skill] ?? skill;
}

function extractSkillsKeywordFallback(cvText: string): string[] {
  const text = normalize(cvText);
  const found = new Set<string>();

  for (const keyword of SKILL_KEYWORDS) {
    if (text.includes(keyword)) {
      found.add(normalizeSkillName(keyword));
    }
  }

  return Array.from(found).sort();
}

function detectSeniorityFallback(cvText: string): CvParseResult["seniority_level"] {
  const text = normalize(cvText);

  if (text.includes("lead") || text.includes("principal") || text.includes("staff")) {
    return "lead";
  }

  if (text.includes("senior") || text.includes("5+ years") || text.includes("6+ years")) {
    return "senior";
  }

  if (text.includes("mid") || text.includes("3+ years") || text.includes("4+ years")) {
    return "mid";
  }

  if (text.includes("junior") || text.includes("1+ years") || text.includes("2+ years")) {
    return "junior";
  }

  return "unknown";
}

function extractCoreStoriesFallback(cvText: string): string[] {
  const lines = cvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // Prefer lines with measurable impact markers.
  const impactLines = lines.filter((line) =>
    /(\d+%|\d+x|\$\d+|\d+\s*(users|customers|ms|s|hours|days|weeks|months))/i.test(line),
  );

  const selected = (impactLines.length > 0 ? impactLines : lines).slice(0, 5);
  return selected.slice(0, 5);
}

function sanitizeCvResult(result: unknown, fallback: CvParseResult): CvParseResult {
  if (typeof result !== "object" || result === null) {
    return fallback;
  }

  const record = result as Record<string, unknown>;

  const skills = Array.isArray(record.skills)
    ? record.skills.filter((item): item is string => typeof item === "string")
    : fallback.skills;

  const seniorityValue = record.seniority_level;
  const allowedSeniority: CvParseResult["seniority_level"][] = [
    "junior",
    "mid",
    "senior",
    "lead",
    "unknown",
  ];
  const seniority_level =
    typeof seniorityValue === "string" && allowedSeniority.includes(seniorityValue as CvParseResult["seniority_level"])
      ? (seniorityValue as CvParseResult["seniority_level"])
      : fallback.seniority_level;

  const core_stories = Array.isArray(record.core_stories)
    ? record.core_stories
        .filter((item): item is string => typeof item === "string")
        .slice(0, 5)
    : fallback.core_stories;

  return {
    skills: Array.from(new Set(skills.map((s) => normalizeSkillName(s.toLowerCase())))).sort(),
    seniority_level,
    core_stories,
    parser_source: fallback.parser_source,
  };
}

export async function parseCvText(
  cvText: string,
  ollamaModel = "llama3",
): Promise<CvParseResult> {
  const model = ollamaModel.trim() || "llama3";
  const fallback: CvParseResult = {
    skills: extractSkillsKeywordFallback(cvText),
    seniority_level: detectSeniorityFallback(cvText),
    core_stories: extractCoreStoriesFallback(cvText).slice(0, 5),
    parser_source: "fallback",
  };

  const prompt = `
You are extracting structured CV data for a deterministic pipeline.
Return STRICT JSON only with this exact schema:
{
  "skills": string[],
  "seniority_level": "junior" | "mid" | "senior" | "lead" | "unknown",
  "core_stories": string[]
}

Rules:
- skills: lowercase technical skills only
- seniority_level: pick one allowed value
- core_stories: 3-5 concise achievement bullets with measurable impact if present
- no markdown, no commentary, no extra keys

CV_TEXT:
${cvText}
`;

  const llmResult = await generateJsonWithOllama<unknown>(prompt, fallback, {
    model,
    role: "extract_cv",
  });
  const parsed = sanitizeCvResult(llmResult.data, fallback);

  // Ensure minimum 3 stories when possible from fallback.
  if (parsed.core_stories.length >= 3) {
    return {
      ...parsed,
      parser_source: llmResult.source,
    };
  }

  return {
    ...parsed,
    core_stories: fallback.core_stories.slice(0, 5),
    parser_source: llmResult.source,
  };
}

export async function parseCvPdfBuffer(pdfBuffer: Buffer): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const parser = new PDFParser(null, true);

    parser.on("pdfParser_dataError", (error) => {
      reject(
        error instanceof Error
          ? error
          : new Error(
              "parserError" in error && error.parserError instanceof Error
                ? error.parserError.message
                : "Failed to parse PDF buffer.",
            ),
      );
    });

    parser.on("pdfParser_dataReady", () => {
      resolve(parser.getRawTextContent() ?? "");
      parser.destroy();
    });

    parser.parseBuffer(pdfBuffer);
  });
}
