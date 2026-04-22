import {
  generateJsonWithOllama,
  generateJsonWithOllamaStrict,
  type ParserSource,
} from "../llm/ollama";
import {
  DEFAULT_OLLAMA_MODEL,
  ENGLISH_DETECTION_GERMAN_PROBE_MAX_CHARS,
  ENGLISH_DETECTION_JOB_LEXEME_WEIGHT,
  ENGLISH_DETECTION_MIN_SCORE_SKIP_TRANSLATION,
  ENGLISH_DETECTION_PHRASE_BONUS_WEIGHT,
  ENGLISH_DETECTION_SAMPLE_MAX_CHARS,
  JOB_TEXT_LIMITS,
} from "../../config/constants";
import type { JobParseResult, JobTypeCategory, WorkModel } from "../../types/job";

export type { JobParseResult, JobTypeCategory, WorkModel } from "../../types/job";

/**
 * English-first heuristic (no LLM). High-confidence English ⇒ caller may skip translation;
 * anything ambiguous or clearly non-English ⇒ run automatic translation prep.
 */
const ENGLISH_FUNCTION_TOKEN_RE =
  /\b(?:the|a|an|and|or|but|nor|not|only|just|if|then|else|when|while|until|since|because|although|though|unless|whether|with|without|within|from|into|onto|upon|about|above|below|between|among|through|during|before|after|against|across|toward|towards|beyond|outside|inside|near|off|over|under|again|further|once|here|there|where|why|how|what|which|who|whom|whose|this|that|these|those|any|some|all|both|each|every|few|more|most|other|such|same|than|too|very|also|can|could|may|might|must|shall|will|would|should|ought|need|have|has|had|having|be|am|is|are|was|were|been|being|do|does|did|doing|done|get|got|getting|make|made|take|took|come|came|go|went|use|used|using|say|said|tell|told|ask|asked|work|works|working|worked|find|found|give|gave|show|shown|think|thought|know|knew|see|saw|want|wanted|try|tried|call|called|seem|seemed|leave|left|put|mean|means|meant|keep|kept|let|begin|began|begun|run|ran|running|move|moved|live|lived|believe|believed|bring|brought|happen|happened|write|wrote|provide|provided|sit|sat|stand|stood|lose|lost|pay|paid|meet|met|include|included|continue|continued|set|learn|learned|change|changed|lead|led|understand|understood|watch|watched|follow|followed|stop|stopped|create|created|speak|spoke|spoken|read|allow|allowed|add|added|spend|spent|grow|grew|grown|open|opened|walk|walked|win|won|offer|offered|remember|remembered|love|loved|consider|considered|appear|appeared|buy|bought|wait|waited|die|died|send|sent|expect|expected|build|built|stay|stayed|fall|fell|fallen|cut|reach|reached|remain|remained|suggest|suggested|raise|raised|pass|passed|sell|sold|require|required|report|reported|decide|decided|pull|pulled)\b/gi;

const ENGLISH_JOB_LEXEME_RE =
  /\b(?:requirements?|responsibilities|qualifications|experience|education|degree|skills?|abilities|knowledge|position|role|job|title|location|salary|compensation|benefits?|equity|bonus|perks?|insurance|healthcare|remote|hybrid|on[-\s]?site|full[-\s]?time|part[-\s]?time|contract|temporary|permanent|internship|application|apply|candidates?|employees?|employer|team|department|manager|director|engineer|developer|analyst|consultant|specialist|years?|yearly|annual|minimum|maximum|preferred|nice[-\s]?to[-\s]?have|must[-\s]?have|summary|overview|description|posting|listing|opening|vacancy|duties|accountabilities|deliverables|stakeholders|reporting)\b/gi;

