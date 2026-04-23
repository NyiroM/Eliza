#!/usr/bin/env node

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runSalaryOracle, parseMinSalaryHufFromConstraints } from '../lib/salary-oracle.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Minimal test fixture to avoid needing the real PDF in CI
const testFixture = [
  {
    industry: 'IT / Software',
    hays_label: 'Junior IT Support',
    seniority: 'Junior',
    min: 450_000,
    max: 650_000,
    modus: 550_000,
    day_rate: null,
  },
  {
    industry: 'IT / Software',
    hays_label: 'Automation Engineer',
    seniority: 'Senior',
    min: 1_200_000,
    max: 1_500_000,
    modus: 1_350_000,
    day_rate: null,
  },
  {
    industry: 'IT / Software',
    hays_label: 'IT Contracting',
    seniority: 'Medior',
    min: 40_000,
    max: 50_000,
    modus: 45_000,
    day_rate: 45_000,
  },
];

// Override the loader for the test
const dataPath = path.join(repoRoot, 'data', 'salary', 'hays-hu-2026.json');
const originalReadFile = fs.readFile;
fs.readFile = async (p: any, ...args: any[]) => {
  if (String(p).includes('hays-hu-2026.json')) {
    return JSON.stringify(testFixture, null, 2);
  }
  return originalReadFile.call(fs, p, ...args);
};

async function main() {
  console.log('Running Salary Oracle self-tests...\n');

  const tests = [
    {
      name: 'Junior IT Support (RED vs 1M)',
      jobText: 'Junior IT Support role based in Budapest, 2 years experience required.',
      seniority: 'junior',
      constraints: ['Minimum salary 1000000 HUF'],
      expected: 'below_limit',
    },
    {
      name: 'Senior Automation (GREEN)',
      jobText: 'Senior Automation Engineer with Python and CI/CD pipelines.',
      seniority: 'senior',
      constraints: ['Salary floor 1000000 HUF'],
      expected: 'above_limit',
    },
    {
      name: 'Ambiguous Title (Low Confidence)',
      jobText: 'Tech Wizard needed to slay bugs and ship magic.',
      seniority: 'unknown',
      constraints: ['1000000 HUF minimum'],
      expected: 'below_limit',
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    console.log(`Test: ${t.name}`);
    try {
      const analysis = await runSalaryOracle({
        jobText: t.jobText,
        jobParsed: {
          required_skills: [],
          optional_skills: [],
          estimated_salary: null,
          required_seniority: t.seniority as any,
          experience_years: null,
          education: null,
          job_location: null,
          work_model: 'unknown',
          job_type: 'full-time',
          benefits: [],
          commitments: [],
          metadata_constraint_notes: [],
          parser_source: 'llm',
          english_job_text: t.jobText,
        },
        constraints: t.constraints,
        model: 'deepseek-r1:8b',
      });

      const sa = analysis.salary_analysis;
      if (!sa) {
        console.error('  ❌ FAIL: no salary_analysis returned');
        failed++;
        continue;
      }

      console.log(`  - Hays label: ${sa.hays_matched_label}`);
      console.log(`  - Confidence: ${sa.confidence_score}`);
      console.log(`  - Modus: ${sa.estimated_modus.toLocaleString()} HUF`);
      console.log(`  - Match status: ${sa.match_status}`);
      console.log(`  - Rationale: ${sa.rationale}`);

      if (sa.match_status === t.expected) {
        console.log('  ✅ PASS\n');
        passed++;
      } else {
        console.error(`  ❌ FAIL: expected ${t.expected}, got ${sa.match_status}\n`);
        failed++;
      }
    } catch (e) {
      console.error(`  ❌ FAIL: exception ${e}\n`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('Self-test failed. Exiting with error.');
    process.exit(1);
  }
  console.log('All self-tests passed.');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
