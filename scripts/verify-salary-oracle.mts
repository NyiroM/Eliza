#!/usr/bin/env node

import * as salaryOracleModule from '../lib/salary-oracle';
import type { JobParseResult } from '../types/job';

const runSalaryOracle =
  (salaryOracleModule as unknown as { runSalaryOracle?: typeof import('../lib/salary-oracle').runSalaryOracle }).runSalaryOracle ??
  (salaryOracleModule as unknown as { default?: { runSalaryOracle?: typeof import('../lib/salary-oracle').runSalaryOracle } }).default?.runSalaryOracle;

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

async function main() {
  console.log('Running Salary Oracle self-tests...\n');

  const tests: Array<{
    name: string;
    jobText: string;
    seniority: string;
    constraints: string[];
    expected: string;
    minModus?: number;
    forbidLabel?: string;
    jobExperienceYears?: number | null;
    cvExperienceYears?: number | null;
    rationaleMustInclude?: string;
  }> = [
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
      name: 'Ambiguous title (unknown seniority) must not pick daily IT Contracting row',
      jobText: 'Tech Wizard needed to slay bugs and ship magic.',
      seniority: 'unknown',
      constraints: ['1000000 HUF minimum'],
      expected: 'below_limit',
      minModus: 450_000,
      forbidLabel: 'IT Contracting',
    },
    {
      name: 'Senior developer unknown seniority prefers monthly Hays band over day-rate row',
      jobText: 'Senior Python developer for cloud microservices team.',
      seniority: 'unknown',
      constraints: ['1000000 HUF minimum'],
      expected: 'above_limit',
      minModus: 1_000_000,
      forbidLabel: 'IT Contracting',
    },
    {
      name: 'HUF per-hour gross converts to approximate monthly (not treated as 2750 HUF/month)',
      jobText:
        'Logistics intern (student work). Gross compensation 2 750 HUF per hour. Location Budapest. Salary pay scale.',
      seniority: 'junior',
      constraints: ['Minimum salary 1000000 HUF gross monthly'],
      expected: 'below_limit',
      minModus: 400_000,
    },
    {
      name: 'HU órabér label (no English) still scales small HUF amount vs monthly floor',
      jobText:
        'Diákmunka Budapest. Juttatás: bruttó órabér 2 750 Ft. A munkavégzés helye iroda. Fizetés részletek a jelentkezés után.',
      seniority: 'junior',
      constraints: ['Minimum salary 1000000 HUF gross monthly'],
      expected: 'below_limit',
      minModus: 400_000,
    },
    {
      name: 'Experience blend appears in rationale when job + CV years passed',
      jobText: 'Junior IT Support role based in Budapest, 2 years experience required.',
      seniority: 'junior',
      constraints: ['Minimum salary 1000000 HUF'],
      expected: 'below_limit',
      jobExperienceYears: 3,
      cvExperienceYears: 1,
      rationaleMustInclude: 'blend 2y',
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const t of tests) {
    console.log(`Test: ${t.name}`);
    try {
      if (!runSalaryOracle) {
        throw new Error('runSalaryOracle export is not available');
      }
      const analysis = await runSalaryOracle({
        jobText: t.jobText,
        jobParsed: {
          required_skills: [],
          optional_skills: [],
          estimated_salary: null,
          required_seniority: t.seniority as JobParseResult['required_seniority'],
          experience_years: t.jobExperienceYears ?? null,
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
        fixture: testFixture,
        jobExperienceYears: t.jobExperienceYears,
        cvExperienceYears: t.cvExperienceYears,
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

      let ok = sa.match_status === t.expected;
      if (ok && typeof t.minModus === 'number' && sa.estimated_modus < t.minModus) {
        console.error(`  ❌ FAIL: expected modus >= ${t.minModus}, got ${sa.estimated_modus}`);
        ok = false;
      }
      if (ok && t.forbidLabel && sa.hays_matched_label === t.forbidLabel) {
        console.error(`  ❌ FAIL: must not pick Hays row ${t.forbidLabel}`);
        ok = false;
      }
      if (ok && t.rationaleMustInclude && !sa.rationale.includes(t.rationaleMustInclude)) {
        console.error(`  ❌ FAIL: rationale must include "${t.rationaleMustInclude}"`);
        ok = false;
      }
      if (ok) {
        console.log('  ✅ PASS\n');
        passed++;
      } else if (sa.match_status !== t.expected) {
        console.error(`  ❌ FAIL: expected ${t.expected}, got ${sa.match_status}\n`);
        failed++;
      } else {
        failed++;
        console.log('');
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
