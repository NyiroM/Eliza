// lib/pipeline/languageRequirementVeto.ts — offline veto when user allows only Hungarian but job requires other languages.
import type { OfflineVetoResult } from "./locationGeographyVeto";

/** User states they do not speak English / only Hungarian / no language besides Hungarian. */
export function userConstraintsAllowOnlyHungarian(constraints: string[]): boolean {
  const joined = constraints.join(" ").toLowerCase();
  if (!joined.trim()) return false;
  return (
    /\bdon'?t\s+speak\s+english\b/.test(joined) ||
    /\b(?:only|just)\s+hungarian\b/.test(joined) ||
    /\b(?:any\s+)?other\s+language\s+other\s+than\s+hungarian\b/.test(joined) ||
    /\bno\s+language\s+other\s+than\s+hungarian\b/.test(joined) ||
    /\bveto\s+every\s+job\s+where\s+this\s+is\s+mentioned\b/.test(joined)
  );
}

type LangRule = { language: string; pattern: RegExp };

/** Requirement phrasing — not titles like "Hungarian-speaking team". */
const NON_HUNGARIAN_LANGUAGE_REQUIREMENTS: LangRule[] = [
  {
    language: "English",
    pattern:
      /\b(?:fluent|proficient|native|excellent|very\s+good|strong|good|business|advanced|working)\s+(?:in\s+)?english\b/i,
  },
  {
    language: "English",
    pattern: /\benglish\s+(?:fluency|proficiency|language|skills?|knowledge|level|is\s+required|required|mandatory)\b/i,
  },
  {
    language: "English",
    pattern: /\b(?:command|knowledge|understanding)\s+of\s+(?:the\s+)?english\s+language\b/i,
  },
  {
    language: "English",
    pattern: /\bvery\s+good\s+command\s+of\s+english\b/i,
  },
  {
    language: "English",
    pattern: /\benglish\s+(?:and|&)\s+(?:hungarian|german|french|slovak|czech|polish)\b/i,
  },
  {
    language: "English",
    pattern: /\b(?:hungarian|german|french|slovak|czech|polish)\s+(?:and|&)\s+english\b/i,
  },
  {
    language: "English",
    pattern: /\bapply\s+(?:with\s+)?(?:an?\s+)?english\s+cv\b/i,
  },
  { language: "English", pattern: /\bcv\s+in\s+english\b/i },
  { language: "English", pattern: /\bangol\s+(?:nyelv|nyelvtudás|nyelvismeret|nyelvi\s+elvárás)\b/i },
  {
    language: "German",
    pattern:
      /\b(?:fluent|proficient|native|excellent|very\s+good|strong|good)\s+(?:in\s+)?(?:german|deutsch|német)\b/i,
  },
  {
    language: "French",
    pattern: /\b(?:fluent|proficient|native|excellent|very\s+good|strong|good)\s+(?:in\s+)?(?:french|francia)\b/i,
  },
  {
    language: "Slovak",
    pattern: /\b(?:fluent|proficient|native|excellent|very\s+good|strong|good)\s+(?:in\s+)?slovak\b/i,
  },
  {
    language: "Slovak",
    pattern: /\bslovak[\s-]speaking\b/i,
  },
];

function extractEvidenceSnippet(text: string, index: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + 80);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Detect explicit non-Hungarian language requirements in posting text.
 * Ignores positive "X-speaking" recruitment titles when X is the only language named in that phrase.
 */
export function detectNonHungarianLanguageRequirement(
  jobText: string,
): { language: string; evidence: string } | null {
  const text = jobText;
  if (!text.trim()) return null;

  for (const rule of NON_HUNGARIAN_LANGUAGE_REQUIREMENTS) {
    const m = rule.pattern.exec(text);
    if (!m || m.index === undefined) continue;
    const evidence = extractEvidenceSnippet(text, m.index);
    if (isHungarianSpeakingOnlyMention(evidence)) continue;
    return { language: rule.language, evidence };
  }

  for (const m of text.matchAll(/\benglish\b/gi)) {
    const index = m.index ?? 0;
    const evidence = extractEvidenceSnippet(text, index);
    if (isHungarianSpeakingOnlyMention(evidence)) continue;
    return { language: "English", evidence };
  }

  for (const m of text.matchAll(/\b(?:german|deutsch|német|french|francia|slovak)\b/gi)) {
    const index = m.index ?? 0;
    const evidence = extractEvidenceSnippet(text, index);
    if (isHungarianSpeakingOnlyMention(evidence)) continue;
    if (/\b(?:hungarian|magyar)\b/i.test(evidence) && !/\b(?:and|&)\b/i.test(evidence)) continue;
    const lang = m[0].toLowerCase();
    const label =
      lang === "german" || lang === "deutsch" || lang === "német"
        ? "German"
        : lang === "french" || lang === "francia"
          ? "French"
          : "Slovak";
    return { language: label, evidence };
  }

  return null;
}

function isHungarianSpeakingOnlyMention(evidence: string): boolean {
  if (!/\bhungarian[\s-]speaking\b/i.test(evidence)) return false;
  return !/\benglish\b/i.test(evidence);
}

export function inferLanguageRequirementVeto(
  constraints: string[],
  jobText: string,
): OfflineVetoResult {
  if (!userConstraintsAllowOnlyHungarian(constraints)) {
    return { vetoed: false, veto_reason: null };
  }
  const hit = detectNonHungarianLanguageRequirement(jobText);
  if (!hit) {
    return { vetoed: false, veto_reason: null };
  }
  return {
    vetoed: true,
    veto_reason: `Veto: saved constraints allow only Hungarian, but the posting requires ${hit.language} ("${hit.evidence}").`,
    user_message: `Language conflict: posting requires ${hit.language}; your constraints allow only Hungarian.`,
  };
}
