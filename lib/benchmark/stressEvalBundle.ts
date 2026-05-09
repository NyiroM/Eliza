// lib/benchmark/stressEvalBundle.ts
// Production-shaped semantic-fit stress context for Ollama tuning (fixtures + CV-derived pruned context).

import { CV_CONTEXT_LIMITS, JOB_TEXT_LIMITS, SEMANTIC_SCORER_PROMPT_LIMITS } from "../../config/constants";
import type { CvParseResult } from "../../types/cv";
import type { FitScoreResult } from "../../types/scoring";
import {
  buildSemanticFitScoreReviewPrompt,
  type BuildSemanticFitScoreReviewPromptParams,
} from "../prompts/semanticFitScoreReviewPrompt";
import { buildJobBoardMetadataForScorer, buildPrunedCvContext } from "../pipeline";
import { buildConstraintTacticHints, inferFallbackConstraintVetoWithTactics } from "../pipeline/constraintVetoTactics";
import {
  calculateFitScore,
  collectConstraintSignalHints,
  extractExperienceOverrideFromConstraints,
  validateExperienceRequirement,
} from "../scoring/fitScore";
import type { StoredConstraintTactics } from "../storage/constraintTactics";

const TECH_LEXICON = [
  "salesforce",
  "crm",
  "b2b",
  "account management",
  "negotiation",
  "pipeline",
  "forecasting",
  "technical sales",
  "solution selling",
  "rfp",
  "presales",
  "hvac",
  "filtration",
  "industrial equipment",
  "commissioning",
  "site survey",
  "stakeholder management",
  "presentation",
  "excel",
  "powerpoint",
  "sap",
  "erp",
  "supply chain",
  "lean",
  "six sigma",
  "project management",
  "contract review",
  "pricing",
  "margin",
  "channel partners",
  "distribution",
  "aftermarket",
  "service contracts",
  "kpi",
  "quota",
  "hunter",
  "farmer",
  "cross-sell",
  "upsell",
  "territory",
  "prospecting",
  "cold calling",
  "trade shows",
  "oem",
  "specification selling",
] as const;

/** Long Nilfisk-style listing + industrial noise (mirrors messy real job posts). */
export const STRESS_JOB_ENGLISH = `Nilfisk IVS — Sales Engineer (Szigetszentmiklós, Hungary). Full-time. Hybrid customer-facing role.

COMPANY: Nilfisk delivers industrial vacuum systems, dust/fume extraction, and air filtration for manufacturing, food, pharma, and logistics. You will sell engineered packages, not commodity SKUs: consultative discovery, ROI framing, pilot planning, and post-sale expansion.

ROLE: Own a territory around Budapest / Csepel / Dunakeszi industrial belt. Conduct technical site surveys, document dust classes and ATEX hints, coordinate with application engineers, and run disciplined Salesforce hygiene (opportunity stages, MEDDPICC notes, next-step dates). Expect travel to Italian Zocca Competence Center for product deep-dives (several days per quarter).

REQUIREMENTS (verbatim client tone): "We need someone who can translate airflow diagrams into purchase decisions." Demonstrated B2B capital equipment sales. Comfortable reading P&ID excerpts and mechanical datasheets. Hungarian + English business fluency. Driving license. No purely inside-sales profiles unless you can show repeated on-site closes above HUF 40M annually.

COMPENSATION & PROCESS: Base + variable; car allowance; benefits discussed after first onsite loop. Hiring manager notes: "Culture is direct — expect pushback in technical reviews."

REPEATED KEYWORDS FOR PARSING NOISE: Salesforce CRM Salesforce CRM. Site survey site survey. Zocca Zocca. Filtration filtration industrial vacuum industrial vacuum. Szigetszentmiklós Budapest logistics corridor.

FOOTER BOILERPLATE: EOE. GDPR applies. Agency submissions only with prior written mandate. Requisition IVS-HU-SE-2026-0412.`;

/** Benchmark provenance — Nilfisk IVS Sales Engineer (LinkedIn). */
export const STRESS_JOB_SOURCE_URL =
  "https://www.linkedin.com/jobs/view/ivs-sales-engineer-at-nilfisk-4369763700/";

/** Extra lossy scrape line mixed into JOB_MIX (legacy board HTML echo). */
export const STRESS_JOB_RAW_NOISE = `Original board HTML (lossy scrape): <div class="job">Nilfisk IVS Sales Engineer Szigetszentmiklós</div> ... buttons Apply EasyApply ... duplicate text: Industrial vacuum/filtration solutions, consultative B2B sales, technical site surveys, Zocca Competence Center visits, Salesforce CRM.`;