const ENGLISH_STRONG_PHRASE_RE =
  /\b(?:key\s+responsibilities|job\s+description|role\s+overview|years\s+of\s+experience|work\s+experience|how\s+to\s+apply|please\s+submit|cover\s+letter|equal\s+opportunity|about\s+the\s+role|about\s+the\s+position|what\s+you\s+will|what\s+you'?ll)\b/gi;

export function isLikelyEnglishText(text: string): boolean {
  const t = text.slice(0, ENGLISH_DETECTION_SAMPLE_MAX_CHARS);
  if (!t.trim()) return true;

  if (/[äöüÄÖÜß]/.test(t.slice(0, ENGLISH_DETECTION_GERMAN_PROBE_MAX_CHARS))) {
    return false;
  }

  const lang = t.toLowerCase();
  const functionHits = (lang.match(ENGLISH_FUNCTION_TOKEN_RE) ?? []).length;
  const jobLexemeHits = (lang.match(ENGLISH_JOB_LEXEME_RE) ?? []).length;
  const phraseHits = (lang.match(ENGLISH_STRONG_PHRASE_RE) ?? []).length;

  const score =
    functionHits +
    jobLexemeHits * ENGLISH_DETECTION_JOB_LEXEME_WEIGHT +
    phraseHits * ENGLISH_DETECTION_PHRASE_BONUS_WEIGHT;

  return score >= ENGLISH_DETECTION_MIN_SCORE_SKIP_TRANSLATION;
}

const REQUIRED_HINTS = [
  "required",
  "must have",
  "must-have",
  "requirements",
  "need to have",
  "your profile",
  "minimum qualifications",
];

const OPTIONAL_HINTS = [
  "nice to have",
  "preferred",
  "plus",
  "bonus",
  "good to have",
  "optional",
];

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
  "agile",
  "scrum",
  "sales",
  "engineering",
  "excel",
  "powerpoint",
  "ms office",
  "office 365",
  "crm",
  "sap",
  "autocad",
  "english",
] as const;

/** Remove PDF/web noise before LLM (page breaks, form feeds, repeated separators). */
export function cleanJobArtifacts(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\f/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/(?:^|\n)\s*(?:page\s*)?break\s*(?:\n|$)/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/_{4,}/g, " ")
    .replace(/-{4,}/g, " ")
    .trim();
}

/** Requirement-focused headers (exclude advantages-only sections). */
const TRANSLATE_REQUIREMENT_HEADER_RE =
  /^(#*\s*)?(requirements?|about the (role|position|company)|the role|role overview|key responsibilities|what you'?ll do|what you will do|your profile|must have|qualifications|skills we look for|role description|job description|position description)\b/i;

/**
 * Before translation: cap length to reduce VRAM. Prefer requirement-style sections
 * ("Requirements", "About the role", and similar English section headers).
 */
export function truncateJobForTranslation(
  cleanedJob: string,
  maxChars = JOB_TEXT_LIMITS.truncateForTranslation,
): string {
  const trimmed = cleanedJob.trim();
  if (trimmed.length <= maxChars) return trimmed;

  const lines = trimmed.split("\n");
  let sectionStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].trim().replace(/^#+\s*/, "");
    if (TRANSLATE_REQUIREMENT_HEADER_RE.test(L)) {
      sectionStart = i;
      break;
    }
  }

  let chunk: string;
  if (sectionStart >= 0) {
    chunk = lines.slice(sectionStart).join("\n");
  } else {
    const start = Math.min(
      Math.floor(trimmed.length * 0.2),
      Math.max(0, trimmed.length - maxChars),
    );
    chunk = trimmed.slice(start, start + maxChars);
  }
  if (chunk.length > maxChars) chunk = chunk.slice(0, maxChars);
  chunk = chunk.trim();
  if (!chunk) chunk = trimmed.slice(0, maxChars);
  return chunk;
}

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

