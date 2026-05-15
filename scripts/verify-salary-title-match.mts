// scripts/verify-salary-title-match.mts
// Regression: primary title snippet + scoreMatchTitleToHays must not map Scrum Master → Master Data Analyst.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as salaryOracleNs from '../lib/salary-oracle';

const salaryOracle = (salaryOracleNs as unknown as { default?: object }).default ?? salaryOracleNs;
const inferPrimaryJobTitleForBenchmark = (salaryOracle as Record<string, unknown>)
  .inferPrimaryJobTitleForBenchmark as (t: string) => string;
const scoreMatchTitleToHays = (salaryOracle as Record<string, unknown>).scoreMatchTitleToHays as (
  a: string,
  b: string,
) => number;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = path.join(__dirname, '..', 'data', 'salary', 'hays-hu-2026.json');

type Row = { hays_label: string; seniority: string };

function roleTail(label: string): string {
  const parts = label.split('›').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : label.trim();
}

function bestLabel(rows: Row[], jobPost: string): { score: number; label: string; primary: string } {
  const primary = inferPrimaryJobTitleForBenchmark(jobPost);
  let best = { score: -1, label: '' };
  for (const r of rows) {
    const s = scoreMatchTitleToHays(primary, r.hays_label);
    if (s > best.score) best = { score: s, label: r.hays_label };
  }
  return { ...best, primary };
}

const rows = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Row[];

const titles: string[] = [
  'Scrum Master',
  'Agile Coach',
  'Product Owner',
  'Senior Scrum Master',
  'Master Data Analyst',
  'Data Engineer',
  'Data Scientist',
  'Software Engineer',
  'Full Stack Developer',
  'Backend Developer',
  'Frontend Developer',
  'DevOps Engineer',
  'Site Reliability Engineer',
  'Project Manager',
  'Product Manager',
  'Business Analyst',
  'Könyvelő',
  'Junior könyvelő',
  'Adótanácsadó',
  'HR Business Partner',
  'Ügyfélszolgálati munkatárs',
  'Sales Engineer',
  'Account Manager',
  'Penetration Tester',
  'Cloud Architect',
  'Machine Learning Engineer',
  'Scrum Master — banki digitalizáció',
];

console.log('title_primary_snippet | best_score | best_role_tail');
console.log('-'.repeat(100));
for (const t of titles) {
  const jobPost = `${t}\n\nWe are hiring in Budapest. Hybrid model. Competitive package.`;
  const r = bestLabel(rows, jobPost);
  const tail = roleTail(r.label);
  console.log(`${r.primary.slice(0, 44).padEnd(46)} | ${r.score.toFixed(2).padStart(6)} | ${tail.slice(0, 70)}`);
}

const smPost =
  'Scrum Master\n\nOur tribe needs a Scrum Master to facilitate sprint ceremonies. Agile mindset required.';
const sm = bestLabel(rows, smPost);
const smBad = /\bMaster\s+Data\b/i.test(roleTail(sm.label)) && !/\bScrum\s+Master\b/i.test(roleTail(sm.label));
console.log('-'.repeat(100));
console.log(
  smBad
    ? 'FAIL: Scrum Master posting mapped to Master Data–like row.'
    : `OK: Scrum Master → "${roleTail(sm.label).slice(0, 60)}" (score ${sm.score.toFixed(2)})`,
);
