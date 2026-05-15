"use client";

import type { SalaryForecastDisplay } from "@/types/pipeline";

export type SalaryForecastUiModel = {
  match_status: "above_limit" | "borderline" | "below_limit";
  source: "posted" | "market_benchmark";
  rationale: string;
  display?: SalaryForecastDisplay | null;
};

const WARN_TITLE = "Low confidence — benchmark may not match this job title well";
const DOC_TITLE = "Salary taken from text in the job posting";

export function SalaryForecastCard({ s }: { s: SalaryForecastUiModel }) {
  const d = s.display;
  if (!d) {
    return <p className="text-slate-400 leading-snug text-[11px]">{s.rationale}</p>;
  }
  return (
    <div className="space-y-1 text-[11px] leading-snug">
      <p className="font-semibold text-slate-100">{d.estimate_headline}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {d.low_confidence ? (
          <span
            className="inline-flex items-center gap-1 rounded border border-orange-800/55 bg-orange-950/45 px-1.5 py-0.5 text-orange-200"
            title={WARN_TITLE}
          >
            <svg className="h-3.5 w-3.5 shrink-0 text-orange-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 2 2 22h20L12 2zm0 3.8L18.4 20H5.6L12 5.8zM11 10h2v5h-2v-5zm0 6h2v2h-2v-2z" />
            </svg>
            <span className="font-medium">Low confidence</span>
          </span>
        ) : null}
        {d.source_from_posting ? (
          <span
            className="inline-flex items-center gap-1 rounded border border-sky-800/50 bg-sky-950/40 px-1.5 py-0.5 text-sky-200"
            title={DOC_TITLE}
          >
            <svg className="h-3.5 w-3.5 shrink-0 text-sky-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11zM8 12h8v2H8v-2zm0 4h8v2H8v-2z" />
            </svg>
            <span className="font-medium">From posting</span>
          </span>
        ) : null}
      </div>
      {!d.source_from_posting && d.benchmark_basis ? (
        <p className="text-slate-400">
          <span className="text-slate-500">Benchmark basis:</span> {d.benchmark_basis.discipline ?? "—"} ·{" "}
          <span className="font-medium text-slate-300">{d.benchmark_basis.seniority}</span> ·{" "}
          <span className="font-medium text-slate-300">{d.benchmark_basis.position}</span>
        </p>
      ) : null}
      <p className="text-slate-500">{d.floor_comparison}</p>
      {d.supplement ? <p className="text-slate-600 text-[10px] leading-snug">{d.supplement}</p> : null}
    </div>
  );
}