function includesAny(text: string, hints: readonly string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

function extractEstimatedSalaryFallback(jobText: string): string | null {
  const salaryPattern =
    /((?:usd|eur|gbp|ft|huf|\$|€|£)\s?\d[\d,.\s]*(?:\s?-\s?(?:usd|eur|gbp|ft|huf|\$|€|£)?\s?\d[\d,.\s]*)?(?:\s?(?:per year|\/year|annual|yr|gross|net))?)/i;
  const match = jobText.match(salaryPattern);
  return match ? match[1].trim() : null;
}

function extractExperienceYearsFallback(jobText: string): number | null {
  const lines = jobText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const requirementSignals = [
    "required",
    "minimum",
    "at least",
    "must have",
    "need",
    "you have",
    "candidate",
    "experience required",
    "years of experience",
  ];
  const companySignals = [
    "we have",
    "our company",
    "we are",
    "founded",
    "on the market",
    "years on the market",
    "since ",
    "established in",
  ];

  const patterns = [
    /(\d+)\+?\s*(?:years?|yrs?)/gi,
    /(?:minimum|min\.?|at least)\s*(\d+)\s*(?:years?)?/gi,
  ];

  let best = 0;
  for (const line of lines) {
    const lowered = line.toLowerCase();
    const hasCompanySignal = companySignals.some((s) => lowered.includes(s));
    const hasRequirementSignal = requirementSignals.some((s) => lowered.includes(s));
    if (hasCompanySignal && !hasRequirementSignal) {
      continue;
    }

    for (const re of patterns) {
      let m: RegExpExecArray | null;
      const r = new RegExp(re.source, re.flags);
      while ((m = r.exec(line)) !== null) {
        const n = parseInt(m[1], 10);
        if (!Number.isNaN(n) && (hasRequirementSignal || lowered.includes("experience"))) {
          best = Math.max(best, n);
        }
      }
    }
  }
  return best > 0 ? best : null;
}

function extractEducationFallback(jobText: string): string | null {
  const t = jobText.toLowerCase();
  const hints = [
    "bsc",
    "bachelor",
    "msc",
    "master",
    "mba",
    "phd",
    "engineering degree",
    "diploma",
    "university",
    "college degree",
    "associate degree",
  ];
  for (const h of hints) {
    if (t.includes(h)) {
      const line = jobText
        .split(/\n/)
        .find((l) => l.toLowerCase().includes(h));
      return line ? line.trim().slice(0, 200) : h;
    }
  }
  return null;
}

function detectRequiredSeniorityFallback(
  jobText: string,
): JobParseResult["required_seniority"] {
  const text = normalize(jobText);

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

function keywordFallback(jobText: string): JobParseFields {
  const lines = normalize(jobText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const required = new Set<string>();
  const optional = new Set<string>();
  let inRequiredSection = false;
  let inOptionalSection = false;

  for (const line of lines) {
    if (
      line.includes("about us") ||
      line.includes("company") ||
      line.includes("benefits") ||
      line.includes("culture")
    ) {
      inRequiredSection = false;
      inOptionalSection = false;
      continue;
    }

    const isRequiredLine = includesAny(line, REQUIRED_HINTS);
    const isOptionalLine = includesAny(line, OPTIONAL_HINTS);
    if (isRequiredLine) {
      inRequiredSection = true;
      inOptionalSection = false;
    } else if (isOptionalLine) {
      inOptionalSection = true;
      inRequiredSection = false;
    }

    for (const keyword of SKILL_KEYWORDS) {
      if (!line.includes(keyword)) continue;
      const normalizedSkill = normalizeSkillName(keyword);
      if (isRequiredLine) required.add(normalizedSkill);
      else if (isOptionalLine) optional.add(normalizedSkill);
      else if (inRequiredSection) required.add(normalizedSkill);
      else if (inOptionalSection) optional.add(normalizedSkill);
    }
  }

  for (const skill of required) {
    optional.delete(skill);
  }

  const t = normalize(jobText);

  return {
    required_skills: Array.from(required).sort(),
    optional_skills: Array.from(optional).sort(),
    estimated_salary: extractEstimatedSalaryFallback(jobText),
    required_seniority: detectRequiredSeniorityFallback(jobText),
    experience_years: extractExperienceYearsFallback(jobText),
    education: extractEducationFallback(jobText),
    job_location: extractLocationKeywordFallback(jobText),
    work_model: detectWorkModelKeywordFallback(t),
    job_type: detectJobTypeKeywordFallback(t),
    benefits: extractBenefitsKeywordFallback(t),
    commitments: extractCommitmentsKeywordFallback(t),
    metadata_constraint_notes: [],
  };
}

function detectWorkModelKeywordFallback(t: string): WorkModel {
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(remote|work from home|wfh|fully remote|100% remote)\b/.test(t)) return "remote";
  if (/\b(on-?site|onsite|in[- ]office|on site|in person at office)\b/.test(t)) return "on-site";
  return "unknown";
}

function detectJobTypeKeywordFallback(t: string): JobTypeCategory {
  if (/\bvolunteer\b/.test(t)) return "volunteer";
  if (/\bintern(ship)?\b/.test(t)) return "internship";
  if (/\btemporary\b|\btemp to perm\b|\btemp role\b/.test(t)) return "temporary";
  if (/\bcontract(?:or)?\b/.test(t)) return "contract";
  if (/\bpart[- ]time\b|\bpt role\b/.test(t)) return "part-time";
  if (/\bfull[- ]time\b|\bft role\b/.test(t)) return "full-time";
  return "unknown";
}

function extractLocationKeywordFallback(jobText: string): string | null {
  const patterns = [
    /(?:location|based in|office in|headquartered in|based at)\s*[:\-]\s*([^\n]+)/i,
    /(?:workplace|work\s+site|reporting to)\s*[:\-]\s*([^\n]+)/i,
    /\b(?:in|at)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*(?:USA|UK|UAE|EU|Ireland|Germany|France|Poland|Romania))\b/,
    /\b(?:London|Berlin|Munich|Paris|Vienna|Warsaw|Bucharest|Cluj|Amsterdam|Dublin|Singapore|Toronto|New York|San Francisco)\b[^.\n]{0,40}/i,
  ];
  for (const re of patterns) {
    const m = jobText.match(re);
    if (m?.[1]) {
      const s = m[1].replace(/\s+/g, " ").trim();
      if (s.length > 2 && s.length < 200) return s;
    }
  }
  return null;
}

function extractBenefitsKeywordFallback(t: string): string[] {
  const catalog: [RegExp, string][] = [
    [/401\s*\(?k\)?|401k/i, "401(k)"],
    [/medical(?:\s+insurance)?|health(?:\s+insurance)?/i, "Medical/health insurance"],
    [/dental/i, "Dental insurance"],
    [/vision/i, "Vision insurance"],
    [/pension/i, "Pension"],
    [/paid\s+(?:time\s+off|leave|vacation)|\bpto\b|\bparental\s+leave/i, "Paid leave / PTO"],
    [/stock\s+options?|equity|rsu/i, "Equity / stock"],
    [/gym|wellness|fitness/i, "Wellness / gym"],
    [/life\s+insurance/i, "Life insurance"],
  ];
  const out: string[] = [];
  for (const [re, label] of catalog) {
    if (re.test(t)) out.push(label);
  }
  return [...new Set(out)].slice(0, 24);
}

function extractCommitmentsKeywordFallback(t: string): string[] {
  const catalog: [RegExp, string][] = [
    [/work[- ]life\s+balance/i, "Work-life balance"],
    [/diversity|inclusion|dei\b/i, "Diversity & inclusion"],
    [/sustainab(le|ility)/i, "Sustainability"],
    [/carbon\s+neutral|climate/i, "Climate / environment"],
    [/mental\s+health/i, "Mental health support"],
  ];
  const out: string[] = [];
  for (const [re, label] of catalog) {
    if (re.test(t)) out.push(label);
  }
  return [...new Set(out)].slice(0, 16);
}

type LangPrepResult = {
  /** Optional chain-of-thought; ignored by the pipeline after language prep. */
  prep_rationale?: string;
  is_english: boolean;
  job_text_for_extraction: string;
};

function clampExperienceYears(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const n = parseInt(value.replace(/[^\d]/g, ""), 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 60) return n;
  }
  return null;
}

