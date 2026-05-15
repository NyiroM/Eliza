// lib/discovery/exportDiscoveryListsHtml.ts — HTML download of New matches + non-match rows (clickable URLs).
import type {
  DiscoveryMatchRow,
  DiscoveryNonMatchRow,
  DiscoverySalaryForecastSnapshot,
} from "../../types/discovery";
import { renderSalaryForecastSnapshotInnerHtml } from "../renderSalaryForecastSnapshotHtml";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/'/g, "&#39;");
}

function salaryForecastHeading(s: DiscoverySalaryForecastSnapshot): string {
  const st =
    s.match_status === "above_limit"
      ? "Above your floor"
      : s.match_status === "borderline"
        ? "Borderline vs floor"
        : "Below your floor";
  const src = s.source === "posted" ? "posted range" : "market benchmark";
  return `${st} (${src})`;
}

function salaryBlockHtml(s: DiscoverySalaryForecastSnapshot): string {
  return `<div class="salary"><strong>Salary forecast · ${escapeHtml(salaryForecastHeading(s))}</strong><div class="sf-card">${renderSalaryForecastSnapshotInnerHtml(s)}</div></div>`;
}

function formatCompanyTitle(company: string | null | undefined, title: string): string {
  const c = typeof company === "string" ? company.trim() : "";
  if (!c) return title;
  return `${c} - ${title}`;
}

function linkRow(url: string, label = "Open posting"): string {
  const u = url.trim();
  if (!u) return `<span class="muted">(no URL)</span>`;
  return `<a href="${escapeHtmlAttr(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a><br/><span class="url">${escapeHtml(u)}</span>`;
}

export type DiscoveryListsExportInput = {
  exportedAtIso: string;
  thresholdPercent: number;
  matches: DiscoveryMatchRow[];
  nonMatches: DiscoveryNonMatchRow[];
  newMatchesTotal: number;
  nonMatchesTotal: number;
};

