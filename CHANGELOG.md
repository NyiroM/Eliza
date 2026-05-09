# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.29] — 2026-05-09

### Fixed

- **Sync backlog scope** — After a fetch, the evaluation queue merge now includes **all** pending jobs in the catalog tail window, not only rows from the provider(s) synced in that request. Single-provider syncs no longer strand unevaluated listings from other sources until you run those providers again.
- **Eval failure store hygiene** — After each batch, failure rows are pruned for job ids that were marked evaluated (success or permanent failure), so `eval_failures.json` does not retain stale entries indefinitely.

## [0.4.28] — 2026-05-09

### Fixed

- **Catalog reset** — `reset-catalog` now clears **`dupe_index.json`** as well. Previously, fingerprints for deleted catalog rows could still mark genuinely new listings as cross-provider duplicates, so they were skipped on sync.
- **Sync backlog window** — Sync queue merge now scans the same trailing catalog size as reevaluate (**`DISCOVERY_SYNC_BACKLOG_MAX_JOBS`**, default 5000) instead of only 600 lines, so older unevaluated rows in a large `jobs.jsonl` are no longer invisible to sync-only queueing.
- **Retry queue** — `returnToEvalQueue` no longer re-inserts user-suppressed listings after a pipeline failure.

### Changed

- **`loadDiscoveredJobsAll`** default line cap follows **`DISCOVERY_SYNC_BACKLOG_MAX_JOBS`** (single source of truth).
- **Dupe-index warm** on empty index now loads the same trailing window as the sync backlog (not 1400 lines).

## [0.4.27] — 2026-05-09

### Fixed

- **Discovery suppress (kuka)** — Dismissed matches now persist both **job id** and **canonical listing URL** in `suppressed_ids.json`. Re-evaluate, sync queue merge, and queue drain skip the listing even if the catalog row gets a different id (duplicate JSONL lines or URL normalization drift), so suppressed rows no longer reappear in **New matches** after **AI reevaluate**.

## [0.4.26] — 2026-05-09

### Added

- **Discovery re-evaluate** — `POST /api/discovery/reevaluate` re-queues catalog jobs, clears evaluated IDs and match lists as configured, and merges the evaluation queue for a full pass without re-fetching listings.
- **Cross-provider deduplication** — fingerprinting (`lib/discovery/dupeFingerprint.ts`) and persisted index (`lib/discovery/dupeIndexStore.ts`, `storage/discovery/dupe_index.json`) so the same role across providers keeps one catalog row; optional verification script `scripts/verify-discovery-dedupe.mts`.
- **Suppressed listings** — trash / hide persists IDs (`lib/discovery/suppressedStore.ts`); sync, re-evaluate, and queue respect suppressed jobs.
- **Discovery UI** — shared button tokens (`lib/ui/dashboardButtons.ts`); match/non-match rows show **company and title**; dashboard copy trimmed; Tailwind `@source` for `lib/**/*.ts` utilities in `app/globals.css`.
- **Constraint tactics** — storage and pipeline alignment for merged `strong_preference` semantics (replaces redundant veto flags in UI and API).

### Changed

- **Salary Oracle** — improved constraint floor parsing, annual posted salary to monthly handling, and Hays benchmark currency handling (`lib/salary-oracle.ts`).
- **Lint / hygiene** — removed unused symbols across `ollama`, pipeline imports, scripts, and scoring helpers; `next-env.d.ts` routes types path aligned with Next 16.

### Fixed

- Discovery progress and matches APIs stay consistent with queue stats and auto-refresh behavior in the hub panel.

## [0.4.25] — 2026-05-04

### Added