function sanitizeEducation(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return s.length > 0 ? s.slice(0, 300) : null;
}

function sanitizeEntityStrings(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/\s+/g, " "));
}

type JobParseFields = Omit<JobParseResult, "parser_source" | "english_job_text">;

type EntityExtractionResult = JobParseFields;

function sanitizeShortList(items: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is string => typeof item === "string")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0)
    .map((s) => (s.length > maxLen ? s.slice(0, maxLen) : s))
    .slice(0, maxItems);
}

function normalizeWorkModelValue(raw: unknown, fallback: WorkModel): WorkModel {
  if (typeof raw !== "string") return fallback;
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (s.includes("hybrid")) return "hybrid";
  if (s.includes("remote") || s.includes("wfh") || s.includes("work from home")) return "remote";
  if (
    s.includes("on-site") ||
    s.includes("onsite") ||
    s.includes("on site") ||
    s.includes("in office") ||
    s.includes("in-office") ||
    s.includes("office-first") ||
    s.includes("in person")
  )
    return "on-site";
  if (s === "unknown" || s.length === 0) return fallback;
  return fallback;
}

function normalizeJobTypeValue(raw: unknown, fallback: JobTypeCategory): JobTypeCategory {
  if (typeof raw !== "string") return fallback;
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim().replace(/_/g, "-");
  const allowed: JobTypeCategory[] = [
    "full-time",
    "part-time",
    "contract",
    "temporary",
    "volunteer",
    "internship",
    "unknown",
  ];
  const normalized = s.replace(/\s+/g, "-") as JobTypeCategory;
  if (allowed.includes(normalized)) return normalized;
  if (s.includes("full") && s.includes("time")) return "full-time";
  if (s.includes("part") && s.includes("time")) return "part-time";
  if (s.includes("contract")) return "contract";
  if (s.includes("temporary") || s === "temp") return "temporary";
  if (s.includes("volunteer")) return "volunteer";
  if (s.includes("intern")) return "internship";
  return fallback;
}

