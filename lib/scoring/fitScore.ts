import type { FitScoreResult, JobScoringEntities } from "../../types/scoring";

export type { FitScoreResult, JobScoringEntities } from "../../types/scoring";

type SeniorityLevel = "junior" | "mid" | "senior" | "lead" | "unknown";

const SENIORITY_RANK: Record<SeniorityLevel, number> = {
  unknown: 0,
  junior: 1,
  mid: 2,
  senior: 3,
  lead: 4,
};

/** Max "X years" style number found in free text (CV blob). */
function extractMaxYearsFromProfile(profileLower: string): number | null {
  const re = /(\d+)\+?\s*(?:years?|yrs?)/gi;
  let best = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(profileLower)) !== null) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) best = Math.max(best, n);
  }
  return best > 0 ? best : null;
}

export function extractExperienceOverrideFromConstraints(
  constraints: string[],
): number | null {
  for (const constraint of constraints) {
    const lowered = constraint.toLowerCase();
    const match = lowered.match(/(\d+)\+?\s*(?:years?|yrs?)/i);
    if (!match) {
      continue;
    }
    if (
      lowered.includes("i have") ||
      lowered.includes("i actually have") ||
      lowered.includes("my experience") ||
      lowered.includes("experience is")
    ) {
      const years = Number.parseInt(match[1], 10);
      if (!Number.isNaN(years) && years >= 0 && years <= 60) {
        return years;
      }
    }
  }
  return null;
}

function isPmRoleJob(jobText: string): boolean {
  const t = jobText.toLowerCase();
  return (
    t.includes("project manager") ||
    t.includes("product manager") ||
    t.includes("program manager") ||
    t.includes("pm role") ||
    /\bpm\b/.test(t)
  );
}

function hasNoPmConstraint(constraints: string[]): boolean {
  return constraints.some((constraint) => {
    const t = constraint.toLowerCase();
    return (
      t.includes("no pm") ||
      t.includes("don't want pm") ||
      t.includes("do not want pm") ||
      t.includes("no project manager") ||
      t.includes("i dont want pm")
    );
  });
}

/**
 * Non-scoring signals for the semantic scoring LLM (no point values — hints only).
 */
export function collectConstraintSignalHints(constraints: string[], jobText: string): string[] {
  const hints: string[] = [];
  const jt = jobText.toLowerCase();

  if (hasNoPmConstraint(constraints) && isPmRoleJob(jobText)) {
    hints.push(
      "User constraints mention avoiding PM / project or product manager roles; job text may describe a PM-type role.",
    );
  }

  const hasDogDislikeConstraint = constraints.some((constraint) => {
    const t = constraint.toLowerCase();
    return (
      t.includes("don't like dogs") ||
      t.includes("do not like dogs") ||
      t.includes("no dogs") ||
      t.includes("allergic to dogs") ||
      t.includes("not a dog person")
    );
  });
  const isDogFriendlyRole = /dog[-\s]?friendly|pets?\s+(?:welcome|allowed)|bring your dog/i.test(jobText);
  if (hasDogDislikeConstraint && isDogFriendlyRole) {
    hints.push(
      "User dislikes dog-friendly workplaces; job mentions a dog-friendly environment.",
    );
  }

  if (constraints.length > 0) {
    hints.push(
      "Apply saved user constraints strictly when judging veto, location, work model, job type, and benefits fit.",
    );
  }

  if (hints.length === 0 && constraints.length > 0) {
    hints.push("Review all user constraints against job text and structured metadata.");
  }

  return hints;
}

export function validateExperienceRequirement(
  extractedExperienceYears: number | null,
  jobText: string,
): number | null {
  if (extractedExperienceYears == null) {
    return null;
  }
  if (extractedExperienceYears <= 15) {
    return extractedExperienceYears;
  }

  const text = jobText.toLowerCase();
  const companyContext = [
    "years on the market",
    "we have been in business",
    "our company",
    "founded in",
    "established in",
  ];
  const requirementContext = [
    "required",
    "minimum",
    "at least",
    "must have",
    "experience required",
    "years of experience",
  ];

  const nearExperienceWords = /(\d+)\+?\s*(?:years?|yrs?)/i.test(text);
  const hasCompanySignal = companyContext.some((s) => text.includes(s));
  const hasRequirementSignal = requirementContext.some((s) => text.includes(s));

  if (nearExperienceWords && hasRequirementSignal && !hasCompanySignal) {
    return extractedExperienceYears;
  }

  return null;
}