- **Discovery Hub** — dashboard panel and **`app/api/discovery/`** routes for Indeed, LinkedIn, and Profession.hu catalog sync, keyword suggestions, evaluation queue, and **New matches** / non-match rows (`types/discovery.ts`).
- **Domain APIs** — **`app/api/domain/skill-synonyms`** and **`app/api/domain/constraint-tactics`** backed by storage helpers for parser- and UI-visible tactics.
- **Pipeline modularization** — staged logic under **`lib/pipeline/`** with a thin **`lib/pipeline.ts`** entry.
- **CV evidence pass** and related parser/storage updates for more traceable skill confirmation (`debug.cv_evidence_pass` on responses when enabled).
- **Developer scripts** — Profession.hu microsteps, integration search, Indeed URL verifier, job-id canonicalization, and **`benchmark:ollama-tuning`** (writes local artifacts under **`benchmarks/`**, gitignored).

### Changed

- **Next.js 16** / **React 19** stack alignment; **`next.config.ts`** marks Playwright packages as server externals where needed.
- README repository layout, prerequisites, scripts table, and Discovery Hub usage (including **`npx playwright install chromium`**).

## [0.4.24] — 2026-04-23

### Added

- Salary Oracle extraction hardening with **semantic proximity checks** (salary amounts must be near salary terms) and explicit **non-salary exclusion contexts** (employee count, country count, years, area-like units).
- Compensation-aware salary response shape with source/currency metadata and structured base/bonus/benefits fields.
- Additional guardrails in semantic scoring hints to avoid treating city names as social-isolation signals.

### Changed

- Salary extraction now enforces stricter monthly sanity checks for high-nominal currencies and applies day-rate normalization only when explicit day-rate markers exist.
- Unlikely posted salaries now automatically **fallback to market benchmark (Hays/RAG)** instead of surfacing noisy values.
- Documentation refreshed for v0.4.x defaults (`deepseek-r1:8b`, salary oracle scripts/behavior).

### Fixed

- Prevented hallucinated numeric entities (for example company employee counts) from being interpreted as monthly salary.

## [0.2.0] — 2026-04-22

### Added

- Structured **`score_components`** from the semantic scorer with server-side reconciliation so **`fit_score`** matches the sum of components and lines 6–7 of **`mathematical_breakdown`**.
- **`OLLAMA_HOST`** support for pointing the Ollama client at a non-default host.
- Stricter API validation for job text, CV uploads, model tags, and optional **`preferred_location`** (see `lib/validation.ts` and `lib/validation` consumers).
- **`debug.fit_score_reconciled_from_components`** on pipeline responses when arithmetic alignment runs.
- Production-oriented docs: **`.env.example`**, **CONTRIBUTING**, and an explicit **MIT** **LICENSE**.

### Changed

- Dashboard and extension copy emphasize transparent scoring and constraint vetoes.
- Root **`.gitignore`** scopes `/storage/` to the project root so library paths named `storage` are not ignored by mistake.
- **English-first language gate:** job and CV samples use a weighted English function-word and job-vocabulary heuristic (`isLikelyEnglishText`). High confidence skips the translation LLM; ambiguous or non-English samples (including a German-script prefix probe) go through automatic translation prep before entity extraction.

### Fixed

- Removed a dead example block from CV parsing utilities.

## [0.1.0] — 2026-04-01

### Added

- Initial public release: Next.js dashboard, local **Ollama**-backed job/CV parsing, literal + semantic fit scoring, semantic highlights, user constraints and preferences, CV PDF upload, Chrome side-panel extension, and application-asset generation APIs.

[0.2.0]: https://github.com/NyiroM/Eliza/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/NyiroM/Eliza/releases/tag/v0.1.0
[0.4.29]: https://github.com/NyiroM/Eliza/compare/v0.4.28...v0.4.29
[0.4.28]: https://github.com/NyiroM/Eliza/compare/v0.4.27...v0.4.28
[0.4.27]: https://github.com/NyiroM/Eliza/compare/v0.4.26...v0.4.27
[0.4.26]: https://github.com/NyiroM/Eliza/compare/v0.4.25...v0.4.26
[0.4.25]: https://github.com/NyiroM/Eliza/compare/v0.4.24...v0.4.25
[0.4.24]: https://github.com/NyiroM/Eliza/compare/v0.2.0...v0.4.24