export function buildDiscoveryListsHtmlDocument(input: DiscoveryListsExportInput): string {
  const {
    exportedAtIso,
    thresholdPercent,
    matches,
    nonMatches,
    newMatchesTotal,
    nonMatchesTotal,
  } = input;
  const exportedLabel = escapeHtml(new Date(exportedAtIso).toLocaleString());

  const matchRows = matches
    .map((m) => {
      const title = escapeHtml(formatCompanyTitle(m.company, m.title));
      const summary = m.one_sentence_summary ? `<p class="summary">${escapeHtml(m.one_sentence_summary)}</p>` : "";
      const salary = m.salary_forecast ? salaryBlockHtml(m.salary_forecast) : "";
      const veto = m.constraint_veto ? "Yes" : "No";
      return `<tr>
<td>${title}</td>
<td>${escapeHtml(m.provider)}</td>
<td>${escapeHtml(new Date(m.evaluated_at).toLocaleString())}</td>
<td class="num">${m.fit_score}%</td>
<td>${veto}</td>
<td>${summary}${salary}${linkRow(m.url)}</td>
</tr>`;
    })
    .join("\n");

  const nonRows = nonMatches
    .map((m) => {
      const title = escapeHtml(formatCompanyTitle(m.company, m.title));
      const summary =
        m.one_sentence_summary && m.one_sentence_summary !== m.not_match_reason
          ? `<p class="summary">${escapeHtml(m.one_sentence_summary)}</p>`
          : "";
      const salary = m.salary_forecast ? salaryBlockHtml(m.salary_forecast) : "";
      const veto = m.constraint_veto ? "Yes" : "No";
      return `<tr>
<td>${title}</td>
<td>${escapeHtml(m.provider)}</td>
<td>${escapeHtml(new Date(m.evaluated_at).toLocaleString())}</td>
<td class="num">${m.fit_score}%</td>
<td>${veto}</td>
<td><p class="reason">${escapeHtml(m.not_match_reason)}</p>${summary}${salary}${linkRow(m.url)}</td>
</tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>ELIZA Discovery — match lists</title>
<style>
  body { font-family: system-ui, Segoe UI, Roboto, sans-serif; background: #0f172a; color: #e2e8f0; margin: 24px; line-height: 1.45; }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1rem; margin-top: 1.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
  p.note { font-size: 0.8rem; color: #94a3b8; max-width: 52rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.85rem; }
  th, td { border: 1px solid #334155; padding: 8px 10px; vertical-align: top; text-align: left; word-break: break-word; }
  th { background: #1e293b; color: #cbd5e1; }
  tr:nth-child(even) td { background: #111c2e; }
  .num { text-align: right; white-space: nowrap; }
  a { color: #60a5fa; }
  a:visited { color: #93c5fd; }
  .url { font-size: 0.72rem; color: #64748b; word-break: break-all; }
  .summary { color: #cbd5e1; margin: 0.35rem 0; }
  .reason { color: #fecaca; margin: 0 0 0.35rem 0; }
  .salary { margin-top: 0.5rem; padding: 0.5rem 0.65rem; border: 1px solid #155e75; border-radius: 6px; background: #0c1a22; }
  .sf-card { margin-top: 0.35rem; }
  .sf-head { margin: 0 0 0.25rem 0; color: #f1f5f9; font-weight: 600; font-size: 0.82rem; line-height: 1.35; }
  .sf-icons { display: flex; flex-wrap: wrap; gap: 0.45rem; align-items: center; margin: 0.15rem 0 0.35rem 0; }
  .sf-ic { display: inline-flex; align-items: center; gap: 0.28rem; }
  .sf-ic--warn { color: #fb923c; }
  .sf-ic--doc { color: #7dd3fc; }
  .sf-tag { font-size: 0.68rem; font-weight: 600; padding: 0.1rem 0.32rem; border-radius: 4px; letter-spacing: 0.01em; }
  .sf-tag--warn { background: rgba(251, 146, 60, 0.22); color: #ffedd5; }
  .sf-tag--doc { background: rgba(125, 211, 252, 0.14); color: #e0f2fe; }
  .sf-muted { color: #64748b; font-weight: 500; }
  .sf-basis { margin: 0.1rem 0; color: #cbd5e1; font-size: 0.76rem; line-height: 1.35; }
  .sf-floor { margin: 0.12rem 0 0 0; color: #94a3b8; font-size: 0.76rem; line-height: 1.35; }
  .sf-sup { margin: 0.25rem 0 0 0; color: #64748b; font-size: 0.7rem; line-height: 1.35; }
  .sf-fallback { margin: 0.2rem 0 0 0; color: #94a3b8; font-size: 0.78rem; }
  @media print { body { background: #fff; color: #111; } th { background: #eee; } tr:nth-child(even) td { background: #f8fafc; } a { color: #0369a1; } .reason { color: #7f1d1d; } }
</style>
</head>
<body>
  <h1>ELIZA Discovery — exported lists</h1>
  <p class="note">Exported: ${exportedLabel}. Match threshold: <strong>${thresholdPercent}%</strong>.
  Rows are the same set as currently loaded in the dashboard (tail of each list). Open links in a browser; use Print → Save as PDF for a PDF copy.</p>

  <h2>New matches (${newMatchesTotal.toLocaleString()} total in storage; ${matches.length} in this file)</h2>
  <p class="note">Jobs that passed veto and scored ≥ threshold. Columns: listing title, provider, evaluated at, fit score, constraint veto, summary / salary / link.</p>
  <table>
    <thead><tr>
      <th>Title</th><th>Provider</th><th>Evaluated</th><th>Match %</th><th>Veto</th><th>Details &amp; link</th>
    </tr></thead>
    <tbody>
      ${matchRows || `<tr><td colspan="6">No rows in the loaded window.</td></tr>`}
    </tbody>
  </table>

  <h2>Evaluated, not a match (${nonMatchesTotal.toLocaleString()} total in storage; ${nonMatches.length} in this file)</h2>
  <p class="note">Jobs below threshold and/or vetoed. Includes not-match reason, optional summary, salary snapshot, link.</p>
  <table>
    <thead><tr>
      <th>Title</th><th>Provider</th><th>Evaluated</th><th>Fit %</th><th>Veto</th><th>Reason, details &amp; link</th>
    </tr></thead>
    <tbody>
      ${nonRows || `<tr><td colspan="6">No rows in the loaded window.</td></tr>`}
    </tbody>
  </table>
</body>
</html>`;
}

export function downloadDiscoveryListsHtml(html: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const blob = new Blob(["\uFEFF", html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `eliza-discovery-lists-${stamp}.html`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