/**
 * Simulated lossy crawler payload (LinkedIn-style DOM + Profession.hu fragment + encoding glitches).
 * Intentionally messy: duplicate titles, geo mismatch line, sign-in chrome, list HTML not normalized, NBSP entities.
 * Real job copy is embedded verbatim-ish from the public listing (see STRESS_JOB_SOURCE_URL).
 */
const LINKEDIN_CRAWLER_RAW_BLOB = `<!-- saved from url=(${STRESS_JOB_SOURCE_URL}) -->
<div class="jobs-search-top-card__title-container">
  <h1 class="jobs-unified-top-card__job-title">IVS Sales Engineer</h1>
  <span class="jobs-unified-top-card__subtitle-primary-grouping">Nilfisk</span>
  <span class="tvm__text tvm__text--low-emphasis">11 hours ago</span>
</div>
<div class="jobs-unified-top-card__primary-description-container">
  <span class="jobs-unified-top-card__bullet">Szigetszentmiklós, Pest, Hungary</span>
  <span class="jobs-unified-top-card__bullet text-body-small">Be among the first 25 applicants</span>
</div>
<!-- GEO_TITLE_LEAK: edge POP sometimes injects US search context; do not treat as relocation -->
<span class="top-card-layout__entity-info">IVS Sales Engineer in Ashburn, VA</span>
<button type="button" data-tracking-control-name="public_jobs_apply-link-simple">Apply</button>
<a href="/signup/cold-join?session_redirect=${encodeURIComponent(STRESS_JOB_SOURCE_URL)}&trk=public_jobs_apply-link">Join or sign in to find your next job</a>
<div class="sign-in-modal__content">Email or phone  Password  Show  Forgot password?  Sign in</div>
<ul class="jobs-description__list jobs-description-content__list--items">
<li>Do you want to become an expert in delivering tailored industrial solutions that truly make a difference?</li>
<li>As an IVS Sales Engineer at Nilfisk, you’ll be at the forefront of bridging technical innovation with customer challenges. Based in anywhere in Hungary, you’ll drive long-cycle, consultative sales and help customers across a range of industries implement cutting-edge vacuum and filtration solutions. You’ll travel will be an essential component of this role, including regular visits to our IVS Competence Center in Zocca, Italy.</li>
<li>At Nilfisk, we believe in developing talent for the long term. If you're selected, you'll embark on a continuous learning journey designed to make you a subject matter expert in industrial vacuum solutions.</li>
</ul>
<p><strong>Essential Responsibilities</strong></p>
<ul><li>Visit industrial sites to assess production environments and design the right vacuum/filtration setup</li>
<li>Own the sales lifecycle: from lead generation and site surveys to proposal development, negotiation, and closing</li>
<li>Provide technical consultancy in close partnership with our global IVS Competence Center and internal stakeholders</li>
<li>Oversee solution implementation, including training, site acceptance, and after-sales support</li>
<li>Manage customer relationships with operations and production managers, and occasionally purchasing</li>
<li>Ensure accurate CRM tracking and project reporting</li>
<li>Proactively support strategic growth of the IVS segment across your region</li></ul>
<p><strong>Your New Team</strong></p>
<p>You’ll join a dynamic Specialty Business team focused on the IVS segment... Zocca as our core knowledge hub.</p>
<p><em>“Here, no day is the same—and the trust you’re given lets you shape projects from day one,”</em> shares a colleague from the IVS team in Italy.</p>
<p><strong>Qualifications To Succeed</strong></p>
<ul><li>Solid experience in industrial equipment sales or technical B2B consultancy</li>
<li>Previous experience in OEM, vacuum systems, dust extraction, or similar technology is a plus</li>
<li>Technical education (diploma or higher), or equivalent experience</li>
<li>Fluent in English and Hungarian</li>
<li>Skilled in CRM tools like Salesforce</li>
<li>Comfortable navigating long consultative sales cycles (6–12 months)</li>
<li>Willing and able to travel frequently across assigned region</li></ul>
<div class="jobs-description-content__text--stretch">Interested? If this sounds like your next step, we encourage you to apply with an English CV.</div>
<!-- duplicate block inserted by broken pagination crawler -->
<h1 class="jobs-unified-top-card__job-title">IVS Sales Engineer</h1>
<span>Nilfisk  Szigetszentmiklós, Pest, Hungary</span>
<script>window.__INITIAL_STATE__={"jobId":4369763700,"noise":true};</script>
<!-- Profession.hu mirror (charset glitch) -->
<div class="allashirdetes-cim">IVS Sales Engineer | Nilfisk | Pest</div>
<p>Szigetszentmikls, Hungary&nbsp;&nbsp;|&nbsp;Full-time&nbsp;|&nbsp;{{unclosed_template_fragment</p>
<div class="similar-jobs-carousel">Similar jobs: Regional Sales Manager — Pandora — Budapest ... HVAC Sales Engineer — IMI ... (carousel not expanded)</div>
`;

