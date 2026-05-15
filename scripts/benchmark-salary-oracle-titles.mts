// scripts/benchmark-salary-oracle-titles.mts
// Batch-evaluate runSalaryOracle title → Hays row mapping (real hays-hu-2026.json).

import * as salaryOracleNs from '../lib/salary-oracle';
import type { JobParseResult } from '../types/job';

const salaryOracle = (salaryOracleNs as unknown as { default?: object }).default ?? salaryOracleNs;
const runSalaryOracle = (salaryOracle as Record<string, unknown>).runSalaryOracle as typeof import('../lib/salary-oracle').runSalaryOracle;

const RAW_LIST = `AI Engineer, AI Consultant & Strategist, Machine Learning Operations (MLOps) Engineer, Data Scientist, Data Analyst, AI Prompt Engineer, Data Engineer, Analytics Translator, AI Ethics Specialist, Business Intelligence (BI) Developer, Full Stack Developer, Backend Developer, Frontend Developer, Cloud Architect, DevOps Engineer, Cybersecurity Analyst, Solutions Architect, Quality Assurance (QA) Automation Engineer, Site Reliability Engineer (SRE), Mobile App Developer, Embedded Systems Engineer, Product Manager, Product Owner, Agile Coach, Scrum Master, Project Management Officer (PMO), Technical Product Manager, Delivery Manager, Program Manager, Operations Manager, Business Process Manager, Growth Marketer, Performance Marketing Specialist, Content Strategist, Social Media Manager, SEO Specialist, SEM Specialist, Influencer Marketing Manager, Brand Manager, Digital Marketing Specialist, Copywriter, UX Writer, Community Manager, Business Development Representative (BDR), Sales Development Representative (SDR), Account Executive, Key Account Manager, Customer Success Manager, Partnership Manager, Revenue Operations (RevOps) Manager, Sales Operations Specialist, Commercial Director, Inside Sales Specialist, Talent Acquisition Partner, Technical Recruiter, HR Business Partner (HRBP), People & Culture Manager, Employer Branding Specialist, Employee Experience Lead, HR Operations Specialist, Diversity, Equity & Inclusion (DEI) Manager, Learning & Development (L&D) Specialist, People Analytics Manager, UX/UI Designer, Product Designer, Interaction Designer, Visual Designer, Service Designer, UX Researcher, Creative Director, Motion Designer, Design Systems Manager, Immersive Content Designer, Financial Analyst, Chief Financial Officer (CFO), Compliance Manager, Risk Manager, Legal Counsel, Tax Manager, Investment Analyst, Treasury Manager, Office Manager, Executive Assistant, Sustainability Consultant, ESG Manager, Renewable Energy Specialist, Circular Economy Expert, Carbon Footprint Analyst, Environmental Health and Safety (EHS) Manager, Green Energy Project Manager, Head of Remote, Customer Experience (CX) Lead, Digital Transformation Manager, Chief Digital Officer (CDO), Virtual Event Producer, Growth Hacker, E-commerce Manager, Supply Chain Resilience Architect, Blockchain Developer, Data Privacy Officer (DPO), CRM Administrator, Customer Onboarding Specialist`;

function splitCsvTitles(raw: string): string[] {
  const parts = raw.split(/\s*,\s*/).map((s) => s.trim()).filter(Boolean);
  const merged: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === 'Diversity' && parts[i + 1]?.startsWith('Equity')) {
      merged.push(`${p}, ${parts[i + 1]}`);
      i++;
      continue;
    }
    if (p === 'Learning' && parts[i + 1]?.startsWith('&')) {
      merged.push(`${p} ${parts[i + 1]}`);
      i++;
      continue;
    }
    merged.push(p);
  }
  return merged;
}

function roleTail(label: string | undefined): string {
  if (!label) return '';
  const parts = label.split('›').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : label.trim();
}

function baseJobParsed(seniority: JobParseResult['required_seniority']): JobParseResult {
  return {
    required_skills: [],
    optional_skills: [],
    estimated_salary: null,
    required_seniority: seniority,
    experience_years: null,
    education: null,
    job_location: 'Budapest, Hungary',
    work_model: 'hybrid',
    job_type: 'full-time',
    benefits: [],
    commitments: [],
    metadata_constraint_notes: [],
    parser_source: 'llm',
    english_job_text: '',
  };
}

async function main() {
  const titles = splitCsvTitles(RAW_LIST);
  const constraints = ['Minimum salary 1000000 HUF gross monthly'];
  const rows: string[] = [];
  rows.push('title\tconfidence\tlow_conf\tmodus_huf\tmatched_role_tail');

  for (const title of titles) {
    const jobText = `${title}\n\nWe are hiring in Budapest. Hybrid work. Competitive compensation.`;
    const jp = baseJobParsed('unknown');
    jp.english_job_text = jobText;
    const out = await runSalaryOracle({
      jobText,
      jobParsed: jp,
      constraints,
      model: 'skip',
    });
    const sa = out.salary_analysis;
    const tail = roleTail(sa?.hays_matched_label);
    const conf = sa?.confidence_score ?? 0;
    const low = sa?.low_confidence ? 'Y' : '';
    const mod = sa?.estimated_modus ?? 0;
    rows.push(`${title.slice(0, 72)}\t${conf.toFixed(2)}\t${low}\t${mod}\t${tail.slice(0, 90)}`);
  }

  console.log(rows.join('\n'));
  console.log(`\n--- ${titles.length} titles ---`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
