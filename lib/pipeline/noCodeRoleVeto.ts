// lib/pipeline/noCodeRoleVeto.ts — offline veto when user excludes coding / SW-developer core work.
import type { OfflineVetoResult } from "./locationGeographyVeto";

/** True when saved constraints hard-exclude writing/reading production code or SW-developer roles. */
export function userConstraintsRejectCodingWork(constraints: string[]): boolean {
  const joined = constraints.join(" ").toLowerCase();
  if (!joined.trim()) return false;
  return (
    /\b(?:no[-\s]?code|non[-\s]?coding)\b/.test(joined) ||
    /\bzero\s+coding\b/.test(joined) ||
    /\bno\s+coding\s+experience\b/.test(joined) ||
    /\b(?:cannot|can't|can’t)\s+(?:write|read).{0,24}\bcode\b/.test(joined) ||
    /\b(?:cannot|can't|can’t)\s+code\b/.test(joined) ||
    /\bhard\s+veto\s+(?:software|sw)\s+developer\b/.test(joined) ||
    /\bhard\s+veto\b[\s\S]{0,120}\bproduction\s+code\b/.test(joined) ||
    /\bnem\s+tudok\s+k[oó]dolni\b/.test(joined) ||
    /\bveto\b.{0,50}szoftverfejleszt|\bszoftverfejleszt.{0,50}\bveto\b/.test(joined)
  );
}

const CODING_TITLE_RULES: { label: string; pattern: RegExp }[] = [
  { label: "software developer title", pattern: /\b(?:software|sw)\s+developers?\b/i },
  { label: "software developer title", pattern: /\bszoftverfejleszt/i },
  { label: "software engineer title", pattern: /\bsoftware\s+engineers?\b/i },
  {
    label: "language-specific developer title",
    pattern:
      /\b(?:python|java|javascript|typescript|c\+\+|c#|golang|go|rust|kotlin)\s+(?:developers?|engineers?)\b/i,
  },
  {
    label: "implementation engineer title",
    pattern:
      /\b(?:backend|front-?end|full[-\s]?stack|embedded)\s+(?:software\s+)?(?:developers?|engineers?)\b/i,
  },
  {
    label: "ML/AI implementation title",
    pattern: /\b(?:ml|machine[\s-]learning|deep[\s-]learning)\s+engineers?\b/i,
  },
  { label: "AI research/implementation title", pattern: /\bai\s+(?:research\s+)?engineers?\b/i },
  { label: "data engineer title", pattern: /\bdata\s+engineers?\b/i },
  { label: "firmware engineer title", pattern: /\bfirmware\s+(?:developers?|engineers?)\b/i },
];

/** Languages the hire would write — longest tokens first so C++ wins over C. */
const PROGRAMMING_LANG =
  String.raw`c\+\+|c\#|javascript|typescript|python|golang|\bjava\b|\brust\b|kotlin|swift|\bphp\b|\bruby\b|scala|matlab|perl|embedded\s+c|\bc\b`;

const PROGRAMMING_SKILL_NAMES = [
  "python",
  "java",
  "javascript",
  "typescript",
  "c++",
  "c#",
  "c",
  "embedded c",
  "golang",
  "go",
  "rust",
  "kotlin",
  "swift",
  "php",
  "ruby",
  "scala",
  "firmware",
] as const;

const NON_SOFTWARE_CODE =
  /\b(?:qr|bar|postal|zip|area|country|discount|promo(?:tional)?|access|invite|gift|coupon|dial|dress|building|penal|labor|labour|tax|legal|conduct)\s+codes?\b|\bcode of conduct\b|\bdress code\b/i;

function extractEvidenceSnippet(text: string, index: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + 90);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function titleWindow(jobText: string): string {
  const fromHeader = [...jobText.matchAll(/^title:\s*(.+)$/gim)].map((m) => m[1]?.trim() ?? "");
  const firstContent =
    jobText
      .split(/\n/)
      .map((s) => s.trim())
      .find(
        (s) =>
          s.length > 2 &&
          !/^(provider|url|company|location|title):/i.test(s) &&
          s !== "---" &&
          !s.startsWith("[Discovery"),
      ) ?? "";
  return [...fromHeader, firstContent].filter(Boolean).join("\n").slice(0, 400);
}

function postingSaysCodingNotRequired(text: string): boolean {
  return (
    /\bno\s+cod(?:e|ing)\s+required\b/i.test(text) ||
    /\bdoes not (?:require|involve) (?:any )?(?:coding|programming|writing code)\b/i.test(text) ||
    /\bnon[-\s]?coding\s+role\b/i.test(text)
  );
}

function hit(
  label: string,
  text: string,
  match: RegExpExecArray,
): { label: string; evidence: string } {
  return { label, evidence: extractEvidenceSnippet(text, match.index) };
}

/** Hands-on software: write/read/debug/review/ship code, programming, firmware, PRs. */
function detectCodingDuty(blob: string): { label: string; evidence: string } | null {
  const handsOnCode =
    /\b(?:write|writing|written|read|reading|debug(?:ging)?|troubleshoot(?:ing)?|review(?:ing)?|reviews?|develop(?:ing)?|create(?:ing)?|creating|ship(?:ping)?|maintain(?:ing)?|analy[sz]e|analy[sz]ing)\b[\s\S]{0,80}\b(?:source\s+)?codes?\b/i;
  const mHands = handsOnCode.exec(blob);
  if (mHands && mHands.index !== undefined) {
    const around = extractEvidenceSnippet(blob, mHands.index);
    if (!NON_SOFTWARE_CODE.test(around)) {
      return { label: "hands-on software code as core duty", evidence: around };
    }
  }

  const programming = new RegExp(
    String.raw`\b(?:(?:strong|solid|excellent|proven)\s+)?(?:${PROGRAMMING_LANG})\s+programming\b|\bprogramming\s+(?:in|with)\s+(?:${PROGRAMMING_LANG})\b|\bprogramoz(ni|ás|ói|oott)\b|\bkódol(ni|ás|ást)\b`,
    "i",
  );
  const mProg = programming.exec(blob);
  if (mProg && mProg.index !== undefined) {
    return hit("programming as a required skill", blob, mProg);
  }

  const codingActivity =
    /\b(?:hands-on\s+)?(?:coding|software development|firmware development|application development)\b|\bfor coding[,/]|\bdaily\b[\s\S]{0,40}\bcoding\b|\bcoding\b[\s\S]{0,40}\bdaily\b/i;
  const mCoding = codingActivity.exec(blob);
  if (mCoding && mCoding.index !== undefined) {
    return hit("coding or software/firmware development as core work", blob, mCoding);
  }

  const delivery =
    /\b(?:production code|source code|pull requests?|code reviews?|software design skills|your code running)\b|\bimplement(?:ing)?\b[\s\S]{0,80}\balgorithms?\b|\b(?:pytorch|tensorflow)\b|\bfirmware\s+(?:development|programming|engineer)/i;
  const mDel = delivery.exec(blob);
  if (mDel && mDel.index !== undefined) {
    return hit("shipping or reviewing software as core work", blob, mDel);
  }

  return null;
}

export function detectCodingCoreWork(
  jobText: string,
  requiredSkills: string[] = [],
): { label: string; evidence: string } | null {
  const skillBlob = requiredSkills.join("\n");
  const blob = `${skillBlob}\n${jobText}`;
  if (!blob.trim()) return null;
  const titles = `${skillBlob}\n${titleWindow(jobText)}`;

  for (const rule of CODING_TITLE_RULES) {
    const m = rule.pattern.exec(titles);
    if (!m || m.index === undefined) continue;
    return { label: rule.label, evidence: extractEvidenceSnippet(titles, m.index) };
  }

  if (postingSaysCodingNotRequired(jobText)) {
    return null;
  }

  const duty = detectCodingDuty(blob);
  if (duty) return duty;

  const requiredSet = new Set(requiredSkills.map((s) => s.toLowerCase().trim()));
  for (const skill of PROGRAMMING_SKILL_NAMES) {
    if (requiredSet.has(skill)) {
      return { label: `${skill} as a required skill`, evidence: skill };
    }
  }

  const langInText = new RegExp(String.raw`(?:${PROGRAMMING_LANG})`, "ig");
  let langMatch: RegExpExecArray | null;
  while ((langMatch = langInText.exec(jobText)) !== null) {
    if (langMatch.index === undefined) continue;
    const token = langMatch[0].toLowerCase();
    if (token === "c" || token === "go") {
      const around = extractEvidenceSnippet(jobText, langMatch.index);
      if (!/\b(programming|embedded|debug|firmware|developer)\b/i.test(around)) continue;
      return { label: `${token} programming requirement`, evidence: around };
    }
    const around = extractEvidenceSnippet(jobText, langMatch.index);
    if (/\b(programming|developer|frameworks?|production code|software design|debug)\b/i.test(around)) {
      return { label: `${token} programming requirement`, evidence: around };
    }
  }

  return null;
}

export function inferNoCodeRoleVeto(
  constraints: string[],
  jobText: string,
  requiredSkills: string[] = [],
): OfflineVetoResult {
  if (!userConstraintsRejectCodingWork(constraints)) {
    return { vetoed: false, veto_reason: null };
  }
  const found = detectCodingCoreWork(jobText, requiredSkills);
  if (!found) {
    return { vetoed: false, veto_reason: null };
  }
  return {
    vetoed: true,
    veto_reason: `Veto: saved constraints exclude coding / software-developer work, but this role’s core work is ${found.label} ("${found.evidence}").`,
    user_message: `Coding-role conflict: ${found.label}; your constraints exclude writing or reading production code.`,
  };
}
