// lib/salaryForecastDisplay.ts
/** Human-readable salary forecast lines (dashboard, Discovery export, API). */

import type { SalaryForecastCurrency, SalaryForecastDisplay } from "../types/pipeline";

export type { SalaryForecastDisplay };

function formatMoney(amount: number, currency: SalaryForecastCurrency): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${Math.round(amount).toLocaleString("en-US")} ${currency}`;
  }
}

function roleTailFromHaysLabel(haysLabel: string): string {
  const parts = haysLabel.split("›").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : haysLabel.trim();
}

function disciplineFromBenchmarkRow(row: {
  hays_label: string;
  function?: string;
  job_family?: string;
  industry?: string;
}): string | null {
  const f = row.function?.trim();
  if (f) return f;
  const jf = row.job_family?.trim();
  if (jf) return jf.replace(/_/g, " ");
  const ind = row.industry?.trim();
  if (ind) return ind;
  const first = row.hays_label.split("›")[0]?.trim();
  return first || null;
}

function formatSeniorityLabel(s: string): string {
  const t = s.trim();
  if (!t || t === "unknown") return "unspecified band";
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

export function buildSalaryForecastDisplay(opts: {
  source: "posted" | "market_benchmark";
  low_confidence: boolean;
  comparable_modus: number;
  comparison_currency: SalaryForecastCurrency;
  floor_amount: number;
  match_status: "above_limit" | "borderline" | "below_limit";
  row: {
    hays_label: string;
    seniority: string;
    function?: string;
    job_family?: string;
    role?: string;
    industry?: string;
  } | null;
  posted_basis?: "gross" | "net";
  supplement?: string;
}): SalaryForecastDisplay {
  const cur = opts.comparison_currency;
  const amt = opts.comparable_modus;
  const floorFmt = formatMoney(opts.floor_amount, cur);
  const amtFmt = formatMoney(amt, cur);
  const basisWord = opts.posted_basis === "net" ? "net" : "gross";

  const deltaPct = Math.round(((amt - opts.floor_amount) / opts.floor_amount) * 100);
  const absPct = Math.abs(deltaPct);
  let floor_comparison: string;
  if (opts.match_status === "borderline") {
    floor_comparison = `vs your stated minimum (${floorFmt}/month, ${basisWord}): borderline — about the same band as your floor.`;
  } else if (opts.match_status === "above_limit") {
    floor_comparison = `vs your stated minimum (${floorFmt}/month, ${basisWord}): ~${absPct}% above.`;
  } else {
    floor_comparison = `vs your stated minimum (${floorFmt}/month, ${basisWord}): ~${absPct}% below.`;
  }

  const source_from_posting = opts.source === "posted";
  let estimate_headline: string;
  let benchmark_basis: SalaryForecastDisplay["benchmark_basis"] = null;

  if (source_from_posting) {
    estimate_headline = `From the job ad: ~${amtFmt}/month ${basisWord} (midpoint of the stated range).`;
  } else {
    estimate_headline = `Typical market midpoint: ~${amtFmt}/month gross (Hays HU 2026 benchmark).`;
    if (opts.row) {
      if (opts.row.hays_label.trim().startsWith('(no confident')) {
        benchmark_basis = {
          discipline: null,
          seniority: formatSeniorityLabel(opts.row.seniority),
          position: `Hungary-wide median (${formatSeniorityLabel(opts.row.seniority)} tier, all roles)`,
        };
      } else {
        const position = (opts.row.role?.trim() || roleTailFromHaysLabel(opts.row.hays_label)).trim();
        benchmark_basis = {
          discipline: disciplineFromBenchmarkRow(opts.row),
          seniority: formatSeniorityLabel(opts.row.seniority),
          position: position || '—',
        };
      }
    }
  }

  return {
    estimate_headline,
    low_confidence: opts.low_confidence,
    source_from_posting,
    benchmark_basis,
    floor_comparison,
    supplement: opts.supplement?.trim() || undefined,
  };
}