function buildCrawlerRealismJobLayers(scrapedListing: string): { jobTextEnglish: string; combinedJobText: string } {
  const scrapedBlock = scrapedListing.trim()
    ? `\n\n<!-- APP_SCRAPER_SECOND_SOURCE branch=linkedin_html_dump duplicate=true -->\n${scrapedListing.trim()}`
    : "";

  // Raw crawl + optional second scrape first so char limits often truncate the cleaner canonical tail (realistic stress).
  const jobTextChain = `${LINKEDIN_CRAWLER_RAW_BLOB}${scrapedBlock}\n\n--- CANONICAL_SUMMARY_FALLBACK ---\n${STRESS_JOB_ENGLISH}`;
  const jobTextEnglish = jobTextChain.slice(0, SEMANTIC_SCORER_PROMPT_LIMITS.jobTextChars);

  const professionHuMirror = `Profession.hu lossy fragment: <table><tr><td>Nilfisk</td><td>IVS Sales Engineer</td><td>Pest</td></tr></table> encoding=windows-1252?? Szigetszentmikls\n`;
  const combinedJobText = `${professionHuMirror}${LINKEDIN_CRAWLER_RAW_BLOB}\n${STRESS_JOB_RAW_NOISE}${scrapedBlock}\n${STRESS_JOB_ENGLISH}\n<!-- JOB_TEXT_REPEAT_FOR_MIX -->\n${jobTextEnglish.slice(0, 2800)}`
    .slice(0, JOB_TEXT_LIMITS.combinedJobForScoring);

  return { jobTextEnglish, combinedJobText };
}

export const STRESS_CONSTRAINTS: string[] = [
  "I want roles where I work with people — not solitary field roles unless the JD explicitly promises a team pod structure.",
  "Exclude pure software engineering or data-science-only IC tracks; I am targeting customer-facing technical sales or applications engineering with quota.",
  "I do not want fully remote-only roles; hybrid with weekly Budapest-area presence or onsite in Szigetszentmiklós is acceptable.",
  "Benefits transparency matters: if the posting hides health insurance / car policy entirely, treat that as a negative signal in vibe_warnings (do not invent numbers).",
  "I have 8+ years quota-carrying experience — use that as my experience anchor when comparing to JOB_STRUCT.experience_years.",
  "I dislike vague 'competitive salary' with zero structure; call that out if present.",
  "If the job requires relocation outside Hungary, soft-penalize via constraint_delta unless CONSTRAINT_TACTICS say otherwise.",
  "Language: I will not take a role that requires native German as primary external language; English + Hungarian is my working set.",
  "Travel: quarterly Italy trips are acceptable; monthly intercontinental is not.",
  "I will not sell regulated medical devices without clinical support structure — flag if the JD drifts into clinical devices without support roles listed.",
];

export const STRESS_USER_CORRECTIONS_APPEND = `USER_CORRECTIONS_REGISTER (absolute truth — override any conflicting inference):

- Treat "Sales Engineer" in industrial cleaning / vacuum context as capital equipment B2B sales, not retail store sales.
- The candidate's "CRM" mentions may refer to HubSpot historically; map mentally to Salesforce only if CV explicitly says Salesforce.
- Hungary / Budapest commute assumptions: candidate lives within 45km of Budapest unless CV states otherwise.
- If JOB_TEXT contradicts JOB_METADATA.work_model, prefer JOB_TEXT for narrative but cite both in mathematical_breakdown line 4.
- Never invent certifications; if CV does not list ATEX, do not claim ATEX training.
- If baseline lists a skill as matched but CV_PRUNED lacks any substring support, you may move it to missing_skills with justification (counts toward the ±2 edit budget).`;

