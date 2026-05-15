// scripts/benchmark-salary-oracle-titles-hu.mts
// HU/EN mixed title batch for salary oracle (model from env SALARY_BENCH_MODEL or "skip").

import * as salaryOracleNs from '../lib/salary-oracle';
import type { JobParseResult } from '../types/job';

const salaryOracle = (salaryOracleNs as unknown as { default?: object }).default ?? salaryOracleNs;
const runSalaryOracle = (salaryOracle as Record<string, unknown>).runSalaryOracle as typeof import('../lib/salary-oracle').runSalaryOracle;

const RAW_LIST = `AI Architect, Cloud Security Specialist, Rendszergazda, Full-Stack Mérnök, IT Support Specialist, Üzletmenet-folytonossági Tanácsadó, Network Engineer, Szoftvertesztelő, Database Administrator, Webfejlesztő, Solutions Consultant, Rendszerüzemeltető, Enterprise Architect, IT Projektkoordinátor, Big Data Architect, Adatbázis-fejlesztő, Hardware Engineer, Műszaki Tanácsadó, Technical Writer, IT Biztonsági Szakértő, Creative Copywriter, Marketing Kommunikációs Munkatárs, Paid Social Manager, Rendezvényszervező, Email Marketing Specialist, Piackutató, Brand Strategist, PR Menedzser, Media Buyer, Szövegíró, Video Editor, Grafikus, Content Creator, Tartalomkezelő, Trade Marketing Specialist, Marketingasszisztens, Logistics Coordinator, Logisztikai Ügyintéző, Supply Chain Analyst, Beszerzési Munkatárs, Procurement Manager, Raktárvezető, Demand Planner, Szállítmányozási Ügyintéző, Inventory Manager, Flottakezelő, Strategic Sourcing Manager, Vámügyintéző, Business Analyst, Üzleti Elemző, Operations Lead, Operatív Vezető, Strategy Manager, Stratégiai Tervező, Change Manager, Szervezetfejlesztési Tanácsadó, Chief Operating Officer, Ügyvezető Igazgató, Risk Analyst, Kockázatelemző, Internal Auditor, Belső Ellenőr, Tax Advisor, Könyvelő, Payroll Specialist, Bérszámfejtő, Credit Controller, Pénzügyi Kontroller, Investment Banker, Befektetési Tanácsadó, Billing Specialist, Számlázási Ügyintéző, Talent Sourcer, Toborzási Specialistra, HR Generalista, Benefit Specialist, Kompenzációs Tanácsadó, People Operations Specialist, HR Koordinátor, Workplace Experience Manager, Irodavezető, Training Manager, Oktatásszervező, Customer Support Lead, Ügyfélszolgálati Csoportvezető, Sales Manager, Értékesítési Képviselő, Territory Sales Manager, Területi Képviselő, Pre-sales Engineer, Értékesítési Mérnök, Account Manager, Ügyfélkapcsolati Menedzser, Retail Store Manager, Üzletvezető, Merchandiser, Polcszervizes, Area Sales Manager, Kereskedelmi Képviselő, Category Manager, Kategória Menedzser`;

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
  const model = (process.env.SALARY_BENCH_MODEL ?? 'skip').trim();
  const rows: string[] = [];
  rows.push('title\tconfidence\tlow_conf\tmodus_huf\tmatched_role_tail');

  for (const title of titles) {
    const jobText = `${title}\n\nFelvétel Budapesten. Hibrid munkavégzés. Juttatások.`;
    const jp = baseJobParsed('unknown');
    jp.english_job_text = jobText;
    const out = await runSalaryOracle({
      jobText,
      jobParsed: jp,
      constraints,
      model,
    });
    const sa = out.salary_analysis;
    const tail = roleTail(sa?.hays_matched_label);
    const conf = sa?.confidence_score ?? 0;
    const low = sa?.low_confidence ? 'Y' : '';
    const mod = sa?.estimated_modus ?? 0;
    rows.push(`${title.slice(0, 72)}\t${conf.toFixed(2)}\t${low}\t${mod}\t${tail.slice(0, 90)}`);
  }

  console.log(rows.join('\n'));
  console.log(`\n--- ${titles.length} titles (SALARY_BENCH_MODEL=${model || 'skip'}) ---`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
