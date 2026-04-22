import { generateJsonWithOllama, type ParserSource } from "../llm/ollama";
import { CREATIVE_STRUCTURAL_NOISE_INSTRUCTION } from "../prompts/creative";

export type CoverLetterInput = {
  strength_highlights: string[];
  core_stories: string[];
  required_skills: string[];
  job_text: string;
  model?: string;
};

export type CoverLetterResult = {
  cover_letter: string;
  generation_source: ParserSource;
};

function fallbackCoverLetter(input: CoverLetterInput): string {
  const requiredSkills = input.required_skills.slice(0, 6).join(", ");
  const highlights = input.strength_highlights.slice(0, 2).join(" ");
  const story = input.core_stories[0] ?? "I consistently deliver measurable outcomes.";

  return [
    "Dear Hiring Manager,",
    "",
    "I am excited to apply for this role. My experience aligns well with your requirements.",
    `I bring hands-on experience with ${requiredSkills || "the required technical stack"}.`,
    `${highlights || story}`,
    "I value clear communication, ownership, and delivering high-quality work in a collaborative team.",
    "Thank you for your time and consideration. I would welcome the opportunity to discuss how I can contribute.",
    "",
    "Sincerely,",
    "[Your Name]",
  ].join("\n");
}

function sanitizeCoverLetter(result: unknown, fallback: string): string {
  if (typeof result !== "object" || result === null) {
    return fallback;
  }

  const record = result as Record<string, unknown>;
  if (typeof record.cover_letter !== "string") {
    return fallback;
  }

  const text = record.cover_letter.trim();
  return text.length > 0 ? text : fallback;
}

export async function generateCoverLetter(
  input: CoverLetterInput,
): Promise<CoverLetterResult> {
  const model = input.model?.trim() || "llama3";
  const fallback = fallbackCoverLetter(input);

  const prompt = `
Draft a concise, professional cover letter.
Return STRICT JSON only:
{
  "cover_letter": string
}

Rules:
- ${CREATIVE_STRUCTURAL_NOISE_INSTRUCTION}
- Professional and confident tone
- Keep it easy for the user to edit
- Use the candidate strengths and core stories
- Align directly with required skills from the job
- Do not invent facts
- No markdown, no commentary, no extra keys

Required skills:
${JSON.stringify(input.required_skills)}

Strength highlights:
${JSON.stringify(input.strength_highlights)}

Core stories:
${JSON.stringify(input.core_stories)}

Job description:
${input.job_text}
`;

  const llm = await generateJsonWithOllama<unknown>(
    prompt,
    {
      cover_letter: fallback,
    },
    { model, role: "creative_coach" },
  );

  return {
    cover_letter: sanitizeCoverLetter(llm.data, fallback),
    generation_source: llm.source,
  };
}