function sanitizeJobLocation(raw: unknown, fallback: string | null): string | null {
  if (typeof raw !== "string") return fallback;
  const s = raw.replace(/\s+/g, " ").trim();
  if (s.length < 2) return fallback;
  return s.slice(0, 200);
}

function sanitizeJobResult(result: unknown, fallback: JobParseFields): JobParseFields {
  if (typeof result !== "object" || result === null) {
    return fallback;
  }

  const record = result as Record<string, unknown>;
  const required = sanitizeEntityStrings(record.required_skills);
  const optional = sanitizeEntityStrings(record.optional_skills);

  const estimated_salary =
    typeof record.estimated_salary === "string" || record.estimated_salary === null
      ? record.estimated_salary
      : fallback.estimated_salary;

  const required_seniority = (
    typeof record.required_seniority === "string" ? record.required_seniority : ""
  ) as JobParseResult["required_seniority"];
  const allowedSeniority: JobParseResult["required_seniority"][] = [
    "junior",
    "mid",
    "senior",
    "lead",
    "unknown",
  ];

  const experience_years =
    record.experience_years !== undefined
      ? clampExperienceYears(record.experience_years)
      : fallback.experience_years;

  const education =
    record.education !== undefined
      ? sanitizeEducation(record.education)
      : fallback.education;

  const normalizedRequired = Array.from(
    new Set(required.map((s) => normalizeSkillName(s.toLowerCase()))),
  ).sort();
  const normalizedOptional = Array.from(
    new Set(optional.map((s) => normalizeSkillName(s.toLowerCase()))),
  )
    .filter((skill) => !normalizedRequired.includes(skill))
    .sort();

  const job_location = sanitizeJobLocation(record.job_location, fallback.job_location);
  const work_model = normalizeWorkModelValue(record.work_model, fallback.work_model);
  const job_type = normalizeJobTypeValue(record.job_type, fallback.job_type);
  const benefits = sanitizeShortList(record.benefits, 30, 80);
  const commitments = sanitizeShortList(record.commitments, 20, 80);
  const metadata_constraint_notes = sanitizeShortList(record.metadata_constraint_notes, 8, 200);

  return {
    required_skills: normalizedRequired.length > 0 ? normalizedRequired : fallback.required_skills,
    optional_skills: normalizedOptional,
    estimated_salary,
    required_seniority: allowedSeniority.includes(required_seniority)
      ? required_seniority
      : fallback.required_seniority,
    experience_years: experience_years ?? fallback.experience_years,
    education: education ?? fallback.education,
    job_location: job_location ?? fallback.job_location,
    work_model,
    job_type,
    benefits: benefits.length > 0 ? benefits : fallback.benefits,
    commitments: commitments.length > 0 ? commitments : fallback.commitments,
    metadata_constraint_notes:
      metadata_constraint_notes.length > 0
        ? metadata_constraint_notes
        : fallback.metadata_constraint_notes,
  };
}