export const STRESS_SYNONYM_PAIRS: Array<{ canonical: string; aliases: string[] }> = [
  { canonical: "salesforce", aliases: ["sfdc", "sales cloud", "crm"] },
  { canonical: "b2b sales", aliases: ["enterprise sales", "field sales"] },
  { canonical: "technical sales", aliases: ["presales", "solution consultant"] },
  { canonical: "hvac", aliases: ["ventilation", "air handling"] },
  { canonical: "filtration", aliases: ["dust collection", "fume extraction"] },
  { canonical: "site survey", aliases: ["site audit", "walkdown"] },
  { canonical: "negotiation", aliases: ["deal shaping", "commercial terms"] },
];

export const STRESS_TACTICS: StoredConstraintTactics = {
  tactics: {
    location: "strong_preference",
    remote_zone: "default",
    compensation: "strong_preference",
  },
  updated_at: new Date().toISOString(),
};

const STRESS_JOB_STRUCT = {
  required_skills: [
    "b2b sales",
    "technical sales",
    "site survey",
    "salesforce crm",
    "hungarian",
    "english",
    "industrial equipment",
    "driving license",
  ],
  optional_skills: [
    "atex awareness",
    "filtration",
    "account management",
    "channel partners",
    "p&id reading",
    "capital equipment",
    "forecasting",
    "presentation skills",
  ],
  required_seniority: "mid" as const,
  experience_years: 4,
  education: "bachelor degree or equivalent experience",
};

const STRESS_JOB_BOARD_META = {
  job_location: "Szigetszentmiklós, Hungary (hybrid; Budapest-area travel)",
  work_model: "hybrid",
  job_type: "full_time",
  benefits: ["health insurance (details after onsite)", "car allowance mentioned", "variable pay"],
  commitments: ["quarterly travel to Zocca Competence Center (Italy)", "on-site customer surveys"],
  metadata_constraint_notes: [
    "Posting duplicates Salesforce keyword blocks — parsing noise likely.",
    "Compensation section is thin vs role seniority.",
    "Crawler realism: JOB_TEXT/JOB_MIX may contain HTML, duplicate titles, geo mismatch lines (e.g. Ashburn vs Hungary), sign-in chrome, Profession.hu charset glitches, carousel junk — infer canonical facts conservatively.",
  ],
};

function inferCvParseFromRaw(raw: string): CvParseResult {
  const lower = raw.toLowerCase();
  const fromLex = [...TECH_LEXICON].filter((t) => lower.includes(t.toLowerCase()));
  const extra = ["relationship building", "client discovery", "workshop facilitation"].filter((t) =>
    lower.includes(t),
  );
  const skills = [...new Set([...fromLex, ...extra])].slice(0, CV_CONTEXT_LIMITS.prunedSkillsMax);
  const chunks = raw
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter((s) => s.length > 80);
  const core_stories =
    chunks.length > 0
      ? chunks.slice(0, CV_CONTEXT_LIMITS.coreStoriesMax)
      : [
          "Led retrofit campaign for a regional distributor: qualified technical risk, coordinated two pilot installs, closed multi-year service attach.",
          "Built territory plan reconciling CRM hygiene with channel conflict rules; reduced stale opps by 38% QoQ.",
        ];
  return {
    skills: skills.length > 0 ? skills : ["b2b sales", "crm", "presentation", "negotiation", "project coordination"],
    seniority_level: "senior",
    core_stories,
    parser_source: "llm",
  };
}

function buildStressAppendix(missingRequired: string[], cvSlice: string): string {
  const missing = [...new Set(missingRequired.map((s) => s.trim().toLowerCase()))].filter(Boolean).slice(0, 14);
  return `

---
STRESS_APPENDIX (production-adjacent noise — follow internally; output must remain a single JSON object only):

EVIDENCE_PASS_MIRROR (same shape as cvEvidencePass): return STRICT mental checklist before JSON — do not print this checklist.
Required JSON keys if you were answering the evidence pass alone would have been: {"evidence_rationale":string,"confirmed_skills":string[]}
MISSING_REQUIRED: ${JSON.stringify(missing)}
Rules: confirmed_skills must be subset of MISSING_REQUIRED; only skills clearly stated in CV_TEXT slice.
CV_TEXT_SLICE_FOR_EVIDENCE_PASS:
${cvSlice.slice(0, 12_000)}

INTERNAL_WORKBOOK (do not output as prose): Step A — tabulate CONSTRAINTS vs JOB_STRUCT conflicts. Step B — reconcile BASELINE m/m edits vs JOB_TEXT spans (max 2 adds / 2 drops each list); JOB_TEXT may be crawler-noisy (HTML, duplicate headings) — quote short visible substrings, not raw tags. Step C — choose score_components so clamped sum matches fit_score and line 7 of mathematical_breakdown. Step D — emit semantic_highlights with phrases copied exactly from visible JOB_TEXT (strip angle-bracket markup mentally). Then output the one JSON object specified in the main task.`;
}