/**
 * Flexible entity match: exact token in skills set, substring in profile blob,
 * or majority of significant tokens from multi-word requirements.
 */
function entityMatchesProfile(
  entity: string,
  userSkillsLower: string[],
  profileBlob: string,
): boolean {
  const e = entity.toLowerCase().trim();
  if (!e) return false;

  const skillSet = new Set(userSkillsLower);
  if (skillSet.has(e)) return true;
  if (profileBlob.includes(e)) return true;

  const tokens = e
    .split(/[^a-z0-9+.#/]+/i)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);

  if (tokens.length === 0) return false;
  if (tokens.length === 1) {
    return (
      profileBlob.includes(tokens[0]) ||
      userSkillsLower.some((s) => s.includes(tokens[0]) || tokens[0].includes(s))
    );
  }

  const hits = tokens.filter(
    (t) =>
      profileBlob.includes(t) ||
      userSkillsLower.some((s) => s === t || s.includes(t) || t.includes(s)),
  );
  return hits.length >= Math.ceil(tokens.length * 0.5);
}

function educationMatchesProfile(education: string | null, profileBlob: string): boolean {
  if (!education) return false;
  const ed = education.toLowerCase().trim();
  if (ed.length < 4) return profileBlob.includes(ed);
  const parts = ed.split(/\s+/).filter((w) => w.length > 3);
  if (parts.length === 0) return profileBlob.includes(ed);
  return parts.filter((p) => profileBlob.includes(p)).length >= Math.ceil(parts.length * 0.6);
}

export function calculateFitScore(
  userSkills: string[],
  requiredSkills: string[],
  optionalSkills: string[],
  userSeniority: SeniorityLevel,
  requiredSeniority: SeniorityLevel,
  jobEntities: JobScoringEntities,
  userProfileText: string,
  userExperienceOverrideYears: number | null,
): FitScoreResult {
  const profileBlob = userProfileText.toLowerCase();
  const userSkillsLower = userSkills.map((s) => s.toLowerCase());

  const required = requiredSkills.map((s) => s.trim()).filter(Boolean);
  const optional = optionalSkills.map((s) => s.trim()).filter(Boolean);

  const matchedRequired = required.filter((skill) =>
    entityMatchesProfile(skill, userSkillsLower, profileBlob),
  );
  const matchedOptional = optional.filter((skill) =>
    entityMatchesProfile(skill, userSkillsLower, profileBlob),
  );
  const missing = required.filter(
    (skill) => !entityMatchesProfile(skill, userSkillsLower, profileBlob),
  );

  const requiredScore = required.length === 0 ? 0 : matchedRequired.length / required.length;
  const optionalScore = optional.length === 0 ? 0 : matchedOptional.length / optional.length;

  // MVP weighting: 80% required entities, 20% optional entities.
  let fit = Math.round((requiredScore * 0.8 + optionalScore * 0.2) * 100);

  const seniorityMatch =
    requiredSeniority === "unknown" ||
    userSeniority === "unknown" ||
    SENIORITY_RANK[userSeniority] >= SENIORITY_RANK[requiredSeniority];

  if (!seniorityMatch) {
    fit = Math.max(0, fit - 25);
  }

  // Experience / education signals from job entities vs CV text (soft nudges).
  if (jobEntities.experience_years != null && jobEntities.experience_years > 0) {
    const userYears = userExperienceOverrideYears ?? extractMaxYearsFromProfile(profileBlob);
    if (userYears != null) {
      if (userYears >= jobEntities.experience_years) {
        fit = Math.min(100, fit + 5);
      } else {
        fit = Math.max(0, fit - 5);
      }
    }
  }

  if (educationMatchesProfile(jobEntities.education, profileBlob)) {
    fit = Math.min(100, fit + 3);
  }

  const matchedAll = Array.from(
    new Set([...matchedRequired, ...matchedOptional].map((s) => s.toLowerCase())),
  ).sort();

  return {
    fit_score: fit,
    matched_skills: matchedAll,
    missing_skills: Array.from(new Set(missing)).sort(),
    seniority_match: seniorityMatch,
  };
}
