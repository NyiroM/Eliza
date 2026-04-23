import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import type { JobParseResult } from '../types/job';
import { generateJsonWithOllamaStrict } from './llm/ollama';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataPath = path.join(repoRoot, 'data', 'salary', 'hays-hu-2026.json');

// Salary thresholds (HUF monthly)
const SALARY_FLOOR_DEFAULT = 1_000_000;
const BAND_BELOW_PCT = 0.15; // 15% below floor => below_limit
const BAND_UPPER_PCT = 0.10; // within 10% of floor => borderline

/** Parse minimum salary floor from user constraints (HUF). */
export function parseMinSalaryHufFromConstraints(constraints: string[]): number {
  if (!Array.isArray(constraints)) return SALARY_FLOOR_DEFAULT;
  const joined = constraints.join(' ').toLowerCase();
  // Match 1,000,000 HUF, 1000000, 1m huf, 1.000.000 HUF, etc.
  const m = joined.match(/(\d{1,3}(?:[\s.,]\d{3})*)\s*(?:huf|ft|forint|hungarian|\$)?/i);
  if (!m) return SALARY_FLOOR_DEFAULT;
  const num = parseInt(m[1].replace(/[\s.,]/g, ''), 10);
  return Number.isFinite(num) ? Math.max(100_000, num) : SALARY_FLOOR_DEFAULT;
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
async function loadHaysRows(): Promise<Array<{
  industry: string;
  hays_label: string;
  seniority: string;
  min: number;
  max: number;
  modus: number;
  day_rate?: number | null;
}>> {
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
export async function runSalaryOracle(params: {
  jobText: string;
  jobParsed: JobParseResult;
  constraints: string[];
  model?: string;
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
  };
}> {
  const floor = parseMinSalaryHufFromConstraints(params.constraints);

  // Load Hays data
  const rows = await loadHaysRows();
  if (!rows.length) {
    return {
      salary_analysis: {
        confidence_score: 0,
        estimated_min: 0,
        estimated_max: 0,
        estimated_modus: 0,
        match_status: 'below_limit',
        rationale: 'Salary data unavailable. Please ensure Hays HU 2026 JSON is present.',
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
  const best = scored.reduce((a, b) => (a.score > b.score ? a : b), { row: null, score: 0 });

  if (!best.row) {
    // Fallback: pick first row and mark low confidence
    const first = pool[0];
    const modus = first.modus;
    const status = computeMatchStatus(modus, floor);
    return {
      salary_analysis: {
        hays_matched_label: first.hays_label,
        confidence_score: 0.2,
        low_confidence: true,
        estimated_min: first.min,
        estimated_max: first.max,
        estimated_modus: modus,
        match_status: status,
        rationale: `Low confidence: no exact match. Using ${first.hays_label} (${modus.toLocaleString()} HUF).`,
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

  const status = computeMatchStatus(modus, floor);

  // Build rationale
  const delta = ((modus - floor) / floor) * 100;
  let rationale: string;
  if (status === 'above_limit') {
    rationale = `Based on Hays 2026, the typical salary for this ${seniority} role is ${modus.toLocaleString()} HUF, which is ${Math.round(delta)}% above your minimum.`;
  } else if (status === 'borderline') {
    rationale = `Based on Hays 2026, the typical salary for this ${seniority} role is ${modus.toLocaleString()} HUF, which is around your minimum.`;
  } else {
    rationale = `Based on Hays 2026, the typical salary for this ${seniority} role is ${modus.toLocaleString()} HUF, which is ${Math.round(-delta)}% below your minimum.`;
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
    },
  };
}

// Optional: LLM-assisted mapping for ambiguous titles (future extension)
export async function suggestHaysEquivalent(title: string, model?: string): Promise<{ label: string; confidence: number } | null> {
  // Placeholder: in a future iteration, call LLM to map ambiguous titles like "Tech Wizard" to closest Hays label.
  return null;
}
