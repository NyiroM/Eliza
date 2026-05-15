import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import type { JobParseResult } from '../types/job';
import type { SalaryForecastCurrency, SalaryForecastDisplay } from '../types/pipeline';
import { generateJsonWithOllamaStrict } from './llm/ollama';
import { buildSalaryForecastDisplay } from './salaryForecastDisplay';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
// Hays HU 2026 dataset, enriched with aliases / search_vector / inferred_skill_tags /
// skill_premium_multiplier / market_heat etc. (April 2026 HU market reference).
const dataPath = path.join(repoRoot, 'data', 'salary', 'hays-hu-2026-enriched-v4.json');

// Salary thresholds (HUF monthly)
const SALARY_FLOOR_DEFAULT = 1_000_000;
const BAND_BELOW_PCT = 0.15; // 15% below floor => below_limit
const BAND_UPPER_PCT = 0.10; // within 10% of floor => borderline
const HIGH_NOMINAL_CURRENCIES = new Set(['HUF', 'JPY']);
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: 'EUR',
  GBP: 'GBP',
  HUF: 'HUF',
  PLN: 'PLN',
  JPY: 'JPY',
};
const CURRENCY_HINTS: Array<{ code: string; pattern: RegExp }> = [
  { code: 'USD', pattern: /\bUSD\b|\$/i },
  { code: 'EUR', pattern: /\bEUR\b|€/i },
  { code: 'GBP', pattern: /\bGBP\b|£/i },
  { code: 'HUF', pattern: /\bHUF\b|\bFT\b|\bFORINT\b/i },
  { code: 'PLN', pattern: /\bPLN\b|\bZLOTY\b|\bZL\b/i },
  { code: 'JPY', pattern: /\bJPY\b|¥/i },
];
const SALARY_PROXIMITY_KEYWORDS = new Set([
  'salary',
  'payment',
  'huf',
  'eur',
  'usd',
  'pln',
  'gbp',
  'jpy',
  'gross',
  'net',
  'pay',
  'compensation',
  'package',
  'hour',
  'hourly',
  'ft',
  'monthly',
  'month',
]);
const NON_SALARY_EXCLUSION_KEYWORDS = new Set([
  'employees',
  'employee',
  'people',
  'staff',
  'countries',
  'country',
  'years',
  'year',
  'experience',
  'sqm',
  'meters',
  'meter',
]);

type CurrencyCode = 'USD' | 'EUR' | 'GBP' | 'HUF' | 'PLN' | 'JPY';
type SalarySource = 'posted' | 'market_benchmark';
type SalaryBasis = 'gross' | 'net';

/**
 * One benchmark band from `data/salary/hays-hu-2026-enriched-v4.json` (Hays HU 2026, enriched).
 * Core fields (`hays_label` / `seniority` / `min` / `max` / `modus` / `day_rate`) match the
 * original Hays schema; enriched fields are all optional so fixture rows and the legacy JSON
 * still parse without changes.
 */
export type HaysBenchmarkRow = {
  industry?: string;
  hays_label: string;
  seniority: string;
  min: number;
  max: number;
  modus: number;
  day_rate?: number | null;
  // ---- enriched v4 fields (all optional) ----
  /** Short role label without "Fejezet › alcím" prefix (e.g. "AI Engineer"). */
  role?: string;
  /** Hays "function" / column (e.g. "AI/ML", "Data", "Folyamatfejlesztés"). */
  function?: string;
  /** Coarse-grained family bucket (e.g. "data_ai", "it_support", "finance_accounting"). */
  job_family?: string;
  /** Lowercase ASCII synonyms / shorthand for the role (used for fuzzy title matching). */
  aliases?: string[];
  /** Diacritic-preserving aliases ("ai engineer", "machine learning engineer", …). */
  search_aliases?: string[];
  /** Token-style search vector ("ai", "engineer", "ai engineer", …). */
  search_vector?: string[];
  /** Lowercase short skill tags ("ai", "cloud", "sap", "python", …). */
  inferred_skill_tags?: string[];
  /** 2026 HU market heat for the role. */
  market_heat?: 'very_hot' | 'hot' | 'stable_hot' | 'stable' | string;
  /** Qualitative confidence in the salary band itself. */
  market_confidence?: 'high' | 'medium' | 'low' | 'estimated' | string;
  /** Per-row confidence score (0..1) used to dampen overall confidence. */
  confidence_score?: number;
  /** Multiplicative premium when role's hot skills (inferred_skill_tags) match the job's tech stack. */
  skill_premium_multiplier?: number;
  /** Precomputed monthly HUF estimate when hot-skills premium applies. */
  estimated_market_value_if_hot_skills?: number;
  min_experience_years?: number | null;
  max_experience_years?: number | null;
  /** Numeric seniority (Junior=1 … Lead=4) — mirrors `seniority`. */
  seniority_score?: number;
  /** Remote suitability tag (e.g. "hybrid_or_remote_possible"). */
  remote_friendly?: string;
  /** Expected working languages (e.g. ["hungarian", "english"]). */
  expected_languages?: string[];
  /** Midpoint of min/max (HUF gross monthly). */
  salary_midpoint?: number;
  /** Modus + typical bonus/benefits (HUF gross monthly). */
  estimated_total_comp_monthly?: number;
  /** Percentile bucket label ("premium" / "upper_mid_market" / "mid_market" / "lower_market"). */
  salary_percentile?: string;
};

/** Optional wrapper shape used by the enriched v4 dataset. */
type EnrichedDatasetFile = {
  _dataset_metadata?: Record<string, unknown>;
  records?: unknown[];
};
const TO_HUF_RATE: Record<CurrencyCode, number> = {
  HUF: 1,
  EUR: 400,
  GBP: 470,
  USD: 360,
  PLN: 93,
  JPY: 2.5,
};

/** Parse minimum salary floor from user constraints (HUF). */
export const parseMinSalaryHufFromConstraints = (constraints: string[]): number => {
  const parsed = parseSalaryFloorFromConstraints(constraints, 'HUF');
  return parsed.amount;
};

function normalizeCurrency(raw: string | null | undefined): CurrencyCode | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  if (upper in CURRENCY_SYMBOLS) return upper as CurrencyCode;
  for (const hint of CURRENCY_HINTS) {
    if (hint.pattern.test(raw)) return hint.code as CurrencyCode;
  }
  return null;
}

export function convertCurrency(amount: number, from: CurrencyCode, to: CurrencyCode): number {
  if (!Number.isFinite(amount)) return amount;
  if (from === to) return amount;
  const hufValue = amount * TO_HUF_RATE[from];
  return Math.round(hufValue / TO_HUF_RATE[to]);
}

function getExchangeRateUsed(from: CurrencyCode, to: CurrencyCode): string | undefined {
  if (from === to) return undefined;
  const rate = TO_HUF_RATE[from] / TO_HUF_RATE[to];
  const formattedRate =
    rate >= 100
      ? Math.round(rate).toLocaleString('en-US')
      : rate >= 1
        ? rate.toFixed(2).replace(/\.00$/, '')
        : rate.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `1 ${from} = ${formattedRate} ${to}`;
}

function detectCurrency(jobText: string, preferredCurrency?: string | null): CurrencyCode {
  const preferred = normalizeCurrency(preferredCurrency);
  if (preferred) return preferred;
  for (const hint of CURRENCY_HINTS) {
    if (hint.pattern.test(jobText)) return hint.code as CurrencyCode;
  }
  return 'HUF';
}

function parseSalaryFloorFromConstraints(
  constraints: string[],
  fallbackCurrency: CurrencyCode,
): { amount: number; currency: CurrencyCode } {
  if (!Array.isArray(constraints) || constraints.length === 0) {
    return {
      amount:
        fallbackCurrency === 'HUF'
          ? SALARY_FLOOR_DEFAULT
          : convertCurrency(SALARY_FLOOR_DEFAULT, 'HUF', fallbackCurrency),
      currency: fallbackCurrency,
    };
  }
  const joined = constraints.join(' ');
  const re =
    /(?:(USD|EUR|GBP|HUF|PLN|JPY|[$€£¥])\s*)?(\d{1,3}(?:[\s.,]\d{3})+|\d{4,9})(?:\s*(USD|EUR|GBP|HUF|PLN|JPY|[$€£¥]))?/gi;

  const minIntentHints = /\b(minimum|min\.?|at\s+least|>=|floor|salary|compensation|gross|net|monthly|month|\/\s*day|per\s+day|daily|days?)\b/i;
  const hardNoiseHints = /\b(202[0-9]|employees?|countries?|years?)\b/i;

  let best: { amount: number; currency: CurrencyCode; score: number } | null = null;

  for (const m of joined.matchAll(re)) {
    const amount = parseSmartNumber(m[2]);
    if (!amount || amount < 100) continue;
    const curr = normalizeCurrency(m[1] ?? m[3]) ?? fallbackCurrency;

    // Ignore obvious non-salary artifacts (years, employee counts) when context gives it away.
    const idx = typeof m.index === 'number' ? m.index : -1;
    const before = idx >= 0 ? joined.slice(Math.max(0, idx - 120), idx) : '';
    const after = idx >= 0 ? joined.slice(idx, Math.min(joined.length, idx + 120)) : '';
    const window = `${before} ${after}`;
    if (hardNoiseHints.test(window) && !minIntentHints.test(window)) continue;

    // Per-currency plausibility guardrails (avoid picking random small numbers from other constraints).
    if (curr === 'HUF' && amount < 200_000) continue;
    if (curr !== 'HUF' && amount < 800) continue;

    let score = 0;
    if (minIntentHints.test(window)) score += 5;
    if (/\bminimum\b/i.test(window)) score += 3;
    if (/\b(gross|net)\b/i.test(window)) score += 1;
    if (/\b(monthly|month)\b/i.test(window)) score += 1;
    if (/\b(HUF|FT|FORINT)\b/i.test(window) && curr === 'HUF') score += 1;

    // Prefer larger floors when intent looks like “minimum salary”.
    const nominal = curr === 'HUF' ? amount / 100_000 : amount / 1_000;
    score += Math.min(3, Math.max(0, Math.log10(Math.max(1, nominal))));

    if (!best || score > best.score || (score === best.score && amount > best.amount)) {
      best = { amount, currency: curr, score };
    }
  }

  if (best) {
    return { amount: best.amount, currency: best.currency };
  }

  return {
    amount:
      fallbackCurrency === 'HUF'
        ? SALARY_FLOOR_DEFAULT
        : convertCurrency(SALARY_FLOOR_DEFAULT, 'HUF', fallbackCurrency),
    currency: fallbackCurrency,
  };
}

function detectSalaryBasis(text: string): SalaryBasis {
  return /\bnet(?:to)?\b/i.test(text) ? 'net' : 'gross';
}

function constraintSalaryBasis(constraints: string[]): SalaryBasis {
  return detectSalaryBasis(constraints.join(' '));
}

function estimateNetFromGross(grossValue: number, currency: CurrencyCode, jobText: string): number {
  const likelyHungary = currency === 'HUF' || /\bhungary|budapest|forint\b/i.test(jobText);
  const factor = likelyHungary ? 0.66 : 0.7;
  return Math.round(grossValue * factor);
}

function detectBonusMention(text: string): boolean {
  return /\b(bonus|commission|incentive|performance-based|annual bonus|13th month)\b/i.test(text);
}

function detectBenefitsValue(text: string): string | null {
  const hits: string[] = [];
  if (/\bcafeteria system|cafeteria\b/i.test(text)) hits.push('cafeteria');
  if (/\bflexible benefits\b/i.test(text)) hits.push('flexible benefits');
  if (/\bperks?\b/i.test(text)) hits.push('perks');
  if (/\bstipend\b/i.test(text)) hits.push('stipend');
  if (/\bequity|stock options?\b/i.test(text)) hits.push('equity');
  if (/\bhealth insurance|medical insurance\b/i.test(text)) hits.push('health insurance');
  return hits.length > 0 ? [...new Set(hits)].join(', ') : null;
}

function hasBaseSalaryMarker(text: string): boolean {
  return /\b(base payment|fixed salary|monthly)\b/i.test(text);
}

