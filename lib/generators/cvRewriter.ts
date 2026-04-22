import { generateJsonWithOllama, type ParserSource } from "../llm/ollama";

export type CvRewriteInput = {
  original_bullets: string[];
  missing_skills: string[];
};

export type CvRewriteResult = {
  rewritten_bullets: string[];
  generation_source: ParserSource;
};

function extractBulletsFromCvText(cvText: string): string[] {
  const bullets = cvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*•]/.test(line))
    .map((line) => line.replace(/^[-*•]\s*/, ""))
    .filter(Boolean);

  if (bullets.length > 0) {
    return bullets.slice(0, 8);
  }

  // Fallback: split by sentence if bullet markers are missing.
  return cvText
    .split(/[.!?]\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 20)
    .slice(0, 5);
}

function fallbackRewrite(input: CvRewriteInput): string[] {
  const skillsTail = input.missing_skills.length
    ? ` (relevant to ${input.missing_skills.join(", ")})`
    : "";

  return input.original_bullets.map(
    (bullet) => `${bullet} [Edit suggestion: add measurable impact and tools${skillsTail}]`,
  );
}

function sanitizeRewriterResult(result: unknown, fallback: string[]): string[] {
  if (typeof result !== "object" || result === null) {
    return fallback;
  }

  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.rewritten_bullets)) {
    return fallback;
  }

  const bullets = record.rewritten_bullets
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  return bullets.length > 0 ? bullets.slice(0, 8) : fallback;
}

export async function generateCvRewriteSuggestionsFromText(
  cvText: string,
  missingSkills: string[],
  ollamaModel = "llama3",
): Promise<CvRewriteResult> {
  const model = ollamaModel.trim() || "llama3";
  const originalBullets = extractBulletsFromCvText(cvText);
  const fallbackBullets = fallbackRewrite({
    original_bullets: originalBullets,
    missing_skills: missingSkills,
  });

  const prompt = `
You rewrite CV bullets for ATS optimization.
Return STRICT JSON only:
{
  "rewritten_bullets": string[]
}

Rules:
- Keep every statement honest and realistic
- Keep professional tone and plain language
- Keep output easy to edit by user
- Integrate relevant missing skills only when truthful
- Preserve the original meaning and achievements
- No markdown, no commentary, no extra keys

Original bullets:
${JSON.stringify(originalBullets)}

Missing skills to integrate when relevant:
${JSON.stringify(missingSkills)}
`;

  const llm = await generateJsonWithOllama<unknown>(
    prompt,
    {
      rewritten_bullets: fallbackBullets,
    },
    { model, timeoutMs: 60_000 },
  );
  const rewritten = sanitizeRewriterResult(llm.data, fallbackBullets);

  return {
    rewritten_bullets: rewritten,
    generation_source: llm.source,
  };
}