async function stageLanguageAndTranslate(
  cleanedText: string,
  ollamaModel: string,
  strictLlm: boolean,
): Promise<{ prep: LangPrepResult; source: ParserSource }> {
  const maxLen = JOB_TEXT_LIMITS.languagePrepInputMax;
  const slice = cleanedText.length > maxLen ? cleanedText.slice(0, maxLen) : cleanedText;

  const fallback: LangPrepResult = {
    is_english: true,
    job_text_for_extraction: cleanedText,
  };

  const prompt = `Return STRICT JSON with keys in this order (rationale first, then fields):
{"prep_rationale":string,"is_english":boolean,"job_text_for_extraction":string}

- prep_rationale: 1–2 English sentences on how you detected language and what you kept vs dropped before extraction.
- If mostly English: is_english true; job_text_for_extraction = input (trim boilerplate headers/footers only).
- Else: is_english false; translate requirement-heavy parts to English (skills, qualifications, experience). Drop long marketing/company history unless it states hard requirements.
- Non-English postings: company "25 years on market" ≠ candidate years; "X years experience required" = keep.
- Keep bullets as newlines. JSON only.

INPUT:
${slice}`;

  if (strictLlm) {
    const data = await generateJsonWithOllamaStrict<LangPrepResult>(prompt, {
      model: ollamaModel,
      role: "analysis",
    });
    const text =
      typeof data.job_text_for_extraction === "string" ? data.job_text_for_extraction.trim() : "";
    if (!text) {
      throw new Error("Ollama language prep returned empty job_text_for_extraction (strict pipeline).");
    }
    return {
      prep: {
        is_english: Boolean(data.is_english),
        job_text_for_extraction: text,
      },
      source: "llm",
    };
  }

  const llm = await generateJsonWithOllama<LangPrepResult>(prompt, fallback, {
    model: ollamaModel,
    role: "analysis",
  });
  const data = llm.data;
  if (typeof data.job_text_for_extraction !== "string" || !data.job_text_for_extraction.trim()) {
    return { prep: fallback, source: llm.source };
  }
  return {
    prep: {
      is_english: Boolean(data.is_english),
      job_text_for_extraction: data.job_text_for_extraction.trim(),
    },
    source: llm.source,
  };
}

function jobFieldsToEntityFallback(fields: JobParseFields): EntityExtractionResult {
  return { ...fields };
}