function parseSmartNumber(raw: string): number | null {
  const cleaned = raw.replace(/\s/g, '').trim();
  if (!cleaned) return null;
  const decimalTailMatch = cleaned.match(/[.,](\d{2})$/);
  if (decimalTailMatch) {
    const intPart = cleaned.slice(0, -3).replace(/[.,]/g, '');
    const fractionalPart = cleaned.slice(-2);
    const normalized = `${intPart}.${fractionalPart}`;
    const value = Number.parseFloat(normalized);
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  const integerOnly = cleaned.replace(/[.,]/g, '');
  const value = Number.parseInt(integerOnly, 10);
  return Number.isFinite(value) ? value : null;
}

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9/+-]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** ASCII-ish fold for matching Hungarian salary tokens (tokenizeWords drops non-[a-z] letters). */
function stripDiacritics(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * Raw-window salary context: catches órabér / fizetés / bruttó etc. that `tokenizeWords` would shred.
 */
function hasSalaryContextInRawWindow(beforeText: string, afterText: string): boolean {
  const raw = stripDiacritics(`${beforeText} ${afterText}`).toLowerCase();
  return (
    /\b(salary|payment|pay|compensation|package|gross|net|hourly|per\s+hour|huf|forint)\b/.test(raw) ||
    /\b(ft)\b/.test(raw) ||
    /\b(oraber|oradij|orankent|fizetes|berezes|ber\b|juttatas|brutto|netto|havi|havonta|napi|heti)\b/.test(raw) ||
    /\b(ft|huf)\s*[\/:]\s*ora\b/.test(raw) ||
    /\bora\s*[\/:]\s*\d/.test(raw)
  );
}

function hasSalaryKeywordWithinWindow(beforeText: string, afterText: string, windowWords = 10): boolean {
  if (hasSalaryContextInRawWindow(beforeText, afterText)) return true;
  const beforeWords = tokenizeWords(beforeText).slice(-windowWords);
  const afterWords = tokenizeWords(afterText).slice(0, windowWords);
  const window = [...beforeWords, ...afterWords];
  return window.some((w) => SALARY_PROXIMITY_KEYWORDS.has(w));
}

function hasExcludedContext(text: string): boolean {
  const words = tokenizeWords(text);
  return words.some((w) => NON_SALARY_EXCLUSION_KEYWORDS.has(w));
}

function hasDayRateHint(text: string): boolean {
  return /(?:\/\s*day|per\s+day|daily|day-rate|contracting|napi)/i.test(text);
}

/** Posting states gross pay per clock hour (vs per month). */
function hasHourlyRateHint(text: string): boolean {
  const s = text.toLowerCase();
  const a = stripDiacritics(text).toLowerCase();
  return (
    /\b(per\s+hour|hourly|hour\s+rate|\/\s*h\b|\/\s*hr\b)\b/i.test(s) ||
    /órabér|óradíj|óránként/i.test(text) ||
    /\b(oraber|oradij|orankent|ber\/ora|ft\/ora|huf\/ora)\b/.test(a) ||
    /(?:per\s+óra|\/\s*óra|óra\s*:\s*\d)/i.test(text) ||
    /\b\d[\d\s.,]{0,14}\s*(?:ft|huf|forint)\s*\/\s*óra?\b/i.test(s) ||
    /\b(?:ft|huf|forint)\s*\/\s*óra?\b/i.test(s)
  );
}

function hasYearRateHint(text: string): boolean {
  return /(?:\/\s*year|per\s+year|yearly|annual(?:ly)?|\/\s*yr|per\s+annum|p\.?a\.?)/i.test(text);
}

function hasMonthRateHint(text: string): boolean {
  return /(?:\/\s*month|per\s+month|monthly|\/\s*mo|\bhavi\b|\bhavonta\b)/i.test(text);
}

function isFullTimeOrContingent(jobType: string): boolean {
  return /(full[-\s]?time|contingent|contract)/i.test(jobType);
}

/** Hays rows where min/max/modus are daily rates (contracting); monthly IT bands in HU are typically 400k+. */
function isLikelyHaysDailyContractBenchmarkRow(r: {
  min: number;
  max: number;
  day_rate?: number | null;
}): boolean {
  if (r.day_rate == null || r.day_rate <= 0) return false;
  return r.max < 300_000;
}

function jobUsesDayRateHaysBenchmark(jobParsed: JobParseResult, jobText: string): boolean {
  const jt = (jobParsed.job_type || '').toLowerCase();
  if (jt.includes('contract')) return true;
  return hasDayRateHint(jobText);
}

function scaleHufDayLikeBandIfNeeded(
  value: number,
  currency: CurrencyCode,
  jobType: string,
): number {
  if (currency !== 'HUF') return value;
  if (!isFullTimeOrContingent(jobType)) return value;
  if (value >= 10_000 && value <= 150_000) {
    return Math.round(value * 20);
  }
  return value;
}

export function formatCurrency(amount: number, currency: CurrencyCode): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${CURRENCY_SYMBOLS[currency] ?? currency}`;
  }
}

function inferMonthlyFromDailyIfNeeded(
  value: number,
  currency: CurrencyCode,
  text: string,
): number {
  const isDailyHint = hasDayRateHint(text);
  if (!isDailyHint) return value;
  const threshold = HIGH_NOMINAL_CURRENCIES.has(currency) ? 200_000 : 2_000;
  if (value < threshold) {
    return Math.round(value * 20);
  }
  return value;
}

/**
 * ~21×8h; scale HUF órabér / per-hour figures before comparing to a monthly floor.
 * Uses full posting when the local snippet omits "órabér" but the body states hourly pay elsewhere.
 */
function inferMonthlyFromHourlyIfNeeded(
  value: number,
  currency: CurrencyCode,
  snippet: string,
  fullJobText: string,
): number {
  if (currency !== 'HUF') return value;
  const localHourly = hasHourlyRateHint(snippet);
  const docHourly = hasHourlyRateHint(fullJobText);
  if (!localHourly && !docHourly) return value;
  if (value < 400 || value > 35_000) return value;
  // Do not scale a clearly monthly figure in the same window.
  if (hasMonthRateHint(snippet)) return value;
  // If only the full doc mentions hourly pay, only scale typical órabér-sized amounts (avoid 25k/month noise).
  if (!localHourly && docHourly && value > 15_000) return value;
  return Math.round(value * 168);
}

function inferMonthlyFromAnnualIfNeeded(value: number, text: string): number {
  // If both month and year hints exist, keep as-is (ambiguous; the parser already prefers nearby salary markers).
  if (!hasYearRateHint(text) || hasMonthRateHint(text)) return value;
  // Annual → monthly.
  return Math.round(value / 12);
}

function extractPostedSalary(jobText: string, currency: CurrencyCode): {
  estimated_min: number;
  estimated_max: number;
  estimated_modus: number;
  basis: SalaryBasis;
  /** True when órabér / per-hour amount was ×168 for monthly floor comparison. */
  hourlyScaledToMonthly?: boolean;
} | null {
  const salaryRegex =
    /(?:(USD|EUR|GBP|HUF|PLN|JPY|[$€£¥])\s*)?(\d[\d\s.,]{1,18}\d)(?:\s*(?:-|–|to)\s*(\d[\d\s.,]{1,18}\d))?\s*(USD|EUR|GBP|HUF|PLN|JPY|[$€£¥])?/gi;
  let best: { min: number; max: number; score: number; basis: SalaryBasis; hourlyScaled?: boolean } | null = null;
  const halfWindow = hasHourlyRateHint(jobText) ? 320 : 140;
  for (const match of jobText.matchAll(salaryRegex)) {
    const tokenBefore = normalizeCurrency(match[1]);
    const tokenAfter = normalizeCurrency(match[4]);
    const matchCurrency = tokenBefore ?? tokenAfter ?? currency;
    if (matchCurrency !== currency) continue;

    const snippetStart = Math.max(0, (match.index ?? 0) - halfWindow);
    const snippetEnd = Math.min(jobText.length, (match.index ?? 0) + match[0].length + halfWindow);
    const snippet = jobText.slice(snippetStart, snippetEnd);

    // Strict semantic validation: amount must be within 10 words of salary-like terms.
    const localStart = Math.max(0, (match.index ?? 0) - snippetStart);
    const localEnd = Math.min(snippet.length, localStart + match[0].length);
    const before = snippet.slice(0, localStart);
    const after = snippet.slice(localEnd);
    if (!hasSalaryKeywordWithinWindow(before, after, 10)) continue;
    // Explicitly reject known non-salary contexts (employees, countries, years, sqm, ...).
    if (hasExcludedContext(snippet)) continue;

    const first = parseSmartNumber(match[2]);
    const second = match[3] ? parseSmartNumber(match[3]) : null;
    if (!first || first < 100) continue;

    let min = second ? Math.min(first, second) : first;
    let max = second ? Math.max(first, second) : first;

    min = inferMonthlyFromAnnualIfNeeded(min, match[0]);
    max = inferMonthlyFromAnnualIfNeeded(max, match[0]);

    min = inferMonthlyFromDailyIfNeeded(min, currency, snippet);
    max = inferMonthlyFromDailyIfNeeded(max, currency, snippet);

    const minBeforeH = min;
    const maxBeforeH = max;
    min = inferMonthlyFromHourlyIfNeeded(min, currency, snippet, jobText);
    max = inferMonthlyFromHourlyIfNeeded(max, currency, snippet, jobText);
    const scaledThisRound = min !== minBeforeH || max !== maxBeforeH;

    const score = (second ? 2 : 1) + (hasBaseSalaryMarker(match[0]) ? 1 : 0);
    const basis = detectSalaryBasis(match[0]);
    if (!best || score > best.score) {
      best = { min, max, score, basis, hourlyScaled: scaledThisRound };
    }
  }

  if (!best) return null;
  return {
    estimated_min: best.min,
    estimated_max: best.max,
    estimated_modus: Math.round((best.min + best.max) / 2),
    basis: best.basis,
    ...(best.hourlyScaled ? { hourlyScaledToMonthly: true } : {}),
  };
}

/** Seniority mapping from JobParseResult.required_seniority */
function mapSeniorityToHays(s: string): string {
  switch ((s || 'unknown').toLowerCase()) {
    case 'junior':
      return 'Junior';
    case 'mid':
      return 'Medior';
    case 'senior':
      return 'Senior';
    case 'lead':
      return 'Lead';
    default:
      return 'unknown';
  }
}

const HAYS_SENIORITY_RANK: Record<string, number> = {
  unknown: 0,
  Junior: 1,
  Medior: 2,
  Senior: 3,
  Lead: 4,
};

function blendJobAndCvExperienceYears(jobYears: number | null, cvYears: number | null): number | null {
  if (jobYears != null && cvYears != null) return Math.round((jobYears + cvYears) / 2);
  if (jobYears != null) return jobYears;
  if (cvYears != null) return cvYears;
  return null;
}

/** Aligns with Hays-style bands: ~0–3 Junior, 3–5 Medior, 5–10 Senior, 10+ Lead. */
function yearsToHaysSeniorityFromExperience(years: number): string {
  if (years < 3) return 'Junior';
  if (years < 5) return 'Medior';
  if (years < 10) return 'Senior';
  return 'Lead';
}

/** Do not use a Hays band above the job title seniority when the title level is known. */
function clampHaysTierToJobTitleCeiling(jobTitleTier: string, yearsTier: string): string {
  if (jobTitleTier === 'unknown') return yearsTier;
  const rj = HAYS_SENIORITY_RANK[jobTitleTier] ?? 0;
  const ry = HAYS_SENIORITY_RANK[yearsTier] ?? 0;
  return ry > rj ? jobTitleTier : yearsTier;
}

/**
 * Hays row seniority filter: blended years (job min + CV stated, averaged when both exist),
 * capped by job title seniority when known (no band above the advertised role level).
 */
function resolveHaysSeniorityForBenchmark(params: {
  jobParsed: JobParseResult;
  jobExperienceYears?: number | null;
  cvExperienceYears?: number | null;
}): { haysSeniority: string; experienceNote: string | null } {
  const jobMinYears = params.jobExperienceYears ?? params.jobParsed.experience_years ?? null;
  const cvYears = params.cvExperienceYears ?? null;
  const blended = blendJobAndCvExperienceYears(jobMinYears, cvYears);
  const fromTitle = mapSeniorityToHays(params.jobParsed.required_seniority);

  let haysSeniority: string;
  if (blended != null) {
    const fromYears = yearsToHaysSeniorityFromExperience(blended);
    haysSeniority = clampHaysTierToJobTitleCeiling(fromTitle, fromYears);
  } else {
    haysSeniority = fromTitle;
  }

  let experienceNote: string | null = null;
  if (jobMinYears != null || cvYears != null) {
    const parts: string[] = [];
    if (jobMinYears != null) parts.push(`job min. ${jobMinYears}y`);
    if (cvYears != null) parts.push(`CV stated ${cvYears}y`);
    if (blended != null) parts.push(`blend ${blended}y → ${haysSeniority} band`);
    experienceNote = parts.join(', ');
  }
  return { haysSeniority, experienceNote };
}

/** Convert one parsed JSON record into a `HaysBenchmarkRow`, preserving enriched optional fields. */
function normalizeHaysRecord(raw: unknown): HaysBenchmarkRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const min = Number(o.min);
  const max = Number(o.max);
  const modus = Number(o.modus);
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(modus)) return null;

  const asStringArray = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const arr = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
    return arr.length ? arr : undefined;
  };
  const asNumberOrNull = (v: unknown): number | null | undefined => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    industry: typeof o.industry === 'string' ? o.industry : undefined,
    hays_label: String(o.hays_label ?? ''),
    seniority: String(o.seniority ?? 'unknown'),
    min,
    max,
    modus,
    day_rate: o.day_rate == null ? null : Number(o.day_rate),
    role: typeof o.role === 'string' ? o.role : typeof o.role_base === 'string' ? o.role_base : undefined,
    function: typeof o.function === 'string' ? o.function : undefined,
    job_family: typeof o.job_family === 'string' ? o.job_family : undefined,
    aliases: asStringArray(o.aliases),
    search_aliases: asStringArray(o.search_aliases),
    search_vector: asStringArray(o.search_vector),
    inferred_skill_tags: asStringArray(o.inferred_skill_tags),
    market_heat: typeof o.market_heat === 'string' ? o.market_heat : undefined,
    market_confidence: typeof o.market_confidence === 'string' ? o.market_confidence : undefined,
    confidence_score: typeof o.confidence_score === 'number' ? o.confidence_score : undefined,
    skill_premium_multiplier:
      typeof o.skill_premium_multiplier === 'number' ? o.skill_premium_multiplier : undefined,
    estimated_market_value_if_hot_skills:
      typeof o.estimated_market_value_if_hot_skills === 'number'
        ? o.estimated_market_value_if_hot_skills
        : undefined,
    min_experience_years: asNumberOrNull(o.min_experience_years),
    max_experience_years: asNumberOrNull(o.max_experience_years),
    seniority_score: typeof o.seniority_score === 'number' ? o.seniority_score : undefined,
    remote_friendly: typeof o.remote_friendly === 'string' ? o.remote_friendly : undefined,
    expected_languages: asStringArray(o.expected_languages),
    salary_midpoint: typeof o.salary_midpoint === 'number' ? o.salary_midpoint : undefined,
    estimated_total_comp_monthly:
      typeof o.estimated_total_comp_monthly === 'number' ? o.estimated_total_comp_monthly : undefined,
    salary_percentile: typeof o.salary_percentile === 'string' ? o.salary_percentile : undefined,
  };
}

/**
 * Load Hays rows from committed JSON. Accepts either the enriched v4 wrapper
 * (`{ _dataset_metadata, records: [...] }`) or a flat array (legacy + fixtures).
 */
async function loadHaysRows(fixture?: unknown): Promise<HaysBenchmarkRow[]> {
  if (fixture && Array.isArray(fixture)) {
    return (fixture as unknown[])
      .map(normalizeHaysRecord)
      .filter((r): r is HaysBenchmarkRow => r !== null);
  }
  try {
    const raw = await fs.readFile(dataPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const records = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as EnrichedDatasetFile)?.records)
        ? ((parsed as EnrichedDatasetFile).records as unknown[])
        : [];
    return records.map(normalizeHaysRecord).filter((r): r is HaysBenchmarkRow => r !== null);
  } catch (e) {
    console.error('[Salary Oracle] Failed to load Hays data:', e);
  }
  return [];
}

/** Last segment of `Fejezet › alcím › pozíció` paths — better title match vs. full label noise. */
function haysLabelRoleTitle(haysLabel: string): string {
  const parts = haysLabel.split('›').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : haysLabel.trim();
}

/**
 * Hays repeats the same `hays_label` for Junior/Medior/Senior/… bands. Title matching must see every band,
 * but the chosen row must use the seniority resolved from the job (with a stable default when unknown).
 */
function pickHaysRowForSeniorityBand(all: HaysBenchmarkRow[], label: string, seniority: string): HaysBenchmarkRow {
  const matches = all.filter((r) => r.hays_label === label);
  if (!matches.length) return all[0]!;
  if (seniority !== 'unknown') {
    const hit = matches.find((r) => r.seniority === seniority);
    if (hit) return hit;
  }
  const order =
    seniority === 'unknown'
      ? ['Medior', 'Junior', 'Senior', 'Lead', 'unknown']
      : [seniority, 'Medior', 'Junior', 'Senior', 'Lead', 'unknown'];
  for (const tier of order) {
    const hit = matches.find((r) => r.seniority === tier);
    if (hit) return hit;
  }
  return matches[0]!;
}

/**
 * Use a short prefix of the posting for Hays title matching (not the full body).
 * Full text caused false positives (e.g. "Scrum Master" vs "Master Data Analyst" via token "master").
 */
export function inferPrimaryJobTitleForBenchmark(jobText: string): string {
  const head = jobText.slice(0, 900).replace(/<[^>]{0,200}?>/g, ' ');
  // Discovery pipeline prepends a "[Discovery listing]\nProvider: ...\nTitle: <listing title>\n..."
  // header (see lib/discovery/jobText.ts#buildJobTextForPipeline). When this header is present,
  // the FIRST line is the literal "[Discovery listing]" tag and the actual listing title sits
  // a few lines down behind "Title: ". Previously the function picked the literal tag, which
  // scored ~0 against every Hays row and let arbitrary noise rows (HR BP, Plant Mgmt Lead,
  // Sales Support Specialist) win the heuristic. Detect the header and use the Title line.
  const titleFromHeader = /\[Discovery listing\][\s\S]{0,400}?\bTitle:\s*([^\r\n]{1,340})/i.exec(head);
  if (titleFromHeader) {
    const t = titleFromHeader[1]!.replace(/\s+/g, ' ').trim();
    const cleaned = stripRecruiterPrefix(t) || t;
    if (cleaned.length >= 3) return cleaned.slice(0, 340);
  }
  const firstBlock = head.split(/\n\s*\n/)[0] ?? head;
  const lines = firstBlock.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Prefer the first non-empty line as the job title. Extra lines ("Felvétel…", benefits) add
  // accidental overlaps with Hays industry paths (e.g. "bank", "operations") for all postings.
  const first = lines[0]?.replace(/\s+/g, ' ').trim() ?? '';
  const seed = first.length >= 3 ? first : lines.slice(0, 4).join(' ').replace(/\s+/g, ' ').trim();
  const cleaned = stripRecruiterPrefix(seed) || seed || jobText.slice(0, 200).trim();
  return cleaned.slice(0, 340);
}

/**
 * Strip recruiter / agency / brand prefixes from a listing-style title (general; no
 * curated list). Common patterns: "Nova HR - Senior Demand Planner", "Grafton Recruitment
 * - Logistics & Operations Specialist", "DSV - Global Transport and Logistics - Freight
 * Forwarder". Splitting on dashes and keeping the longest segment biases toward the actual
 * role string (which is usually the most descriptive component) and away from the company
 * brand, which would otherwise leak "HR" / "Recruitment" tokens into the heuristic and
 * make HR-family rows score artificially high.
 */
function stripRecruiterPrefix(title: string): string {
  if (!title) return title;
  const parts = title.split(/\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 1) return title;
  let best = parts[0]!;
  for (const p of parts) if (p.length > best.length) best = p;
  return best;
}

/** Strip Hays band clutter so tokens align across Junior/Medior variants (any job title / label). */
function normalizeForTitleOverlap(text: string): string {
  return stripDiacritics(text)
    .toLowerCase()
    .replace(/\([^)]{0,400}\)/g, ' ')
    .replace(/\[[^\]]{0,200}\]/g, ' ')
    .replace(/\b[0-9]+\s*[-–]\s*[0-9]+\s*(ev|ev\+|year|years)\b/gi, ' ')
    .replace(/\bfriss\s+diplomas\b/gi, ' ')
    .replace(/\bjunior\s+level\b|\bsenior\s+level\b/gi, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokens for overlap / substring guards (handles HU diacritics in titles). */
function tokenizeTitleTokens(text: string): string[] {
  const s = normalizeForTitleOverlap(text);
  return s
    .split(/[^a-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);
}

/** If overlap is only these tokens, cap score when the title also has clearer domain tokens not present in the Hays role (stops "Frontend Developer" → "C/C++ Developer" via "developer" alone). */
const GENERIC_ROLE_TOKENS = new Set([
  'developer',
  'engineer',
  'analyst',
  'manager',
  'specialist',
  'consultant',
  'architect',
  'director',
  'assistant',
  'coordinator',
  'representative',
  'administrator',
  'designer',
  'lead',
  'officer',
  'executive',
  'associate',
  'partner',
  'planner',
  'support',
  'expert',
  'head',
  // HU role generics (diacritics stripped before tokenization)
  'mernok',
  'szakerto',
  'fejleszto',
  'elemzo',
  'tanacsado',
  'vezeto',
  'menedzser',
  'ugyintezo',
  'szervezo',
  'gazda',
  'tesztelo',
  'kontroller',
  'munkatars',
  'koordinator',
]);

/** Substring-only boost skipped for these — they match too many unrelated Hays role titles. */
const AMBIGUOUS_SUBSTRING_TOKENS = new Set([
  'master',
  'lead',
  'senior',
  'junior',
  'medior',
  'szenior',
  'head',
  'chief',
  'staff',
  'principal',
  'graduate',
  'intern',
  'manager',
  'specialist',
  'consultant',
  'representative',
  'coordinator',
  'administrator',
]);

/** Hungarian parenthetical: which JSON row / Hays column the benchmark used (módusz vs. tipikus Ft/nap). */
function formatHaysJsonDataParenthetical(
  row: HaysBenchmarkRow,
  opts: { scaledDailyBandToMonthly: boolean },
): string {
  const role = haysLabelRoleTitle(row.hays_label);
  const isLikelyDailyRow = isLikelyHaysDailyContractBenchmarkRow(row);
  if (opts.scaledDailyBandToMonthly && isLikelyDailyRow) {
    return `${role} · tipikus Ft/nap (Hays JSON, havi sáv ≈ nap × 20)`;
  }
  if (isLikelyDailyRow) {
    return `${role} · tipikus Ft/nap (Hays JSON)`;
  }
  const rl = role.toLowerCase();
  const roleAlreadyHasBand =
    /\b(junior|medior|szenior|lead)\b/.test(rl) || /\([0-9]/.test(rl) || /\bév\b/.test(rl);
  return roleAlreadyHasBand
    ? `${role} · módusz (Hays JSON)`
    : `${role} · ${row.seniority} · módusz (Hays JSON)`;
}

/** Simple overlap scoring between primary job title and Hays path / role title. */
function scoreMatchCore(jobTitle: string, haysLabel: string): number {
  const a = normalizeForTitleOverlap(jobTitle);
  const b = normalizeForTitleOverlap(haysLabel);
  const wordsA = tokenizeTitleTokens(jobTitle);
  const wordsB = tokenizeTitleTokens(haysLabel);
  const common = wordsA.filter((w) => wordsB.includes(w));
  let idf = Math.min(1, common.length / Math.max(1, wordsB.length));
  if (idf < 0.35) {
    for (const wb of wordsB) {
      if (wb.length < 4) continue;
      if (AMBIGUOUS_SUBSTRING_TOKENS.has(wb)) continue;
      if (a.includes(wb)) idf = Math.max(idf, 0.35);
    }
    for (const wa of wordsA) {
      if (wa.length < 4) continue;
      if (AMBIGUOUS_SUBSTRING_TOKENS.has(wa)) continue;
      if (b.includes(wa)) idf = Math.max(idf, 0.35);
    }
  }
  if (/\bengineer(ing)?\b/.test(b) && /\bdeveloper\b/.test(a)) idf = Math.max(idf, 0.45);
  if (/\bdeveloper\b/.test(b) && /\bengineer(ing)?\b/.test(a)) idf = Math.max(idf, 0.45);

  if (common.length > 0 && common.every((w) => GENERIC_ROLE_TOKENS.has(w))) {
    const distinctA = wordsA.filter((w) => !GENERIC_ROLE_TOKENS.has(w));
    const matchedDistinct = distinctA.filter((w) => wordsB.includes(w));
    if (distinctA.length > 0 && matchedDistinct.length < distinctA.length) {
      idf = Math.min(idf, 0.44);
    }
  }

  return Math.min(1, idf);
}

function scoreMatchBase(jobTitle: string, haysLabel: string): number {
  const roleOnly = haysLabelRoleTitle(haysLabel);
  const tail = scoreMatchCore(jobTitle, roleOnly);
  const full = scoreMatchCore(jobTitle, haysLabel);
  // Industry prefixes (e.g. "Bank és…") can inflate `full`; never let them score below the role-tail signal.
  return Math.min(1, Math.max(tail, tail * 0.88 + full * 0.12));
}

/** Non-generic title tokens that hit the Hays role tail — used to break low-score ties (not min modus). */
function distinctRoleTokenHitStrength(jobTitle: string, haysLabel: string): number {
  const role = normalizeForTitleOverlap(haysLabelRoleTitle(haysLabel));
  const wordsA = tokenizeTitleTokens(jobTitle).filter(
    (w) => !GENERIC_ROLE_TOKENS.has(w) && w.length >= 3 && !AMBIGUOUS_SUBSTRING_TOKENS.has(w),
  );
  if (wordsA.length === 0) return 0;
  let sum = 0;
  for (const w of wordsA) {
    if (!role.includes(w)) continue;
    sum += w.length >= 6 ? 1.35 : w.length >= 4 ? 1 : 0.65;
  }
  return sum;
}

/** Low-signal benchmark tails that often win ties on low modus (Hays data quirks, not job-specific logic). */
function isBenchmarkNoiseSinkRow(row: { hays_label: string }): boolean {
  const r = normalizeForTitleOverlap(haysLabelRoleTitle(row.hays_label));
  return (
    /\bsales\s+assistant\b/.test(r) ||
    /\bsales\s+associate\b/.test(r) ||
    /\breceptionist\b/.test(r) ||
    /\bwarehouse\s+administrator\b/.test(r) ||
    /\badministrative\s+assistant\b/.test(r) ||
    /\boffice\s+assistant\b/.test(r) ||
    /\bmechanical\s+t\s*echnician\b/.test(r) ||
    /\bmechanical\s+technician\b/.test(r) ||
    // Fresh-graduate / very-junior Hays rows are aggressive noise sinks for non-junior titles:
    // their 0-3 év modus is so low it can win weak ties even against unrelated knowledge jobs
    // (HR Operations Support (friss diplomás) matched to "Senior Software Engineer C++" etc.).
    /\bfriss\s+diplom/.test(r) ||
    /\b\(\s*0\s*[-–]\s*3\s*ev\s*\)/.test(r)
  );
}

/**
 * Fresh-graduate / Junior 0–3 year rows are a poor benchmark for clearly senior+ titles
 * (Senior / Lead / Head / Director / Chief / Manager / Principal / Architect). They keep
 * winning weak ties because of their low modus; suppress them when the title says otherwise.
 */
function isJuniorRowMismatchingTitle(row: HaysBenchmarkRow, primaryTitle: string): boolean {
  const r = normalizeForTitleOverlap(haysLabelRoleTitle(row.hays_label));
  const looksJuniorFresh =
    /\bfriss\s+diplom/.test(r) ||
    /\b\(\s*0\s*[-–]\s*3\s*ev\s*\)/.test(r) ||
    row.seniority === 'Junior';
  if (!looksJuniorFresh) return false;
  const t = primaryTitle.toLowerCase();
  return /\b(senior|szenior|lead|head|director|chief|principal|architect|manager|menedzser|vezető|vezeto)\b/.test(t);
}

/**
 * Title ↔ Hays role match with disambiguation (Scrum Master vs Master Data, PO vs policy officer, etc.).
 * Exported for benchmark / regression scripts.
 */
export function scoreMatchTitleToHays(primaryJobTitle: string, haysLabel: string): number {
  const t = normalizeForTitleOverlap(primaryJobTitle);
  const role = normalizeForTitleOverlap(haysLabelRoleTitle(haysLabel));
  const full = normalizeForTitleOverlap(haysLabel);
  let s = scoreMatchBase(primaryJobTitle, haysLabel);

  const scrumInTitle = /\bscrum\b/.test(t);
  const masterDataInRole =
    /\bmaster\s+data\b/.test(role) || /\bmdm\b/.test(role) || /torzsadat|törzsadat/i.test(full);
  if (scrumInTitle && masterDataInRole && !/\bscrum\b/.test(role) && !/\bagile\b/.test(role)) {
    s *= 0.08;
  }

  if (/\bscrum\s+master\b/i.test(t) && /\bscrum\s+master\b/i.test(role)) s = Math.max(s, 0.78);
  if (/\bagile\s+coach\b/i.test(t) && /\bagile\s+coach\b/i.test(role)) s = Math.max(s, 0.78);
  if (/\bproduct\s+owner\b/i.test(t) && /\bproduct\s+owner\b/i.test(role)) s = Math.max(s, 0.78);

  if (/\bdata\s+scientist\b/i.test(t) && /\bdata\s+scientist\b/i.test(role)) s = Math.max(s, 0.72);
  if (/\bdata\s+engineer\b/i.test(t) && /\bdata\s+engineer\b/i.test(role)) s = Math.max(s, 0.72);
  if (/\bpenzugyi\b|\bfinancial\b/i.test(t) && /\bkonyvelo|könyvelő|accountant\b/i.test(role)) s = Math.max(s, 0.55);

  if (/\bmaster\s+data\b/i.test(t) && /\bmaster\s+data\b/i.test(role)) s = Math.max(s, 0.85);
  if (/\bdata\s+analyst\b/i.test(t) && masterDataInRole && !/\bdata\s+analyst\b/i.test(role)) s *= 0.06;
  if (/\bdata\s+analyst\b/i.test(t) && /\bdata\s+analyst\b/i.test(role) && !/\bmaster\s+data\b/i.test(role)) {
    s = Math.max(s, 0.82);
  }

  if (/\bai\s+(engineer|consultant|specialist|prompt)/i.test(primaryJobTitle) && /\biam\b/i.test(role) && !/\bai\b/i.test(role)) {
    s *= 0.1;
  }
  if (/\bai\s+engineer\b/i.test(t) && /\b(machine\s+learning|deep\s+learning|data\s+scientist)\b/i.test(role)) {
    s = Math.max(s, 0.76);
  }
  if (/\bai\s+consultant\b/i.test(t) && /\b(machine\s+learning|sap\s+consultant|consultant)\b/i.test(role)) {
    s = Math.max(s, 0.62);
  }
  if (/\bai\s+prompt\b/i.test(t) && /\bsap\b/i.test(role) && !/\bai|prompt|nlp|llm\b/i.test(role)) s *= 0.12;
  if (/\bai\s+prompt\b/i.test(t) && /\b(machine\s+learning|data\s+scientist|nlp|llm)\b/i.test(role)) s = Math.max(s, 0.72);
  if (/\bai\s+prompt\b/i.test(t) && /\b(salesforce|sap)\b/i.test(role) && !/\b(ai|prompt|nlp|llm)\b/i.test(role)) s *= 0.15;

  if (/\bfrontend\b/.test(t) && /\bfrontend\b/.test(role)) s = Math.max(s, 0.8);
  if (/\bbackend\b/.test(t) && /\bbackend\b/.test(role)) s = Math.max(s, 0.8);
  if (/\bbackend\b/.test(t) && /\b(java|\.net|c#|node|python|go|rust)\b/i.test(role)) s = Math.max(s, 0.74);
  if (/\bfull\s*stack|fullstack\b/i.test(t) && /fullstack|full\s+stack/i.test(role)) s = Math.max(s, 0.78);
  if (/\bmobile\b/.test(t) && /\bmobile|android|ios\b/i.test(role)) s = Math.max(s, 0.76);
  if (/\bembedded\b/.test(t) && /\bembedded\b/.test(role)) s = Math.max(s, 0.78);
  if (/\bmlops|machine\s+learning\s+operations\b/i.test(t) && /\bmachine\s+learning|deep\s+learning|mlops\b/i.test(role)) {
    s = Math.max(s, 0.8);
  }
  if (/\bcybersecurity|cyber\s+security\b/i.test(t) && /security|soc|information\s+security/i.test(role)) {
    s = Math.max(s, 0.74);
  }
  if (/\bcybersecurity|cyber\s+security\b/i.test(t) && /\b(payroll|hr\s+admin|warehouse|reception|sales\s+associate)\b/i.test(role)) {
    s *= 0.05;
  }
  if (/\bcybersecurity|cyber\s+security\b/i.test(t) && /\b(soc|security\s*\/|penetration|information\s+security)\b/i.test(role)) {
    s = Math.max(s, 0.82);
  }
  if (/\bsite\s+reliability|\bsre\b/i.test(t) && /\bdevops|cloud\s+engineer|system\s+engineer/i.test(role)) {
    s = Math.max(s, 0.72);
  }

  if (/\bseo\b/i.test(t) && /\bmarket\s+research\b/i.test(role) && !/\b(seo|sea|ppc)\b/i.test(role)) {
    s *= 0.1;
  }
  if (/\bseo\b/i.test(t) && /\b(seo|sea|ppc|online\s+marketing)\b/i.test(role)) s = Math.max(s, 0.76);
  if (/\bsem\b/i.test(t) && /\bmarket\s+research\b/i.test(role) && !/\b(sea|ppc|seo)\b/i.test(role)) {
    s *= 0.1;
  }
  if (/\bsem\b/i.test(t) && /\b(sea|ppc|seo|online\s+marketing)\b/i.test(role)) s = Math.max(s, 0.74);
  if (/\bcopywriter|ux\s+writer\b/i.test(t) && /content|copy|writer|editor|marketing/i.test(role)) s = Math.max(s, 0.68);
  if (/\b(recruiter|talent\s+acquisition)\b/i.test(t) && /\brecruit|talent|hr\b/i.test(role)) s = Math.max(s, 0.72);

  if (/\bfinancial\s+analyst\b/i.test(t) && /\bfp\s*&?\s*a|fp\s*a|controlling|reporting|controller\b/i.test(role)) {
    s = Math.max(s, 0.72);
  }
  if (/\bfinancial\s+analyst\b/i.test(t) && /\b(ap|ar)\s+accountant|accounts\s+payable\b/i.test(role)) s *= 0.08;

  if (/\b(cfo|chief\s+financial)\b/i.test(t) && /\bcompliance\b/i.test(role) && !/\bfinancial|finance|controller\b/i.test(role)) {
    s *= 0.06;
  }
  if (/\b(cfo|chief\s+financial)\b/i.test(t) && /\b(controller|fp\s*&?\s*a|senior\s+controller)\b/i.test(role)) {
    s = Math.max(s, 0.68);
  }
  if (/\b(chief\s+digital|cdo)\b/i.test(t) && /\bcompliance\b/i.test(role) && !/\bdigital|transformation|technology\b/i.test(role)) {
    s *= 0.08;
  }
  if (/\b(chief\s+digital|cdo)\b/i.test(t) && /\b(digital|transformation|technology|cto|innovation)\b/i.test(role)) {
    s = Math.max(s, 0.66);
  }
  if (/\b(chief\s+digital|cdo)\b/i.test(t) && /\b(welding|molding|soldering|expert\s+in\s+specific)\b/i.test(role)) {
    s *= 0.02;
  }

  if (/\bhead\s+of\s+remote\b/i.test(t) && /\bqa|quality\s+assurance\b/i.test(role) && !/\bremote|workplace|people\s+ops\b/i.test(role)) {
    s *= 0.12;
  }
  if (/\bhead\s+of\s+remote\b/i.test(t) && /\b(laboratory|lab\b|analitical|analytical)\b/i.test(role)) s *= 0.06;
  if (/\bhead\s+of\s+remote\b/i.test(t) && /\b(hr|people|workplace|remote\s+work|hybrid)\b/i.test(role)) s = Math.max(s, 0.62);

  if (/\b(data\s+privacy|dpo)\b/i.test(t) && /\bdata\s+scientist\b/i.test(role)) s *= 0.06;
  if (/\bsolutions\s+architect\b/i.test(t) && /\bdata\s+architect\b/i.test(role) && !/\bsolution|solutions\b/i.test(role)) {
    s *= 0.15;
  }

  if (/\bblockchain\b/i.test(t) && /c\/c\+\+/i.test(role)) s *= 0.12;
  if (/\bblockchain\b/i.test(t) && /\b(java|\.net|python|javascript|react|node)\b/i.test(role)) s = Math.max(s, 0.58);

  if (/\bpmo\b|project\s+management\s+office/i.test(t) && /\bproject\s+manager\b/i.test(role)) s = Math.max(s, 0.62);

  if (
    /\b(growth|marketing|hacker|copywriter|event|producer|seo|sem|analytics\s+translator)\b/i.test(t) &&
    /\bplant\s+management|operations\s+management\b/i.test(role)
  ) {
    s *= 0.02;
  }

  if (/\bcreative\s+director\b/i.test(t) && /\bsales\s+director\b/i.test(role)) s *= 0.08;
  if (/\bcreative\s+director\b/i.test(t) && /\b(creative|brand|marketing|design)\b/i.test(role)) s = Math.max(s, 0.68);

  if (/\bai\s+ethics\b/i.test(t) && /\b(compliance|aml|kyc|ethics|legal|risk)\b/i.test(role)) s = Math.max(s, 0.68);
  if (/\bai\s+ethics\b/i.test(t) && /\bmobility\b/i.test(role) && !/\b(compliance|legal|ethics)\b/i.test(role)) s *= 0.1;
  if (/\bemployer\s+branding\b/i.test(t) && /\bmobility\b/i.test(role) && !/\bbrand/i.test(role)) s *= 0.1;

  if (
    /\bsales\s+assistant\b/i.test(role) &&
    !/\b(retail|hospitality|shop|store|cashier|counter)\b/i.test(t)
  ) {
    s *= 0.12;
  }

  // "Operations" in a job title is usually line ops / COO scope — not SSC "HR Operations" rows.
  if (/\bhr\s+operations\b/i.test(role) && /\boperations\b/i.test(t) && !/\b(hr|people|human|payroll|talent|recruit|benefit|workplace)\b/i.test(t)) {
    s *= 0.12;
  }
  // C-level / executive titles should not anchor on front-office reception rows.
  if (/\breception|receptionist\b/i.test(role) && /\b(chief|coo|ceo|cfo|cto|cmo|cro|ugyvezet|elnok)\b/i.test(t)) {
    s *= 0.06;
  }
  // Discipline mismatch: building / BIM software roles vs commercial "account" / sales customer ownership.
  if (/\bbim\b/i.test(role) && /\b(account|key\s+account|sales|category|commodity|export|ugyfel|customer)\b/i.test(t)) {
    s *= 0.08;
  }
  // Manufacturing / mechanical technician rows vs knowledge-work titles (no plant/CAD/manufacturing cues).
  if (
    /\b(mechanical|welding|assembly|tooling|machinist)\b/i.test(role) &&
    !/\b(mechanical|manufacturing|cad|assembly|plant|welding|automotive|vehicle|gyarto|gyart|production|tooling)\b/i.test(t)
  ) {
    s *= 0.1;
  }

  const looksProfessional =
    /\b(engineer|developer|scientist|analyst|architect|designer|manager|director|consultant|specialist|officer|lead|coach|recruiter|writer|strategist|marketer|hacker|producer)\b/i.test(
      primaryJobTitle,
    ) ||
    /\b(mernok|szakerto|fejleszto|elemzo|tanacsado|vezeto|menedzser|ugyintezo|gazda|tesztelo|kontroller)\b/i.test(
      stripDiacritics(primaryJobTitle).toLowerCase(),
    );
  if (looksProfessional && /\bsales\s+assistant\b/i.test(role) && s < 0.55) s = Math.min(s, 0.08);

  return Math.min(1, s);
}

// ---------------------------------------------------------------------------
// Enriched-v4 scoring helpers (search_vector / aliases / skills / function /
// job_family / industry / market_heat / skill premium).
//
// These augment the legacy title-only `scoreMatchTitleToHays` with the
// enrichment fields shipped in `hays-hu-2026-enriched-v4.json`. They follow
// the weighting recommended in the dataset guide:
//   role 35% · search_vector 25% · inferred_skill_tags 15%
//   function 10% · job_family 10% · industry 5%.
// ---------------------------------------------------------------------------

/** Set of normalized job-text tokens used for skill / family / industry matching. */
type JobMatchTokens = {
  /** ASCII-folded, lowercased title tokens (from primary title snippet). */
  titleTokens: Set<string>;
  /** ASCII-folded, lowercased tokens from the full job text (skill / domain detection). */
  bodyTokens: Set<string>;
  /** Hot-skill tokens detected in the job text (matches the v4 inferred_skill_tags vocabulary). */
  hotSkillTokens: Set<string>;
};

/** Maps Hungarian / English skill phrases in the job text to v4 `inferred_skill_tags` values. */
const HOT_SKILL_KEYWORDS: Array<{ tag: string; pattern: RegExp }> = [
  { tag: 'ai', pattern: /\b(ai|artificial\s+intelligence|llm|gpt|generative\s+ai|mesterseges\s+intelligencia|nlp|prompt\s+engineer)\b/i },
  { tag: 'ai', pattern: /\b(machine\s+learning|deep\s+learning|gepi\s+tanulas|neural\s+network)\b/i },
  { tag: 'cloud', pattern: /\b(cloud|aws|azure|gcp|google\s+cloud|felho|terraform|cloudformation)\b/i },
  { tag: 'aws', pattern: /\baws\b/i },
  { tag: 'azure', pattern: /\bazure\b/i },
  { tag: 'cybersecurity', pattern: /\b(cyber\s*security|cybersecurity|information\s+security|infosec|soc\s+analyst|penetration|kiberbiztons|biztonsag(?:i|tech))\b/i },
  { tag: 'kubernetes', pattern: /\b(kubernetes|k8s|openshift)\b/i },
  { tag: 'devops', pattern: /\b(devops|sre|site\s+reliability|ci\/?cd|gitops)\b/i },
  { tag: 'python', pattern: /\bpython\b/i },
  { tag: 'java', pattern: /\b(java|spring\s*boot|jvm)\b/i },
  { tag: 'javascript', pattern: /\b(javascript|typescript|node\.?js|react|next\.?js|angular|vue)\b/i },
  { tag: 'sap', pattern: /\bsap\b/i },
  { tag: 'sql', pattern: /\b(sql|postgres|mysql|oracle\s+db|tsql|plsql)\b/i },
  { tag: 'data', pattern: /\b(data\s+(engineer|scientist|analyst|platform|warehouse|lake)|etl|airflow|spark|databricks|bigquery|snowflake|adatm[eé]rn|adatelemz)\b/i },
  { tag: 'power bi', pattern: /\b(power\s*bi|pbi|tableau|looker|qlik)\b/i },
  { tag: 'agile', pattern: /\b(agile|scrum|kanban|safe|jira)\b/i },
  { tag: 'excel', pattern: /\b(excel|vba|advanced\s+excel)\b/i },
  { tag: 'recruitment', pattern: /\b(recruit|toborz|talent\s+acquisition|hiring\s+manager|sourcer)\b/i },
  { tag: 'hr', pattern: /\b(human\s+resources|hrbp|hr\s+business\s+partner|people\s+operations|szem[eé]lyzeti)\b/i },
  { tag: 'sales', pattern: /\b(sales|account\s+executive|key\s+account|kereskedelmi|[eé]rt[eé]kes[ií]t)\b/i },
];

/** Same vocabulary, but for already-tokenized inferred_skill_tags values. */
const SKILL_TAG_TO_PATTERN: Record<string, RegExp> = HOT_SKILL_KEYWORDS.reduce(
  (acc, x) => {
    if (!acc[x.tag]) acc[x.tag] = x.pattern;
    return acc;
  },
  {} as Record<string, RegExp>,
);

function detectHotSkillTokens(jobText: string): Set<string> {
  const hits = new Set<string>();
  for (const { tag, pattern } of HOT_SKILL_KEYWORDS) {
    if (pattern.test(jobText)) hits.add(tag);
  }
  return hits;
}

/** Lazy job-text token bag (reused across all rows in a single `runSalaryOracle` call). */
function buildJobMatchTokens(primaryTitle: string, jobText: string): JobMatchTokens {
  const titleTokens = new Set(tokenizeTitleTokens(primaryTitle));
  const bodyTokens = new Set(tokenizeTitleTokens(`${primaryTitle}\n${jobText}`));
  const hotSkillTokens = detectHotSkillTokens(jobText);
  return { titleTokens, bodyTokens, hotSkillTokens };
}

/** Token overlap fraction (Jaccard-style), favoring multi-word search_vector entries. */
function scoreVectorOverlap(titleTokens: Set<string>, vector: string[] | undefined, fullTitle: string): number {
  if (!vector || vector.length === 0) return 0;
  let bestHit = 0;
  const normalizedTitle = normalizeForTitleOverlap(fullTitle);
  for (const entry of vector) {
    const tokens = tokenizeTitleTokens(entry);
    if (tokens.length === 0) continue;
    const matched = tokens.filter((t) => titleTokens.has(t)).length;
    const idf = matched / tokens.length;
    let hit = idf;
    // Substring boost for multi-word aliases ("machine learning engineer", "ai engineer", …).
    if (idf < 1 && tokens.length >= 2) {
      const aliasNormalized = normalizeForTitleOverlap(entry);
      if (aliasNormalized && normalizedTitle.includes(aliasNormalized)) hit = Math.max(hit, 0.85);
    }
    if (hit > bestHit) bestHit = hit;
    if (bestHit >= 0.99) break;
  }
  return Math.min(1, bestHit);
}

/** Aggregate alias / search_aliases / search_vector signals (one weighted axis). */
function scoreSearchVectorAxis(primaryTitle: string, row: HaysBenchmarkRow): number {
  const titleTokens = new Set(tokenizeTitleTokens(primaryTitle));
  const a = scoreVectorOverlap(titleTokens, row.search_vector, primaryTitle);
  const b = scoreVectorOverlap(titleTokens, row.search_aliases, primaryTitle);
  const c = scoreVectorOverlap(titleTokens, row.aliases, primaryTitle);
  return Math.max(a, b, c);
}

/** Fraction of the row's `inferred_skill_tags` detected in the job text. */
function scoreInferredSkillTags(jobTokens: JobMatchTokens, row: HaysBenchmarkRow): number {
  const tags = row.inferred_skill_tags;
  if (!tags || tags.length === 0) return 0;
  let matched = 0;
  for (const t of tags) {
    if (jobTokens.hotSkillTokens.has(t)) {
      matched++;
      continue;
    }
    const pattern = SKILL_TAG_TO_PATTERN[t];
    if (pattern && pattern.test([...jobTokens.bodyTokens].join(' '))) matched++;
  }
  return Math.min(1, matched / Math.max(1, tags.length));
}

/** Soft match between the job text and Hays "function" column (e.g. "AI/ML", "Folyamatfejlesztés"). */
function scoreFunctionAxis(jobTokens: JobMatchTokens, row: HaysBenchmarkRow): number {
  if (!row.function) return 0;
  const funcTokens = tokenizeTitleTokens(row.function);
  if (funcTokens.length === 0) return 0;
  const matched = funcTokens.filter((t) => jobTokens.bodyTokens.has(t)).length;
  return Math.min(1, matched / funcTokens.length);
}

/** Heuristic family-keyword cues (job_family is coarse, so we use a small vocabulary). */
const JOB_FAMILY_CUES: Record<string, RegExp> = {
  data_ai: /\b(data|ai|ml|machine|deep|llm|analytics|elemz|adatm[eé]rn)\b/i,
  it_support: /\b(it\s+support|helpdesk|sysadmin|rendszergazda|infrastructure|infra|cloud|devops|sre|engineer|developer|fejleszt)\b/i,
  finance_accounting: /\b(finance|controlling|accountant|treasury|tax|p[eé]nz[uü]gy|k[oö]nyvel|kontroll)\b/i,
  hr: /\b(hr|talent|recruit|people\s+ops|szem[eé]lyzeti|toborz)\b/i,
  sales: /\b(sales|account\s+exec|key\s+account|kereskedelmi|[eé]rt[eé]kes[ií]t)\b/i,
  supply_chain: /\b(supply\s+chain|logist|procurement|warehouse|beszerz|rakt[aá]r|sz[aá]ll[ií]tm)\b/i,
  construction_engineering: /\b(construction|civil\s+engineer|architect\b|[eé]p[ií]t[eé]si|m[eé]rn[oö]k\s+[eé]p[ií]t)\b/i,
  general_business: /\b(office|administration|operations|coordinator|assistant|ad[mn]inisztr|munkat[aá]rs)\b/i,
};

function scoreJobFamilyAxis(jobText: string, row: HaysBenchmarkRow): number {
  if (!row.job_family) return 0;
  const re = JOB_FAMILY_CUES[row.job_family];
  if (!re) return 0;
  return re.test(jobText) ? 1 : 0;
}

/** Industry token overlap with the job text. */
function scoreIndustryAxis(jobText: string, row: HaysBenchmarkRow): number {
  if (!row.industry) return 0;
  const haystack = normalizeForTitleOverlap(jobText);
  const industryTokens = tokenizeTitleTokens(row.industry).filter((t) => t.length >= 4);
  if (industryTokens.length === 0) return 0;
  const matched = industryTokens.filter((t) => haystack.includes(t)).length;
  return Math.min(1, matched / industryTokens.length);
}

/**
 * Weighted enriched signal for a row (0..1). Combines six axes per the dataset guide,
 * then dampens by row↔job seniority distance and fresh-graduate band penalty. Both
 * dampeners are GENERAL (no job-specific patterns), driven by the dataset's own
 * seniority field and label conventions.
 *
 * The role axis is the legacy title↔Hays score and carries the negative-guard logic.
 */
function scoreEnrichedRow(params: {
  primaryTitle: string;
  jobText: string;
  jobTokens: JobMatchTokens;
  row: HaysBenchmarkRow;
  legacyTitleScore: number;
  /** Hays-mapped seniority resolved for the job (Junior / Medior / Senior / Lead / unknown). */
  jobSeniority: string;
}): { score: number; titleScore: number; vector: number; skills: number; func: number; family: number; industry: number; seniorityFactor: number } {
  const { primaryTitle, jobText, jobTokens, row, legacyTitleScore, jobSeniority } = params;
  const vector = scoreSearchVectorAxis(primaryTitle, row);
  const skills = scoreInferredSkillTags(jobTokens, row);
  const func = scoreFunctionAxis(jobTokens, row);
  const family = scoreJobFamilyAxis(jobText, row);
  const industry = scoreIndustryAxis(jobText, row);
  const weighted =
    0.35 * legacyTitleScore +
    0.25 * vector +
    0.15 * skills +
    0.10 * func +
    0.10 * family +
    0.05 * industry;
  // Preserve legacy negative guards: when the title-only signal is very weak (mismatch guards
  // like Scrum Master vs Master Data fired and tanked it), cap enrichment uplift to +0.18.
  // This keeps Scrum Master from getting rescued by surface aliases on the wrong row.
  const guarded = legacyTitleScore < 0.2 ? Math.min(weighted, legacyTitleScore + 0.18) : weighted;
  // Seniority-distance dampener + fresh-graduate penalty (both general, dataset-driven).
  // Fresh-graduate rows are gated on the JOB TITLE being entry-level, not on the resolved
  // Hays seniority: the experience-blender often resolves to Junior for 1-2y postings, but
  // that's a regular Junior pro, not a new grad. Penalize the friss-diplomás band unless
  // the posting itself reads as trainee / intern / pályakezdő.
  let seniorityFactor = seniorityFitFactor(row.seniority, jobSeniority);
  if (isFreshGraduateLabel(row.hays_label) && !isEntryLevelJobTitle(primaryTitle)) {
    seniorityFactor *= 0.35;
  }
  // Synthetic-estimate rows (market_confidence='estimated' / 'estimated_high') carry
  // hot-skills inflated modus values (1.5-3M+). When the title coherence is weak the
  // heuristic must not let these win on generic phrase matches alone (e.g. "Senior
  // Supply Chain Project Manager" → IT Project Manager Senior 2.4M via shared "project
  // manager"). Require near-exact title coherence (legacy ≥ 0.7) before letting a synthetic
  // row win unrestricted — otherwise dampen 70%. The threshold is high because synthetic
  // rows are inflated; a partial generic-phrase match (0.5-0.7) is not enough evidence
  // that the inflated number applies. Distinct non-generic overlap must also be present.
  const syntheticFactor =
    isSyntheticEstimateRow(row) &&
    (legacyTitleScore < 0.7 || distinctRoleTokenHitStrength(primaryTitle, row.hays_label) < 1.0)
      ? 0.3
      : 1.0;
  const damped = guarded * seniorityFactor * syntheticFactor;
  return {
    score: Math.max(0, Math.min(1, damped)),
    titleScore: legacyTitleScore,
    vector,
    skills,
    func,
    family,
    industry,
    seniorityFactor,
  };
}

/**
 * Asymmetric distance-based dampener between the row's seniority band and the job's
 * resolved seniority. Same tier = 1.0. Overshooting (row above job) is penalized
 * harder than undershooting (row below job), because picking a Lead-band row for a
 * Senior title inflates the forecast by 2-4x (e.g. Plant Mgmt Lead 3.75M vs Senior
 * Logistics ~1.4M), while picking a Senior row for a Lead title typically undershoots
 * by ~30%. Returns 1.0 when either tier is unknown (no signal → don't penalize).
 *
 * This is the main mechanism preventing Lead-row picks for Specialist titles and
 * Junior-row picks for Senior+ titles, without any job-specific patterns.
 */
function seniorityFitFactor(rowSeniority: string, jobSeniority: string): number {
  if (!jobSeniority || jobSeniority === 'unknown') return 1.0;
  const rRank = HAYS_SENIORITY_RANK[rowSeniority] ?? 0;
  const jRank = HAYS_SENIORITY_RANK[jobSeniority] ?? 0;
  if (rRank === 0 || jRank === 0) return 1.0;
  const signed = rRank - jRank;
  if (signed === 0) return 1.0;
  if (signed === -1) return 0.75;
  if (signed === -2) return 0.45;
  if (signed === 1) return 0.50;
  if (signed === 2) return 0.25;
  return 0.15;
}

/**
 * Dataset convention: rows whose label includes "(friss diplomás)" or "(0-3 év)" are
 * inherently entry-level bands (Hays HU 2026's fresh-graduate columns) and carry
 * lower modus than the comparable career band. They are a poor benchmark for any
 * non-junior job — purely a structural property of the dataset, not job-specific.
 */
function isFreshGraduateLabel(label: string): boolean {
  const s = stripDiacritics(label).toLowerCase();
  // Hays HU 2026 fresh-grad / very-junior tiers come in two forms in the dataset:
  // "(0-3 év)" (friss diplomás) and "(1-3 év)" (early junior). Both have entry-level
  // modus values (~650-700k) that severely undershoot mid+ titles. Treat both as
  // fresh-graduate-style bands; the penalty is gated on the JOB TITLE being entry-level.
  return /\bfriss\s+diplom/.test(s) || /\(\s*[01]\s*[-–]\s*3\s*ev\s*\)/.test(s);
}

/**
 * Generic detector for explicit entry-level / fresh-graduate job postings. We use this
 * (not the resolved Hays seniority) to gate the fresh-graduate row penalty, because
 * the experience-blender frequently lands on `Junior` whenever the posting asks for
 * 1-2 years of experience — but that's a regular Junior pro, not a new graduate.
 * The fresh-graduate row should only stay un-penalized when the posting explicitly
 * targets new graduates / trainees / interns.
 */
function isEntryLevelJobTitle(title: string): boolean {
  if (!title) return false;
  const t = stripDiacritics(title.toLowerCase());
  return /\b(trainee|intern|internship|gyakornok|gyakorlat|fresh\s+graduate|friss\s+diplom|palyakezd|kezdo|scholarship|recent\s+graduate|entry[-\s]level)\b/.test(t);
}

/**
 * Title-implied seniority cap (general, dataset-agnostic). When the title carries NO
 * explicit Lead-tier marker (lead / principal / director / chief / head of / VP),
 * cap the seniority used for row-pool selection and dampening at Senior. This stops
 * the system from picking Lead-band rows (e.g. Plant Management / Operations Mgmt at
 * ~HUF 3.75M) for plain "Specialist" / "Coordinator" / "Analyst" / "Manager" titles
 * even when the LLM over-resolves required_seniority to 'lead' because the JD asks
 * for many years of experience. Returns null when the title legitimately implies Lead+.
 */
function titleImpliedSeniorityCap(title: string): string | null {
  if (!title) return null;
  const t = stripDiacritics(title.toLowerCase());
  if (/\b(lead|principal|director|chief|head\s+of|cto|cio|cfo|ceo|vp|vice\s+president)\b/.test(t)) return null;
  return 'Senior';
}

/**
 * Dataset-wide median min/max/modus per Hays seniority tier. Used as a sane fallback
 * when no row in the dataset has any meaningful overlap with the job title (the Hays
 * 2026 dataset covers only a slice of the HU market — emerging fields like robotics
 * R&D, 3D reconstruction, solutions engineering don't have direct equivalents).
 *
 * Excludes noise-sink rows (retail/sales-assistant) and fresh-graduate bands so the
 * median reflects typical career-track HU salaries for the tier, not entry-level
 * outliers. Computed once per row-set; the result is cached on the array object.
 */
type SeniorityMedians = { min: number; max: number; modus: number; sampleSize: number };
const medianCache = new WeakMap<HaysBenchmarkRow[], Map<string, SeniorityMedians>>();

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

function getHaysSeniorityMedians(rows: HaysBenchmarkRow[]): Map<string, SeniorityMedians> {
  const cached = medianCache.get(rows);
  if (cached) return cached;
  const groups = new Map<string, { min: number[]; max: number[]; modus: number[] }>();
  for (const r of rows) {
    if (!Number.isFinite(r.modus) || r.modus <= 0) continue;
    if (isFreshGraduateLabel(r.hays_label)) continue;
    if (isBenchmarkNoiseSinkRow(r)) continue;
    // Skip day-rate IT contracting rows — their modus is in HUF/day, would skew medians.
    if (isLikelyHaysDailyContractBenchmarkRow(r)) continue;
    const tier = r.seniority || 'unknown';
    const g = groups.get(tier) ?? { min: [], max: [], modus: [] };
    g.min.push(r.min);
    g.max.push(r.max);
    g.modus.push(r.modus);
    groups.set(tier, g);
  }
  const result = new Map<string, SeniorityMedians>();
  for (const [tier, g] of groups) {
    result.set(tier, { min: median(g.min), max: median(g.max), modus: median(g.modus), sampleSize: g.modus.length });
  }
  medianCache.set(rows, result);
  return result;
}

/**
 * Synthetic median row used when no Hays row has any meaningful overlap with the title.
 * Carries no enrichment fields, so skill premium / market heat / synthetic-estimate notes
 * are all skipped — the rationale should make this fallback explicit.
 */
function buildSyntheticMedianRow(medians: SeniorityMedians, seniority: string): HaysBenchmarkRow {
  const tier = seniority && seniority !== 'unknown' ? seniority : 'Medior';
  return {
    hays_label: `(no confident match — HU ${tier} band median)`,
    seniority: tier,
    min: medians.min,
    max: medians.max,
    modus: medians.modus,
  };
}

/** Map `market_heat` to a small confidence nudge (+0.05 / +0.02 / 0 / −0.02). */
function marketHeatConfidenceDelta(heat: string | undefined): number {
  switch (heat) {
    case 'very_hot':
      return 0.05;
    case 'hot':
    case 'stable_hot':
      return 0.02;
    case 'stable':
      return 0;
    default:
      return 0;
  }
}

/** Map `market_confidence` to a confidence multiplier (high/medium/low/estimated/synthetic). */
function marketConfidenceMultiplier(conf: string | undefined): number {
  switch (conf) {
    case 'high':
      return 1.0;
    case 'medium':
      return 0.9;
    case 'estimated_high':
      return 0.85;
    case 'estimated':
      return 0.8;
    case 'low':
      return 0.7;
    default:
      return 1.0;
  }
}

/** True when the row is a synthetic / dataset-estimated market value (not raw Hays). */
function isSyntheticEstimateRow(row: HaysBenchmarkRow): boolean {
  return row.market_confidence === 'estimated' || row.market_confidence === 'estimated_high';
}

/**
 * Maximum total skill-premium uplift over the base Hays modus.
 *
 * Guide §5: "The AI should compound premiums conservatively." The dataset's
 * raw `skill_premium_multiplier` (and the precomputed `estimated_market_value_if_hot_skills`)
 * assumes ALL `inferred_skill_tags` are present in the job text, which inflates the
 * forecast when only a subset actually matches (e.g. "cloud" present but not aws/azure).
 * We cap total uplift at +25% to keep estimates inside realistic 2026 HU bands.
 */
const SKILL_PREMIUM_MAX_UPLIFT = 0.25;

/**
 * Below this title-coherence (legacy score) we treat the role match as too weak to trust
 * the headline `skill_premium_multiplier`. Premium is only meaningful when we're confident
 * we picked the right role band; otherwise it inflates an already-uncertain estimate.
 */
const SKILL_PREMIUM_COHERENCE_FLOOR = 0.20;

/**
 * Apply v4 skill-premium logic to the matched row when the job text exposes
 * hot skills overlapping `inferred_skill_tags`. The premium is coverage-scaled
 * (multiplier × matched/total) and globally capped — so a single matched tag out
 * of three only contributes ~1/3 of the headline multiplier, not the full value.
 *
 * Also gated by `titleCoherence`: when the row was matched on a weak title signal
 * (LLM rescue / fallback), we skip the premium entirely.
 */
function applySkillPremium(params: {
  row: HaysBenchmarkRow;
  jobTokens: JobMatchTokens;
  titleCoherence: number;
  min: number;
  max: number;
  modus: number;
}): {
  min: number;
  max: number;
  modus: number;
  premiumApplied: boolean;
  premiumPct?: number;
  matchedSkills?: string[];
  matchedCount?: number;
  totalCount?: number;
} {
  const { row, jobTokens, titleCoherence, min, max, modus } = params;
  const tags = row.inferred_skill_tags;
  const multiplier = row.skill_premium_multiplier;
  if (!tags || tags.length === 0 || !multiplier || multiplier <= 0) {
    return { min, max, modus, premiumApplied: false };
  }
  if (titleCoherence < SKILL_PREMIUM_COHERENCE_FLOOR) {
    return { min, max, modus, premiumApplied: false };
  }
  const bodyJoined = [...jobTokens.bodyTokens].join(' ');
  const matchedSkills = tags.filter((t) => {
    if (jobTokens.hotSkillTokens.has(t)) return true;
    const pattern = SKILL_TAG_TO_PATTERN[t];
    return pattern ? pattern.test(bodyJoined) : false;
  });
  if (matchedSkills.length === 0) {
    return { min, max, modus, premiumApplied: false };
  }
  // Conservative: scale the headline multiplier by tag coverage, then cap total uplift.
  const coverage = matchedSkills.length / tags.length;
  const effectiveMultiplier = Math.min(multiplier * coverage, SKILL_PREMIUM_MAX_UPLIFT);
  if (effectiveMultiplier <= 0) {
    return { min, max, modus, premiumApplied: false };
  }
  const factor = 1 + effectiveMultiplier;
  return {
    min: Math.round(min * factor),
    max: Math.round(max * factor),
    modus: Math.round(modus * factor),
    premiumApplied: true,
    premiumPct: Math.round(effectiveMultiplier * 100),
    matchedSkills,
    matchedCount: matchedSkills.length,
    totalCount: tags.length,
  };
}

/** Determine match status vs floor. */
function computeMatchStatus(modus: number, floor: number): 'above_limit' | 'borderline' | 'below_limit' {
  if (modus >= floor * (1 + BAND_UPPER_PCT)) return 'above_limit';
  if (modus <= floor * (1 - BAND_BELOW_PCT)) return 'below_limit';
  return 'borderline';
}

const SALARY_HAYS_LLM_SHORTLIST = 22;

type HaysLlmPickPayload = { hays_label: string | null; reason?: string };

/**
 * When heuristic title match is weak and there is no posted salary, ask the LLM to pick from a short Hays list.
 * Skipped for fixtures, missing model, or model tag `skip` (benchmarks / CI).
 */
async function maybeRefineHaysRowWithLlmFallback(opts: {
  primaryTitle: string;
  jobText: string;
  scored: Array<{ row: HaysBenchmarkRow; score: number }>;
  currentRow: HaysBenchmarkRow;
  currentScore: number;
  model?: string;
  hasFixture: boolean;
}): Promise<{ row: HaysBenchmarkRow; note: string | null } | null> {
  if (opts.currentScore >= 0.3) return null;
  if (opts.hasFixture) return null;
  const model = opts.model?.trim() ?? '';
  if (!model || model.toLowerCase() === 'skip') return null;

  const sorted = [...opts.scored].sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const shortlist: typeof sorted = [];
  for (const x of sorted) {
    const k = x.row.hays_label;
    if (seen.has(k)) continue;
    seen.add(k);
    shortlist.push(x);
    if (shortlist.length >= SALARY_HAYS_LLM_SHORTLIST) break;
  }

  const candidatesJson = shortlist.map((x, i) => ({
    i,
    label: x.row.hays_label,
    role_tail: haysLabelRoleTitle(x.row.hays_label),
    seniority: x.row.seniority,
    modus_huf: x.row.modus,
    heuristic: Number(x.score.toFixed(3)),
  }));

  const prompt = `// lib/salary-oracle.ts — LLM Hays shortlist
Return STRICT JSON with keys in this order only: {"hays_label":string|null,"reason":string}
- hays_label: copy exactly one "label" from CANDIDATES, or null if no candidate fits.
- reason: one short English sentence (max 80 chars).

JOB_ROLE (EN/HU, job title only):
${JSON.stringify((opts.primaryTitle || opts.jobText).slice(0, 340))}

RULES (must follow — return null when no candidate matches):
1. Disciplines must match. tech ↔ tech, sales ↔ sales, HR ↔ HR, finance ↔ finance, supply chain ↔ supply chain. NEVER cross disciplines.
   Counter-examples: a C++ Engineer is NOT HR Operations. A Sales Director is NOT a Data Engineer. A Könyvelő (bookkeeper) is NOT an FP&A Analyst (those are distinct finance roles). A QA / Minőségügyi Mérnök is NOT Kockázatelemző (risk).
2. Seniority must match the job title. Director/Lead/Head → Lead rows. Senior → Senior rows. Avoid Junior / "friss diplomás" / "(0-3 év)" rows when the job title says Senior, Lead, Head, Manager, Director.
3. Avoid retail / shop-floor / sales-assistant rows for knowledge-work titles (engineer, analyst, manager, director, consultant).
4. Prefer the candidate whose role_tail shares the most non-generic words with the job title. If none of the candidates share a meaningful word with the job title, return null — a wrong match is worse than no match.

CANDIDATES:
${JSON.stringify(candidatesJson).slice(0, 12_000)}`;

  try {
    const data = await generateJsonWithOllamaStrict<HaysLlmPickPayload>(prompt, {
      model,
      role: 'extract_cv',
      num_predict: 280,
    });
    const picked = typeof data.hays_label === 'string' ? data.hays_label.trim() : '';
    if (!picked) return null;
    const hit = shortlist.find((x) => x.row.hays_label === picked);
    if (!hit) return null;

    // Post-LLM sanity check: reject a pick that has effectively zero meaningful overlap
    // with the job title. This stops the model from rescuing a low heuristic with a
    // discipline-mismatched row (HR Operations for a C++ engineer, Data Engineer for a
    // Sales Director, etc.). We compare the legacy title score AND a distinct-token strength.
    const pickedLegacyScore = scoreMatchTitleToHays(opts.primaryTitle, hit.row.hays_label);
    const pickedDistinctHit = distinctRoleTokenHitStrength(opts.primaryTitle, hit.row.hays_label);
    const pickedIsJuniorFresh =
      isFreshGraduateLabel(hit.row.hays_label) ||
      (hit.row.seniority === 'Junior' && /\b(senior|lead|head|director|chief|principal)\b/i.test(opts.primaryTitle));
    // Synthetic-estimate rows (market_confidence='estimated'/'estimated_high') carry
    // inflated modus values (1.5-3M+) based on hot-skills market estimates. Picking one
    // for a discipline-mismatched title doubles the error: wrong role × inflated modus.
    // Require a meaningfully stronger title coherence for synthetic rows than for raw
    // Hays rows — otherwise the LLM can land on e.g. Senior Python Developer 2.3M for
    // Senior Buyer via shared "senior" alone.
    const pickedIsSyntheticWeak =
      isSyntheticEstimateRow(hit.row) && pickedLegacyScore < 0.30 && pickedDistinctHit < 1.5;
    if (
      (pickedLegacyScore < 0.12 && pickedDistinctHit < 1.0) ||
      pickedIsJuniorFresh ||
      pickedIsSyntheticWeak
    ) {
      console.warn(
        `[Salary Oracle] LLM pick rejected (legacy=${pickedLegacyScore.toFixed(2)}, distinct=${pickedDistinctHit.toFixed(2)}, juniorFresh=${pickedIsJuniorFresh}, syntheticWeak=${pickedIsSyntheticWeak}): "${hit.row.hays_label}" for title "${opts.primaryTitle.slice(0, 80)}"`,
      );
      return null;
    }

    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 90) : '';
    return { row: hit.row, note: reason || null };
  } catch (e) {
    console.error('[Salary Oracle] LLM Hays refine failed:', e instanceof Error ? e.message : e);
    return null;
  }
}

/** Run the salary oracle. */
export const runSalaryOracle = async (params: {
  jobText: string;
  jobParsed: JobParseResult;
  constraints: string[];
  model?: string;
  fixture?: unknown;
  preferredCurrency?: string | null;
  /** Pipeline-validated minimum years from the posting (optional). */
  jobExperienceYears?: number | null;
  /** Max stated "N years" / "N év" from CV/profile text (optional). */
  cvExperienceYears?: number | null;
}): Promise<{
  salary_analysis?: {
    hays_matched_label?: string;
    confidence_score: number;
    low_confidence?: boolean;
    estimated_min: number;
    estimated_max: number;
    estimated_modus: number;
    match_status: 'above_limit' | 'borderline' | 'below_limit';
    rationale: string;
    salary_forecast_display?: SalaryForecastDisplay;
    source: SalarySource;
    currency: CurrencyCode;
    base_salary: {
      estimated_min: number;
      estimated_max: number;
      estimated_modus: number;
      basis: SalaryBasis;
    };
    bonus_detected: boolean;
    benefits_value: string | null;
    normalized_net_estimate?: number;
    comparison_currency: CurrencyCode;
    normalized_estimated_min: number;
    normalized_estimated_max: number;
    normalized_estimated_modus: number;
    conversion_applied: boolean;
    exchange_rate_used?: string;
  } | null;
}> => {
  const currency = detectCurrency(params.jobText, params.preferredCurrency);
  const comparisonCurrency = normalizeCurrency(params.preferredCurrency) ?? currency;
  const floorFromConstraints = parseSalaryFloorFromConstraints(params.constraints, comparisonCurrency);
  const floorInComparison = floorFromConstraints.currency === comparisonCurrency
    ? floorFromConstraints.amount
    : convertCurrency(floorFromConstraints.amount, floorFromConstraints.currency, comparisonCurrency);
  const bonusDetected = detectBonusMention(params.jobText);
  const benefitsValue = detectBenefitsValue(params.jobText);
  const constraintBasis = constraintSalaryBasis(params.constraints);

  const posted = extractPostedSalary(params.jobText, currency);
  if (posted) {
    const scaledPostedMin = scaleHufDayLikeBandIfNeeded(posted.estimated_min, currency, params.jobParsed.job_type);
    const scaledPostedMax = scaleHufDayLikeBandIfNeeded(posted.estimated_max, currency, params.jobParsed.job_type);
    const scaledPostedModus = Math.round((scaledPostedMin + scaledPostedMax) / 2);
    const postedLooksUnlikely =
      currency === 'HUF' &&
      scaledPostedModus >= 10_000 &&
      scaledPostedModus <= 150_000 &&
      !isFullTimeOrContingent(params.jobParsed.job_type) &&
      !hasDayRateHint(params.jobText) &&
      !hasHourlyRateHint(params.jobText);
    if (!postedLooksUnlikely) {
      const normalizedPostedMin = convertCurrency(scaledPostedMin, currency, comparisonCurrency);
      const normalizedPostedMax = convertCurrency(scaledPostedMax, currency, comparisonCurrency);
      const normalizedPostedModus = Math.round((normalizedPostedMin + normalizedPostedMax) / 2);
      const comparableModus =
      posted.basis === 'gross' && constraintBasis === 'net'
        ? estimateNetFromGross(normalizedPostedModus, comparisonCurrency, params.jobText)
        : normalizedPostedModus;
      const status = computeMatchStatus(comparableModus, floorInComparison);
      const delta = ((comparableModus - floorInComparison) / floorInComparison) * 100;
    const relation =
      status === 'above_limit'
        ? `${Math.round(delta)}% above your minimum`
        : status === 'borderline'
          ? 'around your minimum'
          : `${Math.round(Math.abs(delta))}% below your minimum`;
    const belowButBonusBridge =
      status === 'below_limit' && bonusDetected && Boolean(benefitsValue);
    const hourlyNote =
      posted.hourlyScaledToMonthly === true
        ? ' The posting states an hourly rate (e.g. órabér / per hour); it was approximated to a monthly gross using ~168 work hours for comparison with your monthly floor.'
        : '';
    const rationale = belowButBonusBridge
      ? `The base salary is ${formatCurrency(scaledPostedModus, currency)}, which is below your ${formatCurrency(floorInComparison, comparisonCurrency)} goal, but the total package includes bonuses and ${benefitsValue} which may bridge the gap.${hourlyNote}`
      : `Posted compensation indicates a typical monthly ${posted.basis} base of ${formatCurrency(scaledPostedModus, currency)} (${relation}).${hourlyNote}`;
    const postedPieces: string[] = [];
    if (belowButBonusBridge) {
      postedPieces.push('Bonus or benefits are mentioned — total cash may exceed the base-only midpoint.');
    }
    const hn = hourlyNote.trim();
    if (hn) postedPieces.push(hn);
    const postedSupplement = postedPieces.length ? postedPieces.join(' ') : undefined;
      return {
        salary_analysis: {
          confidence_score: 0.95,
          low_confidence: false,
          estimated_min: scaledPostedMin,
          estimated_max: scaledPostedMax,
          estimated_modus: scaledPostedModus,
          match_status: status,
          rationale,
          salary_forecast_display: buildSalaryForecastDisplay({
            source: 'posted',
            low_confidence: false,
            comparable_modus: comparableModus,
            comparison_currency: comparisonCurrency as SalaryForecastCurrency,
            floor_amount: floorInComparison,
            match_status: status,
            row: null,
            posted_basis: posted.basis,
            supplement: postedSupplement,
          }),
          source: 'posted',
          currency,
          base_salary: {
            estimated_min: scaledPostedMin,
            estimated_max: scaledPostedMax,
            estimated_modus: scaledPostedModus,
            basis: posted.basis,
          },
          bonus_detected: bonusDetected,
          benefits_value: benefitsValue,
          normalized_net_estimate:
            posted.basis === 'gross' ? estimateNetFromGross(normalizedPostedModus, comparisonCurrency, params.jobText) : undefined,
          comparison_currency: comparisonCurrency,
          normalized_estimated_min: normalizedPostedMin,
          normalized_estimated_max: normalizedPostedMax,
          normalized_estimated_modus: normalizedPostedModus,
          conversion_applied: currency !== comparisonCurrency,
          exchange_rate_used: getExchangeRateUsed(currency, comparisonCurrency),
        },
      };
    }
  }
  // If posted extraction looks unlikely (e.g. employee counts / suspicious monthly values),
  // we intentionally fall back to market benchmark below.

  // Load Hays data (title matching uses full `rowsRaw` so FT roles can still map to IT Contracting day bands, e.g. Scrum Master).
  const rowsRaw = await loadHaysRows(params.fixture);
  if (!rowsRaw.length) {
    return {
      salary_analysis: {
        confidence_score: 0,
        estimated_min: 0,
        estimated_max: 0,
        estimated_modus: 0,
        match_status: 'below_limit',
        rationale: 'Salary data unavailable. Please ensure Hays HU 2026 JSON is present.',
        salary_forecast_display: {
          estimate_headline: 'No salary benchmark file loaded — estimate unavailable.',
          low_confidence: true,
          source_from_posting: false,
          benchmark_basis: null,
          floor_comparison: `vs your stated minimum (${formatCurrency(floorInComparison, comparisonCurrency)}/month): no benchmark to compare.`,
        },
        source: 'market_benchmark',
        currency,
        base_salary: {
          estimated_min: 0,
          estimated_max: 0,
          estimated_modus: 0,
          basis: 'gross',
        },
        bonus_detected: bonusDetected,
        benefits_value: benefitsValue,
        comparison_currency: comparisonCurrency,
        normalized_estimated_min: 0,
        normalized_estimated_max: 0,
        normalized_estimated_modus: 0,
        conversion_applied: currency !== comparisonCurrency,
        exchange_rate_used: getExchangeRateUsed(currency, comparisonCurrency),
      },
    };
  }

  // Hays HU 2026 is a HUF monthly benchmark (regardless of job-posting currency hints).
  const benchmarkCurrency: CurrencyCode = 'HUF';

  const cvYearsResolved = params.cvExperienceYears ?? null;
  const { haysSeniority, experienceNote } = resolveHaysSeniorityForBenchmark({
    jobParsed: params.jobParsed,
    jobExperienceYears: params.jobExperienceYears,
    cvExperienceYears: cvYearsResolved,
  });
  const primaryTitle = inferPrimaryJobTitleForBenchmark(params.jobText);
  // Cap the seniority used for row selection by what the title alone implies. Without an
  // explicit Lead/Director/Principal marker, never select Lead-band rows — this keeps
  // Plant Management / Operations Mgmt 3.75M and similar Lead rows out of plain
  // "Specialist" / "Coordinator" / "Analyst" / "Manager" pools, regardless of how many
  // years of experience the JD asks for. The displayed seniority remains the picked
  // row's own band.
  const titleCap = titleImpliedSeniorityCap(primaryTitle);
  const seniority =
    titleCap && (HAYS_SENIORITY_RANK[haysSeniority] ?? 0) > (HAYS_SENIORITY_RANK[titleCap] ?? 0)
      ? titleCap
      : haysSeniority;

  const benchmarkParenthetical = (haysJsonNote: string) =>
    [experienceNote, haysJsonNote].filter(Boolean).join(' · ');

  // Title match against every Hays role label (all seniority bands). Seniority is applied only when
  // picking min/max/modus for the matched label — otherwise unknown-seniority jobs only see ~200
  // `seniority:"unknown"` rows and miss mainstream benchmarks (e.g. Frontend Developer).
  const distinctLabels = [...new Set(rowsRaw.map((r) => r.hays_label))];
  const pool = distinctLabels.map((label) => pickHaysRowForSeniorityBand(rowsRaw, label, seniority));

  // Build job-side token bag once; reused across every row's enriched scoring axes.
  const jobTokens = buildJobMatchTokens(primaryTitle, params.jobText);

  // Score matches on a short title snippet (legacy title-only score) and blend it with the
  // enriched v4 axes (search_vector / inferred_skill_tags / function / job_family / industry),
  // then dampen by row↔job seniority distance and fresh-graduate label penalty.
  const scored = pool.map((r) => {
    const legacy = scoreMatchTitleToHays(primaryTitle, r.hays_label);
    const enriched = scoreEnrichedRow({
      primaryTitle,
      jobText: params.jobText,
      jobTokens,
      row: r,
      legacyTitleScore: legacy,
      jobSeniority: seniority,
    });
    return { row: r, score: enriched.score, legacyScore: legacy };
  });

  // Pick best score; on ties prefer monthly Hays rows over IT Contracting day bands unless the job is contract/day-rate
  // (otherwise junk titles tie at ~0 and the lowest modus day row wins — see verify-salary-oracle ambiguous-title test).
  const allowDayRateHaysRows = jobUsesDayRateHaysBenchmark(params.jobParsed, params.jobText);
  const best = scored.reduce<{ row: (typeof rowsRaw)[number] | null; score: number }>(
    (a, b) => {
      if (b.score > a.score + 1e-4) return b;
      if (b.score < a.score - 1e-4) return a;
      if (!a.row) return b;
      if (!b.row) return a;
      const aDaily = isLikelyHaysDailyContractBenchmarkRow(a.row);
      const bDaily = isLikelyHaysDailyContractBenchmarkRow(b.row);
      if (!allowDayRateHaysRows && aDaily !== bDaily) {
        return aDaily ? b : a;
      }
      // Weak ties used to pick the lowest modus (often retail / assistant rows). Prefer stronger
      // non-generic token overlap with the Hays role tail instead.
      if (a.score < 0.28 && b.score < 0.28 && Math.abs(a.score - b.score) < 1e-4) {
        const ah = distinctRoleTokenHitStrength(primaryTitle, a.row.hays_label);
        const bh = distinctRoleTokenHitStrength(primaryTitle, b.row.hays_label);
        if (Math.abs(bh - ah) > 1e-4) return bh > ah ? b : a;
        const aSink = isBenchmarkNoiseSinkRow(a.row);
        const bSink = isBenchmarkNoiseSinkRow(b.row);
        if (aSink !== bSink) return aSink ? b : a;
        // Penalize Junior / fresh-graduate rows when the title clearly indicates senior+ level.
        const aJunior = isJuniorRowMismatchingTitle(a.row, primaryTitle);
        const bJunior = isJuniorRowMismatchingTitle(b.row, primaryTitle);
        if (aJunior !== bJunior) return aJunior ? b : a;
      }
      // General tie-break: prefer the row whose seniority band is closest to the job's
      // resolved seniority. (Was: lowest modus, which let noise-sink rows race-to-the-bottom
      // win when no real match existed.) Lowest modus only kicks in if seniority is also tied.
      const jobRank = HAYS_SENIORITY_RANK[seniority] ?? 0;
      if (jobRank > 0) {
        const aDist = Math.abs((HAYS_SENIORITY_RANK[a.row.seniority] ?? 0) - jobRank);
        const bDist = Math.abs((HAYS_SENIORITY_RANK[b.row.seniority] ?? 0) - jobRank);
        if (aDist !== bDist) return aDist > bDist ? b : a;
      }
      return b.row.modus < a.row.modus ? b : a;
    },
    { row: null, score: -1 },
  );

  if (!best.row) {
    // Fallback: pick first row and mark low confidence
    const first = rowsRaw[0]!;
    const min = scaleHufDayLikeBandIfNeeded(first.min, benchmarkCurrency, params.jobParsed.job_type);
    const max = scaleHufDayLikeBandIfNeeded(first.max, benchmarkCurrency, params.jobParsed.job_type);
    const modus = Math.round((min + max) / 2);
    const normalizedMin = convertCurrency(min, benchmarkCurrency, comparisonCurrency);
    const normalizedMax = convertCurrency(max, benchmarkCurrency, comparisonCurrency);
    const normalizedModus = Math.round((normalizedMin + normalizedMax) / 2);
    const status = computeMatchStatus(normalizedModus, floorInComparison);
    const srcNote = formatHaysJsonDataParenthetical(first, { scaledDailyBandToMonthly: false });
    const lowDiag = benchmarkParenthetical(srcNote);
    return {
      salary_analysis: {
        hays_matched_label: first.hays_label,
        confidence_score: 0.2,
        low_confidence: true,
        estimated_min: min,
        estimated_max: max,
        estimated_modus: modus,
        match_status: status,
        rationale: `Low confidence: no exact match. Using ${first.hays_label} (${formatCurrency(modus, benchmarkCurrency)}). (${lowDiag})`,
        salary_forecast_display: buildSalaryForecastDisplay({
          source: 'market_benchmark',
          low_confidence: true,
          comparable_modus: normalizedModus,
          comparison_currency: comparisonCurrency as SalaryForecastCurrency,
          floor_amount: floorInComparison,
          match_status: status,
          row: {
            hays_label: first.hays_label,
            seniority: first.seniority,
            function: first.function,
            job_family: first.job_family,
            role: first.role,
            industry: first.industry,
          },
          supplement: lowDiag,
        }),
        source: 'market_benchmark',
        currency: benchmarkCurrency,
        base_salary: {
          estimated_min: min,
          estimated_max: max,
          estimated_modus: modus,
          basis: 'gross',
        },
        bonus_detected: bonusDetected,
        benefits_value: benefitsValue,
        normalized_net_estimate: estimateNetFromGross(normalizedModus, comparisonCurrency, params.jobText),
        comparison_currency: comparisonCurrency,
        normalized_estimated_min: normalizedMin,
        normalized_estimated_max: normalizedMax,
        normalized_estimated_modus: normalizedModus,
        conversion_applied: benchmarkCurrency !== comparisonCurrency,
        exchange_rate_used: getExchangeRateUsed(benchmarkCurrency, comparisonCurrency),
      },
    };
  }

  let row = best.row;
  let matchScore = best.score;
  let llmRefineNote: string | null = null;
  const llmPick = await maybeRefineHaysRowWithLlmFallback({
    primaryTitle,
    jobText: params.jobText,
    scored,
    currentRow: row,
    currentScore: matchScore,
    model: params.model,
    hasFixture: Boolean(params.fixture),
  });
  if (llmPick) {
    const proposed = pickHaysRowForSeniorityBand(rowsRaw, llmPick.row.hays_label, seniority);
    // Seniority-overshoot guard: pickHaysRowForSeniorityBand falls through to higher bands
    // when the picked label only has Lead rows (e.g. Plant Management / Operations Management).
    // For titles without an explicit Lead/Director/Principal marker (titleImpliedSeniorityCap
    // returns 'Senior'), refuse the LLM pick when it overshoots the resolved seniority. This
    // keeps Plant Mgmt Lead 3.75M out of Specialist / Coordinator / Manager pools regardless
    // of how the LLM ranks the shortlist on token overlap.
    const jRank = HAYS_SENIORITY_RANK[seniority] ?? 0;
    const rRank = HAYS_SENIORITY_RANK[proposed.seniority] ?? 0;
    const titleAllowsLead = titleImpliedSeniorityCap(primaryTitle) === null;
    const overshoots = jRank > 0 && rRank > jRank && !titleAllowsLead;
    if (!overshoots) {
      row = proposed;
      llmRefineNote = llmPick.note;
      const changed = row.hays_label !== best.row.hays_label;
      matchScore = Math.max(matchScore, changed ? 0.48 : 0.32);
    }
  }

  // No-confident-match fallback: when nothing in the dataset has meaningful overlap with the
  // title (matchScore below ~0.08 means the enriched best is essentially noise), swap to a
  // synthetic row carrying the dataset-wide median min/max/modus for the resolved seniority.
  // This avoids the "noise-sink wins" effect on emerging-field titles (3D reconstruction,
  // robotics R&D, etc.) where the Hays HU 2026 dataset has no direct equivalent.
  let usedMedianFallback = false;
  if (matchScore < 0.08) {
    const medians = getHaysSeniorityMedians(rowsRaw);
    const tier = seniority && seniority !== 'unknown' ? seniority : 'Medior';
    const target = medians.get(tier) ?? medians.get('Medior');
    if (target && target.sampleSize >= 3) {
      row = buildSyntheticMedianRow(target, tier);
      usedMedianFallback = true;
    }
  }

  // Handle IT Contracting day-rate => monthly
  let modus = row.modus;
  let min = row.min;
  let max = row.max;
  const isContracting = (params.jobParsed.job_type || '').toLowerCase().includes('contract');
  const hasDayOrHourRateHint = hasDayRateHint(params.jobText) || hasHourlyRateHint(params.jobText);
  const isDailyBand = isLikelyHaysDailyContractBenchmarkRow(row);
  /**
   * Scale HUF/day IT contracting bands to ~monthly when the job is contract/day-rate, or when an FT title
   * strongly matches that contracting row (e.g. Scrum Master).
   *
   * IMPORTANT: only scale when the row's own min/max are clearly day-rate values (i.e.
   * `isDailyBand` is true). Some v4 rows carry a `day_rate` field ALONGSIDE monthly
   * min/max/modus (e.g. HR Business Partner Senior: day_rate=100k, monthly modus=2M).
   * Multiplying those already-monthly values by 20 produced absurd 26M+ HUF figures.
   */
  const scaledDailyBandToMonthly = Boolean(
    row.day_rate != null &&
      row.day_rate > 0 &&
      isDailyBand &&
      (isContracting || hasDayOrHourRateHint || matchScore >= 0.62),
  );
  if (scaledDailyBandToMonthly) {
    const dayRate = row.day_rate!;
    min = Math.round(dayRate * 20);
    max = Math.round(row.max * 20);
    modus = Math.round(row.modus * 20);
  }
  min = scaleHufDayLikeBandIfNeeded(min, benchmarkCurrency, params.jobParsed.job_type);
  max = scaleHufDayLikeBandIfNeeded(max, benchmarkCurrency, params.jobParsed.job_type);
  modus = Math.round((min + max) / 2);

  // v4 skill premium: when row carries `skill_premium_multiplier` AND the job text exposes
  // overlapping hot skills, lift min/max/modus per the dataset guide (compounds AI/cloud/SAP etc.).
  // Coherence gate: a weak title-fit means we may be on the wrong role band, so no premium.
  const titleCoherence = scoreMatchTitleToHays(primaryTitle, row.hays_label);
  const premium = applySkillPremium({ row, jobTokens, titleCoherence, min, max, modus });
  min = premium.min;
  max = premium.max;
  modus = premium.modus;

  const normalizedMin = convertCurrency(min, benchmarkCurrency, comparisonCurrency);
  const normalizedMax = convertCurrency(max, benchmarkCurrency, comparisonCurrency);
  const normalizedModus = Math.round((normalizedMin + normalizedMax) / 2);

  const status = computeMatchStatus(normalizedModus, floorInComparison);

  const haysJsonNote = formatHaysJsonDataParenthetical(row, { scaledDailyBandToMonthly });
  const diag = benchmarkParenthetical(haysJsonNote);

  // Compact rationale: keep the headline statement short so it fits the dashboard / discovery
  // snapshot slice without truncating premium / heat / refine details.
  const delta = ((normalizedModus - floorInComparison) / floorInComparison) * 100;
  const relation =
    status === 'above_limit'
      ? `${Math.round(delta)}% above your minimum`
      : status === 'borderline'
        ? 'around your minimum'
        : `${Math.round(-delta)}% below your minimum`;
  // Use the picked row's seniority band for the headline (matches the displayed modus).
  // Falls back to the job-resolved label when the row has no clear seniority (e.g. "unknown").
  const headlineSeniority =
    row.seniority && row.seniority !== 'unknown' ? `${row.seniority} band` : seniority;
  const extras: string[] = [];
  if (matchScore < 0.18 && !usedMedianFallback) {
    extras.push('low confidence — weak title match');
  }
  if (premium.premiumApplied) {
    const skills = premium.matchedSkills!.join(', ');
    const coverage =
      premium.matchedCount! < premium.totalCount!
        ? ` (${premium.matchedCount}/${premium.totalCount} tags)`
        : '';
    extras.push(`+${premium.premiumPct}% hot-skills${coverage}: ${skills}`);
  }
  if (row.market_heat && row.market_heat !== 'stable') {
    extras.push(`heat ${row.market_heat.replace('_', ' ')}`);
  }
  if (isSyntheticEstimateRow(row)) {
    extras.push('synthetic 2026 estimate');
  }
  const extrasStr = extras.length ? ` · ${extras.join(' · ')}` : '';
  let rationale: string;
  if (usedMedianFallback) {
    // Make the fallback explicit so the user knows the figure is a dataset-level default,
    // not a specific role benchmark. The displayed band reflects HU median for the tier.
    rationale = `No confident Hays match — using HU ${headlineSeniority} median ~${formatCurrency(modus, benchmarkCurrency)} (${relation}).${extrasStr}`;
  } else if (status === 'below_limit' && bonusDetected && benefitsValue) {
    rationale = `Base ${formatCurrency(modus, benchmarkCurrency)} below your ${formatCurrency(floorInComparison, comparisonCurrency)} goal, but bonus + ${benefitsValue} may bridge the gap.${extrasStr} (${diag})`;
  } else {
    rationale = `Hays 2026: typical ${headlineSeniority} ~${formatCurrency(modus, benchmarkCurrency)} (${relation}).${extrasStr} (${diag})`;
  }
  if (llmRefineNote && !usedMedianFallback) {
    rationale += ` Refined: ${llmRefineNote}`;
  }

  // Confidence: base = matchScore + 0.2, then nudged by market_heat (very_hot +0.05, hot +0.02)
  // and multiplied by row.market_confidence (high=1, medium=0.9, estimated_high=0.85, estimated=0.8, low=0.7).
  const heatDelta = marketHeatConfidenceDelta(row.market_heat);
  const confidenceMul = marketConfidenceMultiplier(row.market_confidence);
  const baseConfidence = matchScore + 0.2 + heatDelta;
  const adjustedConfidence = Math.max(0, Math.min(1, baseConfidence * confidenceMul));

  const lowConfidence =
    usedMedianFallback ||
    matchScore < 0.3 ||
    adjustedConfidence < 0.6 ||
    (!usedMedianFallback && matchScore < 0.18);

  const supplementParts: string[] = [];
  if (experienceNote) supplementParts.push(experienceNote);
  if (usedMedianFallback) {
    supplementParts.push('No close Hays role match — Hungary-wide median for this seniority tier.');
  } else if (matchScore < 0.18) {
    supplementParts.push('Weak title ↔ benchmark match — rough guidance only.');
  }
  if (premium.premiumApplied) {
    const skills = premium.matchedSkills!.join(', ');
    const coverage =
      premium.matchedCount! < premium.totalCount!
        ? ` (${premium.matchedCount}/${premium.totalCount} skill tags)`
        : '';
    supplementParts.push(`Hot-skills uplift ~+${premium.premiumPct}%${coverage}: ${skills}`);
  }
  if (row.market_heat && row.market_heat !== 'stable') {
    supplementParts.push(`Market heat: ${String(row.market_heat).replace(/_/g, ' ')}`);
  }
  if (isSyntheticEstimateRow(row)) {
    supplementParts.push('Dataset uses an estimated / hot-skills-adjusted band for this role.');
  }
  if (llmRefineNote && !usedMedianFallback) {
    supplementParts.push(`Refined: ${llmRefineNote}`);
  }
  const supplementJoined = supplementParts.length ? supplementParts.join(' · ').slice(0, 380) : undefined;

  return {
    salary_analysis: {
      hays_matched_label: row.hays_label,
      confidence_score: usedMedianFallback ? Math.min(adjustedConfidence, 0.35) : adjustedConfidence,
      low_confidence: lowConfidence,
      estimated_min: min,
      estimated_max: max,
      estimated_modus: modus,
      match_status: status,
      rationale,
      salary_forecast_display: buildSalaryForecastDisplay({
        source: 'market_benchmark',
        low_confidence: lowConfidence,
        comparable_modus: normalizedModus,
        comparison_currency: comparisonCurrency as SalaryForecastCurrency,
        floor_amount: floorInComparison,
        match_status: status,
        row: {
          hays_label: row.hays_label,
          seniority: row.seniority,
          function: row.function,
          job_family: row.job_family,
          role: row.role,
          industry: row.industry,
        },
        supplement: supplementJoined,
      }),
      source: 'market_benchmark',
      currency: benchmarkCurrency,
      base_salary: {
        estimated_min: min,
        estimated_max: max,
        estimated_modus: modus,
        basis: 'gross',
      },
      bonus_detected: bonusDetected,
      benefits_value: benefitsValue,
      normalized_net_estimate: estimateNetFromGross(normalizedModus, comparisonCurrency, params.jobText),
      comparison_currency: comparisonCurrency,
      normalized_estimated_min: normalizedMin,
      normalized_estimated_max: normalizedMax,
      normalized_estimated_modus: normalizedModus,
      conversion_applied: benchmarkCurrency !== comparisonCurrency,
      exchange_rate_used: getExchangeRateUsed(benchmarkCurrency, comparisonCurrency),
    },
  };
};

/** @deprecated Use `runSalaryOracle` — it runs the same shortlist LLM refine when heuristic match is weak. */
export const suggestHaysEquivalent = async (
  title: string,
  model?: string,
): Promise<{ label: string; confidence: number } | null> => {
  void title;
  void model;
  return null;
};
