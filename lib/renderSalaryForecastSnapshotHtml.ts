// lib/renderSalaryForecastSnapshotHtml.ts
/** Compact HTML for Discovery list export (salary forecast snapshot). */
import type { DiscoverySalaryForecastSnapshot } from "../types/discovery";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const ICON_WARN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 2 2 22h20L12 2zm0 3.8L18.4 20H5.6L12 5.8zM11 10h2v5h-2v-5zm0 6h2v2h-2v-2z"/></svg>`;

const ICON_DOC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11zM8 12h8v2H8v-2zm0 4h8v2H8v-2z"/></svg>`;

/** Inner HTML for the salary card (no outer wrapper). */
export function renderSalaryForecastSnapshotInnerHtml(s: DiscoverySalaryForecastSnapshot): string {
  const d = s.display;
  if (!d) {
    return `<p class="sf-fallback">${escapeHtml(s.rationale)}</p>`;
  }
  const icons: string[] = [];
  if (d.low_confidence) {
    icons.push(
      `<span class="sf-ic sf-ic--warn" title="Low confidence — benchmark may not match this job title well">${ICON_WARN_SVG}<span class="sf-tag sf-tag--warn">Low confidence</span></span>`,
    );
  }
  if (d.source_from_posting) {
    icons.push(
      `<span class="sf-ic sf-ic--doc" title="Salary taken from text in the job posting">${ICON_DOC_SVG}<span class="sf-tag sf-tag--doc">From posting</span></span>`,
    );
  }
  const iconRow = icons.length ? `<div class="sf-icons">${icons.join("")}</div>` : "";

  let basisLine = "";
  if (!d.source_from_posting && d.benchmark_basis) {
    const { discipline, seniority, position } = d.benchmark_basis;
    const disc = discipline ? escapeHtml(discipline) : "—";
    basisLine = `<p class="sf-basis"><span class="sf-muted">Benchmark basis:</span> ${disc} · <strong>${escapeHtml(
      seniority,
    )}</strong> · <strong>${escapeHtml(position)}</strong></p>`;
  }

  const sup = d.supplement ? `<p class="sf-sup">${escapeHtml(d.supplement)}</p>` : "";

  return `<p class="sf-head">${escapeHtml(d.estimate_headline)}</p>${iconRow}${basisLine}<p class="sf-floor">${escapeHtml(
    d.floor_comparison,
  )}</p>${sup}`;
}