async function stageEntityExtraction(
  jobTextForExtraction: string,
  ollamaModel: string,
  userConstraints: string[],
  strictLlm: boolean,
): Promise<{ fields: JobParseFields; source: ParserSource }> {
  const fallbackFields = keywordFallback(jobTextForExtraction);
  const maxLen = JOB_TEXT_LIMITS.entityExtractionSlice;
  const slice =
    jobTextForExtraction.length > maxLen
      ? jobTextForExtraction.slice(0, maxLen)
      : jobTextForExtraction;

  const constraintsBlock =
    userConstraints.length > 0
      ? `CONSTRAINTS: ${JSON.stringify(userConstraints)}
metadata_constraint_notes: short English bullets when location/work_model/job_type/benefits/commitments align or conflict with a constraint; else [].`
      : `CONSTRAINTS: none → metadata_constraint_notes [].`;

  const prompt = `Extract hiring signals from English job text. STRICT JSON with keys in this order (chain-of-thought first, then structured fields):
{"parsing_rationale":string,"required_skills":string[],"optional_skills":string[],"estimated_salary":string|null,"required_seniority":"junior"|"mid"|"senior"|"lead"|"unknown","experience_years":number|null,"education":string|null,"job_location":string|null,"work_model":"on-site"|"hybrid"|"remote"|"unknown","job_type":"full-time"|"part-time"|"contract"|"temporary"|"volunteer"|"internship"|"unknown","benefits":string[],"commitments":string[],"metadata_constraint_notes":string[]}

- parsing_rationale: 2–4 English sentences on which regions of the posting you trusted for skills vs fluff, and any ambiguity you resolved conservatively.

All string outputs English. estimated_salary as in posting.

SECTION TARGETING (critical):
- IGNORE the first ~30% and last ~30% of the input BY CHARACTER COUNT unless those regions clearly contain bullet lists (lines starting with -, *, •, or numbered items) that list skills or requirements.
- Focus on sections whose meaning aligns with: "Your profile", "Requirements", "Skills", "Qualifications", "What we look for", "Must have", "Nice to have" (only where they state hard skills).

Regional job-board layout (common globally):
- Sections titled "Nice to have", "Plus", "Advantages", or clearly labeled optional advantages: every skill or tool listed there MUST go into optional_skills ONLY. Never copy those items into required_skills. Missing an advantage section is never a hard gap.
- Sections titled "Minimum requirements", "Must have", "Requirements", "Qualifications": those belong in required_skills when they name concrete tools/languages/platforms.

SKILLS (STRICT — hard requirements only):
- required_skills: ONLY verifiable hard skills, tools, platforms, languages, certifications, and named methodologies (e.g. "Python", "SAP PM", "Agile", "English C1", "AWS", "Finite element analysis").
- DO NOT list job duties, deliverables, or soft responsibilities (e.g. omit "cost calculation", "preparing offers", "client communication", "stakeholder alignment", "leading workshops") unless they name a concrete tool/method (e.g. "Agile workshops" → keep "Agile" only if methodology is a hard requirement).
- DO NOT treat generic soft skills as required_skills unless the posting explicitly demands a named competency (e.g. "negotiation" alone → omit; "contract negotiation under IFRS" → consider domain keywords only if tool/standard named).
- optional_skills: clearly labeled nice-to-have hard skills/tools only.
- You MUST extract at least 5-10 core hard skills/tools/technologies when the posting has substantial content.
- If you find mentions of Engineering, Sales, MS Office, or specific industry tools, include those concrete hard skills in required_skills.
- Never return an empty required_skills list when the description clearly contains requirement content.
- experience_years: minimum years required for the candidate only. Ignore company age/history statements like "we have 25 years of experience" or "25 years on the market".

EDUCATION (strict — degrees, qualifications, institutions ONLY):
- education must be ONE concise line naming a required minimum degree, qualification level, field of study, and/or institution ONLY if the posting states it as a hiring requirement; else null.
- NEVER put daily job tasks, responsibilities, client-facing duties, sales/account activities, or workflow descriptions in education.
- Mentally route lines that describe WHAT THE HIRE WILL DO day-to-day into a temporary "task buffer"; DISCARD that buffer from education, required_skills, and optional_skills unless a line names a concrete tool/stack/certification (then keep only the tool/stack token in skills, not the prose duty).
- If unsure whether a line is education vs task, prefer null for education and omit from skills.

- estimated_salary: raw salary phrase if present; else null.
- required_seniority: infer from level wording and years; unknown if unclear.

LOCATION & WORK MODEL (BE AGGRESSIVE):
- Scan the entire posting for cities, regions, countries, "based in", "office in", EMEA/APAC, etc. Populate job_location with the best single line (e.g. "London, UK" or "Remote — US only"). If ANY recognizable place or region appears, you MUST set job_location — do not leave null when geography is stated inline.
- If the text mentions a recognizable city or region name, you MUST put it in job_location. Do not leave location unspecified.
- work_model: Map explicit signals — "remote", "WFH", "work from home", "fully distributed" → remote; "hybrid", "2 days office" → hybrid; "on-site", "onsite", "in-office", "office-based", "in person" → on-site. If the text only implies office work without remote/hybrid wording, prefer on-site when an office location is given. Use "unknown" ONLY when there is truly no remote/hybrid/office signal at all.

JOB TYPE (job-board style):
- job_type: one of full-time, part-time, contract, temporary, volunteer, internship, unknown — infer from title, employment type, and body.

BENEFITS & COMMITMENTS:
- benefits: short English perk labels; [] if none.
- commitments: short English culture/value tags; [] if none.

CONSTRAINT CROSS-CHECK:
${constraintsBlock}

- Ignore company fluff unless it states a hard requirement.
- no markdown, no commentary, no extra keys.

JOB_TEXT:
${slice}`;

  if (strictLlm) {
    const data = await generateJsonWithOllamaStrict<EntityExtractionResult>(prompt, {
      model: ollamaModel,
      role: "analysis",
    });
    return {
      fields: sanitizeJobResult(data, fallbackFields),
      source: "llm",
    };
  }

  const llm = await generateJsonWithOllama<EntityExtractionResult>(
    prompt,
    jobFieldsToEntityFallback(fallbackFields),
    { model: ollamaModel, role: "analysis" },
  );

  return {
    fields: sanitizeJobResult(llm.data, fallbackFields),
    source: llm.source,
  };
}

export type ParseJobTextOptions = {
  /** When true (dashboard pipeline), Ollama failures throw instead of silently using keyword fallbacks for skills. */
  strictLlm?: boolean;
};

/**
 * Multi-stage job parse: clean artifacts → English-first heuristic (skip LLM prep when job+CV are high-confidence English) → entity extraction.
 */
