import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import type { JobParseResult } from '../types/job';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataPath = path.join(repoRoot, 'data', 'salary', 'hays-hu-2026.json');

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
  for (const m of joined.matchAll(re)) {
    const amount = parseSmartNumber(m[2]);
    if (!amount || amount < 100) continue;
    const curr = normalizeCurrency(m[1] ?? m[3]) ?? fallbackCurrency;
    return { amount, currency: curr };
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
    const decimalSep = cleaned[cleaned.length - 3];
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

function hasSalaryKeywordWithinWindow(beforeText: string, afterText: string, windowWords = 10): boolean {
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

function isFullTimeOrContingent(jobType: string): boolean {
  return /(full[-\s]?time|contingent|contract)/i.test(jobType);
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

function extractPostedSalary(jobText: string, currency: CurrencyCode): {
  estimated_min: number;
  estimated_max: number;
  estimated_modus: number;
  basis: SalaryBasis;
} | null {
  const salaryRegex =
    /(?:(USD|EUR|GBP|HUF|PLN|JPY|[$€£¥])\s*)?(\d[\d\s.,]{1,18}\d)(?:\s*(?:-|–|to)\s*(\d[\d\s.,]{1,18}\d))?\s*(USD|EUR|GBP|HUF|PLN|JPY|[$€£¥])?/gi;
  let best: { min: number; max: number; score: number; basis: SalaryBasis } | null = null;
  for (const match of jobText.matchAll(salaryRegex)) {
    const tokenBefore = normalizeCurrency(match[1]);
    const tokenAfter = normalizeCurrency(match[4]);
    const matchCurrency = tokenBefore ?? tokenAfter ?? currency;
    if (matchCurrency !== currency) continue;

    const snippetStart = Math.max(0, (match.index ?? 0) - 120);
    const snippetEnd = Math.min(jobText.length, (match.index ?? 0) + match[0].length + 120);
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

    min = inferMonthlyFromDailyIfNeeded(min, currency, match[0]);
    max = inferMonthlyFromDailyIfNeeded(max, currency, match[0]);

    const score = (second ? 2 : 1) + (hasBaseSalaryMarker(match[0]) ? 1 : 0);
    const basis = detectSalaryBasis(match[0]);
    if (!best || score > best.score) {
      best = { min, max, score, basis };
    }
  }

  if (!best) return null;
  return {
    estimated_min: best.min,
    estimated_max: best.max,
    estimated_modus: Math.round((best.min + best.max) / 2),
    basis: best.basis,
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

/** Load Hays rows from committed JSON. */
async function loadHaysRows(fixture?: unknown): Promise<Array<{
  industry: string;
  hays_label: string;
  seniority: string;
  min: number;
  max: number;
  modus: number;
  day_rate?: number | null;
}>> {
  // Use fixture if provided (for tests)
  if (fixture && Array.isArray(fixture)) {
    return fixture as Array<{
      industry: string;
      hays_label: string;
      seniority: string;
      min: number;
      max: number;
      modus: number;
      day_rate?: number | null;
    }>;
  }
  // Fallback to file
  try {
    const raw = await fs.readFile(dataPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    console.error('[Salary Oracle] Failed to load Hays data:', e);
  }
  return [];
}

/** Simple BM25-like scoring to find closest Hays role. */
function scoreMatch(jobTitle: string, haysLabel: string): number {
  const a = jobTitle.toLowerCase();
  const b = haysLabel.toLowerCase();
  const wordsA = a.split(/\s+/).filter(Boolean);
  const wordsB = b.split(/\s+/).filter(Boolean);
  const common = wordsA.filter(w => wordsB.includes(w));
  const idf = Math.min(1, common.length / Math.max(1, wordsB.length));
  return idf;
}

/** Determine match status vs floor. */
function computeMatchStatus(modus: number, floor: number): 'above_limit' | 'borderline' | 'below_limit' {
  if (modus >= floor * (1 + BAND_UPPER_PCT)) return 'above_limit';
  if (modus <= floor * (1 - BAND_BELOW_PCT)) return 'below_limit';
  return 'borderline';
}

/** Run the salary oracle. */
export const runSalaryOracle = async (params: {
  jobText: string;
  jobParsed: JobParseResult;
  constraints: string[];
  model?: string;
  fixture?: unknown;
  preferredCurrency?: string | null;
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
      !hasDayRateHint(params.jobText);
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
    const rationale = belowButBonusBridge
      ? `The base salary is ${formatCurrency(scaledPostedModus, currency)}, which is below your ${formatCurrency(floorInComparison, comparisonCurrency)} goal, but the total package includes bonuses and ${benefitsValue} which may bridge the gap.`
      : `Posted compensation indicates a typical monthly ${posted.basis} base of ${formatCurrency(scaledPostedModus, currency)} (${relation}).`;
      return {
        salary_analysis: {
          confidence_score: 0.95,
          low_confidence: false,
          estimated_min: scaledPostedMin,
          estimated_max: scaledPostedMax,
          estimated_modus: scaledPostedModus,
          match_status: status,
          rationale,
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

  // Load Hays data
  const rows = await loadHaysRows(params.fixture);
  if (!rows.length) {
    return {
      salary_analysis: {
        confidence_score: 0,
        estimated_min: 0,
        estimated_max: 0,
        estimated_modus: 0,
        match_status: 'below_limit',
        rationale: 'Salary data unavailable. Please ensure Hays HU 2026 JSON is present.',
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

  const seniority = mapSeniorityToHays(params.jobParsed.required_seniority);
  const jobTitle = params.jobText;

  // Candidate rows filtered by seniority (if known)
  const candidates = rows.filter(r => r.seniority === seniority || seniority === 'unknown');

  // If no candidates by seniority, allow unknown seniority rows
  const pool = candidates.length > 0 ? candidates : rows;

  // Score matches
  const scored = pool.map(r => ({
    row: r,
    score: scoreMatch(jobTitle, r.hays_label),
  }));

  // Pick best match
  const best = scored.reduce<{ row: typeof rows[number] | null; score: number }>(
    (a, b) => (a.score > b.score ? a : b),
    { row: null, score: 0 }
  );

  if (!best.row) {
    // Fallback: pick first row and mark low confidence
    const first = pool[0];
    const min = scaleHufDayLikeBandIfNeeded(first.min, currency, params.jobParsed.job_type);
    const max = scaleHufDayLikeBandIfNeeded(first.max, currency, params.jobParsed.job_type);
    const modus = Math.round((min + max) / 2);
    const normalizedMin = convertCurrency(min, currency, comparisonCurrency);
    const normalizedMax = convertCurrency(max, currency, comparisonCurrency);
    const normalizedModus = Math.round((normalizedMin + normalizedMax) / 2);
    const status = computeMatchStatus(normalizedModus, floorInComparison);
    return {
      salary_analysis: {
        hays_matched_label: first.hays_label,
        confidence_score: 0.2,
        low_confidence: true,
        estimated_min: min,
        estimated_max: max,
        estimated_modus: modus,
        match_status: status,
        rationale: `Low confidence: no exact match. Using ${first.hays_label} (${formatCurrency(modus, currency)}).`,
        source: 'market_benchmark',
        currency,
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
        conversion_applied: currency !== comparisonCurrency,
        exchange_rate_used: getExchangeRateUsed(currency, comparisonCurrency),
      },
    };
  }

  const row = best.row;

  // Handle IT Contracting day-rate => monthly
  let modus = row.modus;
  let min = row.min;
  let max = row.max;
  const isContracting = (params.jobParsed.job_type || '').toLowerCase().includes('contract');
  if (isContracting && row.day_rate != null) {
    const dayRate = row.day_rate;
    min = Math.round(dayRate * 20);
    max = Math.round(row.max * 20);
    modus = Math.round(row.modus * 20);
  }
  min = scaleHufDayLikeBandIfNeeded(min, currency, params.jobParsed.job_type);
  max = scaleHufDayLikeBandIfNeeded(max, currency, params.jobParsed.job_type);
  modus = Math.round((min + max) / 2);

  const normalizedMin = convertCurrency(min, currency, comparisonCurrency);
  const normalizedMax = convertCurrency(max, currency, comparisonCurrency);
  const normalizedModus = Math.round((normalizedMin + normalizedMax) / 2);

  const status = computeMatchStatus(normalizedModus, floorInComparison);

  // Build rationale
  const delta = ((normalizedModus - floorInComparison) / floorInComparison) * 100;
  let rationale: string;
  if (status === 'above_limit') {
    rationale = `Based on Hays 2026, the typical salary for this ${seniority} role is ${formatCurrency(modus, currency)}, which is ${Math.round(delta)}% above your minimum.`;
  } else if (status === 'borderline') {
    rationale = `Based on Hays 2026, the typical salary for this ${seniority} role is ${formatCurrency(modus, currency)}, which is around your minimum.`;
  } else {
    rationale = `Based on Hays 2026, the typical salary for this ${seniority} role is ${formatCurrency(modus, currency)}, which is ${Math.round(-delta)}% below your minimum.`;
  }
  if (status === 'below_limit' && bonusDetected && benefitsValue) {
    rationale = `The base salary is ${formatCurrency(modus, currency)}, which is below your ${formatCurrency(floorInComparison, comparisonCurrency)} goal, but the total package includes bonuses and ${benefitsValue} which may bridge the gap.`;
  }

  return {
    salary_analysis: {
      hays_matched_label: row.hays_label,
      confidence_score: Math.min(1, best.score + 0.2), // small boost for seniority match
      low_confidence: best.score < 0.3,
      estimated_min: min,
      estimated_max: max,
      estimated_modus: modus,
      match_status: status,
      rationale,
      source: 'market_benchmark',
      currency,
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
      conversion_applied: currency !== comparisonCurrency,
      exchange_rate_used: getExchangeRateUsed(currency, comparisonCurrency),
    },
  };
};

// Optional: LLM-assisted mapping for ambiguous titles (future extension)
export const suggestHaysEquivalent = async (
  title: string,
  model?: string,
): Promise<{ label: string; confidence: number } | null> => {
  // Placeholder: in a future iteration, call LLM to map ambiguous titles like "Tech Wizard" to closest Hays label.
  return null;
};