export type StressEvalBundle = {
  userPrompt: string;
  correctionsBlock: string;
  baseline: FitScoreResult;
  /** Pass to \`parseSemanticFitReviewPayload\` third argument. */
  offlineVeto: { vetoed: boolean; veto_reason: string | null };
  /** For logging / tuning_results. */
  promptCharCount: number;
};

export type BuildStressEvalBundleOpts = {
  /**
   * Noisy scraped listing (e.g. LinkedIn HTML-ish text) merged into JOB_TEXT / JOB_MIX
   * to mirror real discovery + pipeline inputs.
   */
  scrapedJobListing?: string;
};

/**
 * Builds the same semantic-fit user prompt shape as production, plus appendix mirroring cvEvidencePass + internal workbook noise.
 */
export function buildStressEvalBundle(rawCvText: string, opts?: BuildStressEvalBundleOpts): StressEvalBundle {
  const scraped = opts?.scrapedJobListing?.trim() ?? "";
  const { jobTextEnglish, combinedJobText } = buildCrawlerRealismJobLayers(scraped);

  const cvParsed = inferCvParseFromRaw(rawCvText);
  const prunedCv = buildPrunedCvContext(rawCvText, cvParsed);
  const jobBoardMetadata = buildJobBoardMetadataForScorer(STRESS_JOB_BOARD_META, STRESS_CONSTRAINTS);
  const experienceYearsForScoring = validateExperienceRequirement(
    STRESS_JOB_STRUCT.experience_years,
    combinedJobText,
  );
  const userExperienceOverride = extractExperienceOverrideFromConstraints(STRESS_CONSTRAINTS) ?? 8;
  const userProfileBlob = [
    ...cvParsed.skills,
    cvParsed.seniority_level,
    ...(cvParsed.core_stories ?? []),
    prunedCv,
  ]
    .join(" ")
    .slice(0, CV_CONTEXT_LIMITS.userProfileJoinMax);

  const baseline = calculateFitScore(
    cvParsed.skills,
    STRESS_JOB_STRUCT.required_skills,
    STRESS_JOB_STRUCT.optional_skills,
    cvParsed.seniority_level,
    STRESS_JOB_STRUCT.required_seniority,
    {
      experience_years: experienceYearsForScoring,
      education: STRESS_JOB_STRUCT.education,
    },
    userProfileBlob,
    userExperienceOverride,
  );

  const constraintHints = [
    ...buildConstraintTacticHints(STRESS_TACTICS),
    ...collectConstraintSignalHints(STRESS_CONSTRAINTS, combinedJobText),
  ];

  const skillSynonymsPromptJson = JSON.stringify(STRESS_SYNONYM_PAIRS).slice(0, 1500);

  const params: BuildSemanticFitScoreReviewPromptParams = {
    constraints: STRESS_CONSTRAINTS,
    preferredLocation: "Budapest metropolitan area — weekly office or customer days acceptable; avoid listings that are de-facto relocation to Western Europe without relocation package.",
    jobTextEnglish,
    combinedJobText,
    jobBoardMetadata,
    jobStructForScorer: STRESS_JOB_STRUCT,
    cvSkills: cvParsed.skills,
    coreStories: cvParsed.core_stories ?? [],
    cvSnippet: prunedCv,
    baseline,
    constraintHints,
    tactics: STRESS_TACTICS,
    skillSynonymsPromptJson,
  };

  const corePrompt = buildSemanticFitScoreReviewPrompt(params);
  const appendix = buildStressAppendix(baseline.missing_skills, rawCvText);
  const userPrompt = `${corePrompt}${appendix}`;
  const offlineVeto = inferFallbackConstraintVetoWithTactics(
    STRESS_CONSTRAINTS,
    typeof jobBoardMetadata.job_location === "string" ? (jobBoardMetadata.job_location as string) : null,
    jobTextEnglish,
    STRESS_TACTICS,
  );

  return {
    userPrompt,
    correctionsBlock: STRESS_USER_CORRECTIONS_APPEND,
    baseline,
    offlineVeto,
    promptCharCount: userPrompt.length,
  };
}