export async function parseJobText(
  jobText: string,
  ollamaModel = DEFAULT_OLLAMA_MODEL,
  userConstraints: string[] = [],
  onStage?: (stage: "language_translate" | "entity_extraction") => void,
  cvPlainText?: string | null,
  options?: ParseJobTextOptions,
): Promise<JobParseResult> {
  const strictLlm = options?.strictLlm === true;
  const model = ollamaModel.trim() || DEFAULT_OLLAMA_MODEL;
  const cleaned = cleanJobArtifacts(jobText);
  const forTranslation = truncateJobForTranslation(
    cleaned,
    JOB_TEXT_LIMITS.truncateForTranslation,
  );
  const cvSample = typeof cvPlainText === "string" ? cvPlainText : "";
  const jobEnglish = isLikelyEnglishText(forTranslation);
  const cvEnglish = !cvSample.trim() || isLikelyEnglishText(cvSample);
  const translationSkipped = jobEnglish && cvEnglish;

  let langPrep: LangPrepResult;
  let langSource: ParserSource;
  if (translationSkipped) {
    langPrep = { is_english: true, job_text_for_extraction: forTranslation };
    langSource = "fallback";
  } else {
    onStage?.("language_translate");
    const lang = await stageLanguageAndTranslate(forTranslation, model, strictLlm);
    langPrep = lang.prep;
    langSource = lang.source;
  }
  const textForEntities = langPrep.job_text_for_extraction;

  onStage?.("entity_extraction");
  const { fields: extracted, source: entitySource } = await stageEntityExtraction(
    textForEntities,
    model,
    userConstraints,
    strictLlm,
  );

  if (strictLlm) {
    if (!translationSkipped && langSource === "fallback") {
      throw new Error("Ollama job language/translate stage failed (strict pipeline).");
    }
    if (entitySource === "fallback") {
      throw new Error("Ollama job entity extraction failed (strict pipeline).");
    }
  }

  const mergedFallback = keywordFallback(cleaned);
  const metaFallbackEn = keywordFallback(textForEntities);
  const finalRequired = strictLlm
    ? extracted.required_skills
    : extracted.required_skills.length > 0
      ? extracted.required_skills
      : mergedFallback.required_skills;
  const finalOptional = strictLlm
    ? extracted.optional_skills
    : extracted.optional_skills.length > 0
      ? extracted.optional_skills
      : mergedFallback.optional_skills;

  const parser_source: ParserSource =
    langSource === "llm" || entitySource === "llm" ? "llm" : "fallback";

  const pickWorkModel = (): WorkModel =>
    strictLlm
      ? extracted.work_model
      : extracted.work_model !== "unknown"
        ? extracted.work_model
        : metaFallbackEn.work_model;
  const pickJobType = (): JobTypeCategory =>
    strictLlm
      ? extracted.job_type
      : extracted.job_type !== "unknown"
        ? extracted.job_type
        : metaFallbackEn.job_type;

  return {
    required_skills: finalRequired,
    optional_skills: finalOptional.filter((s) => !finalRequired.includes(s)),
    estimated_salary: strictLlm
      ? extracted.estimated_salary
      : extracted.estimated_salary ?? mergedFallback.estimated_salary,
    required_seniority: extracted.required_seniority,
    experience_years: strictLlm
      ? extracted.experience_years
      : extracted.experience_years ?? mergedFallback.experience_years,
    education: strictLlm ? extracted.education : extracted.education ?? mergedFallback.education,
    job_location: strictLlm
      ? extracted.job_location
      : extracted.job_location ?? metaFallbackEn.job_location ?? mergedFallback.job_location,
    work_model: pickWorkModel(),
    job_type: pickJobType(),
    benefits: strictLlm
      ? extracted.benefits
      : extracted.benefits.length > 0
        ? extracted.benefits
        : metaFallbackEn.benefits.length > 0
          ? metaFallbackEn.benefits
          : mergedFallback.benefits,
    commitments: strictLlm
      ? extracted.commitments
      : extracted.commitments.length > 0
        ? extracted.commitments
        : metaFallbackEn.commitments.length > 0
          ? metaFallbackEn.commitments
          : mergedFallback.commitments,
    metadata_constraint_notes: extracted.metadata_constraint_notes,
    parser_source,
    english_job_text: textForEntities,
    translation_skipped: translationSkipped,
  };
}
