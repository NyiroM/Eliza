# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **LAN UI access (step 1)** — `npm run dev` / `npm start` bind to **`0.0.0.0`** so other devices on the same Wi‑Fi can open the dashboard. Optional **`ELIZA_GATE_PASSWORD`** enables a browser login gate (`/login`, httpOnly cookie). Dashboard **Network access** panel lists LAN URLs (`GET /api/server-info`). Auth helpers under **`lib/auth/`**; **`proxy.ts`** allows same-origin LAN Origins and enforces the gate. Worldwide / WAN access deferred to step 2.
- Scripts **`dev:localhost`** / **`start:localhost`** for loopback-only binds.
- **Ollama runtime tuning env knobs** (`lib/llm/ollama.ts`) — **`OLLAMA_TIMEOUT_MS`**, **`OLLAMA_NUM_PREDICT`** (num_predict ceiling), and **`OLLAMA_NUM_CTX`** now override the previously hardcoded defaults (all clamped to safe ranges). Documented in **`.env.example`**. Helps run the pipeline on weak / CPU-only hardware.
- **`ELIZA_OLLAMA_FORCE_SCHEMA`** — when truthy, JSON-Schema-constrained output is applied to the relevance and semantic-fit calls on **every** model, not just the schema-tuned `gemma` / `qwen2.5` / `llama3.1:8b` families. Prevents unconstrained small models (e.g. `llama3.2`) from generating until the timeout.

### Changed

- **Discovery seed phrases** — each sync fetches the first **10** comma-separated search phrases per provider (was 5). Still clamped 1–10 via **`ELIZA_DISCOVERY_MAX_SEED_PHRASES`**.
- **Discovery fetch speed** — Indeed and Profession.hu reuse one Playwright browser across seed phrases. Profession listing-time detail visits default to **0**; Indeed hydrates up to **4** SERP split-pane JDs (`ELIZA_INDEED_DETAIL_VISITS`). Empty Indeed seeds fail fast (~6–10s card wait, no widening ladder). Profession tries two listing URLs then HTTP fallback (slug `/allas/…-id` links). Profession overall timeout default is **90s**. Live progress **Est. remaining** uses these paces.

### Fixed

- **HQ vs hiring country** — geography veto ignores company headquarters mentions (e.g. Prague HQ) when the role is hired into Hungary; a Hungary-wide/remote listing aligns with Budapest/Pest target lists. Country names in office lists (Latvia, Serbia, Hungary) are not treated as the duty city; LinkedIn card **Location:** is kept after detail enrich. Verifier: **`npm run test:location-geography-veto`**.
- **LinkedIn slug detail enrich** — guest/view URLs like `…/jobs/view/ai-research-engineer-aidrive-at-aimotive-4406398076` now yield the numeric posting id; HTTP guest fetch plus Playwright fallback. Title-only listings after enrich are **non-matches**, not inflated fit scores. Verifier: **`npm run test:job-description-enrich`**.
- **Indeed title-only eval** — isolated `/viewjob` Playwright hits Indeed **Security Check**, so listings stayed title-only and were dumped as non-matches. Sync now clicks SERP cards in the same search session; **existing** thin Indeed catalog rows are re-fetched via `jobs?vjk=` (one browser), written back to `jobs.jsonl`, unmarked as evaluated, and re-queued. AI reevaluate does the same hydrate before scoring. Cap: `ELIZA_INDEED_CATALOG_HYDRATE_MAX` (default 100).
- **Indeed detail `page.evaluate`** — Playwright string scripts are not function bodies; `return` threw `SyntaxError: Illegal return statement`. Eval enrich now uses a function callback.
- **Profession.hu HTTP listing parse** — slug URLs like `/allas/title-city-1234567` were dropped (`/allas/\d+` only), so the Playwright-timeout HTTP fallback returned 0 jobs.
- **No-code / production-code hard veto** — offline veto when constraints exclude writing/reading code: coding-core titles, or duties that are writing/reading/debugging/shipping software (any language, firmware, PRs). Explicit “no coding required” skips duty matches. Non-coding Engineer/Sales/Application titles stay unvetoed. Verifier: **`npm run test:no-code-veto`**.
- **Default Ollama model** — `DEFAULT_OLLAMA_MODEL` changed from the invalid tag `gemma4:e4b` to the real, lightweight, schema-tuned **`gemma3n:e4b`** so the fallback model passes the install check instead of always erroring.
- **Discovery silent eval drops** — after max pipeline retries a job is written to **`non_matches.jsonl`** with the last error (still marked evaluated so it does not loop). Overnight / closed-tab drains resume in-process after failure cooldown (`lib/discovery/scheduleEvalQueueResume.ts`; disable with **`ELIZA_DISCOVERY_SERVER_DRAIN=0`**). A provider fetch that returns **0 listings with no HTTP error** now sets **`last_error`** so empty scrape/block is visible on the hub.
- **Multi-city target location** — LinkedIn guest search uses the primary city (`Budapest, Hungary`), not the full comma list. Geography scoring/veto treats any listed city/county (plus Pest-belt towns such as Göd / Visegrád / Biatorbágy) as aligned; a model location-only veto is lifted when the server set matches. Verifier: **`npm run test:location-geography-veto`**.
- **Discovery live progress** — the hub shows **Fetch** and **Ollama** as two lanes (sources/seeds vs jobs scored), with remaining work and a finish-time estimate. Fetch snapshots stay visible while eval runs.

## [0.5.0] — 2026-05-15

### Added

- **Multiple local profiles** — `storage/users/registry.json` and per-profile trees under `storage/users/<id>/` (CV, preferences, constraints, discovery catalog, domain JSON). Legacy flat `storage/` migrates once into **`default`**. Dashboard **Active profile** / **New profile**; browser **`elizaFetch`** sends **`X-Eliza-Active-User`**; routes use **`withActiveUser`** (`lib/api/withActiveUser.ts`). **`GET` / `POST /api/users`** lists or creates profiles (no active-user header).
- **CV skill curation** — after PDF upload, **`POST /api/upload-cv/suggest-skills`** (Ollama) proposes extra skills; **`GET/POST /api/upload-cv/skill-suggestions`** and **`/api/upload-cv/skills`** / **`/api/upload-cv/skill`** manage pending and confirmed skill lists on the stored CV.
- **Location geography veto** — deterministic check in **`lib/pipeline/locationGeographyVeto.ts`** when dashboard **Target location** (constraint tactic `location: strong_preference`) conflicts with the job’s stated location; complements LLM veto. Verifier: **`npm run test:location-geography-veto`**.
- **Salary Oracle v4 benchmark** — committed dataset **`data/salary/hays-hu-2026-enriched-v4.json`** (aliases, `search_vector`, `inferred_skill_tags`, `skill_premium_multiplier`, `market_heat`, weighted title matching). Build helper: **`scripts/build_hays_salary_json.py`**.
- **Discovery salary snapshots** — match / non-match rows and HTML export can carry a compact **`salary_forecast`** snapshot; hub and dashboard use shared render helpers (`SalaryForecastCard`, `lib/salaryForecastDisplay.ts`).
- **Scripts** — `test:salary-titles`, `test:salary-bench-titles`, `test:salary-bench-titles-hu`, `test:location-geography-veto`.

### Changed

- **Per-profile storage** — discovery paths, CV parse cache (`.cache/cv_parses/<id>/`), and all user JSON I/O resolve through the active user context instead of a single global `storage/` tree.
- **Target location on sync** — **Profession.hu**, **Indeed** (`l=`), and **LinkedIn** guest search share **`lib/discovery/locationPreferenceShared.ts`** rules (city slug vs national **Hungary**).
- **Salary Oracle** — enrichment-aware benchmark scoring, skill premium / market heat, day-rate vs monthly guards, and expanded regression tests.

### Fixed

- **Universal substring constraint pre-veto** — removed deterministic `can't` / `exclude` token matching against required skills (false veto when user wrote "can't" but job required **CAN** bus). General exclusion clashes use the semantic scorer (`NEGATION_SOFT_CHECK`); offline hard veto remains for language, no-code, and geography. Verifier: **`npm run test:hard-veto-policy`**.
- **Discovery “stuck” on one job** — eval-queue processing bumps **`updatedAt` every 45s** during `runPipelineDetailed`; hub copy explains multi-step Ollama work per row.
- **LinkedIn / HTTP discovery hangs** — guest LinkedIn, **Indeed RSS**, and **Profession.hu** list fetches use **`timedDiscoveryFetch`** with **`DISCOVERY_HTTP_FETCH_TIMEOUT_MS`** (default **45s**). Drain TTL extended while **`process-queue`** still has work.
- **Reevaluate vs fresh constraints** — `runPipelineDetailed` reloads **`user_constraints.json`** twice so edits during long LLM steps apply before veto and salary.
- **Salary Oracle HUF 45k false benchmark** — daily-rate Hays **IT Contracting** rows excluded for non-contract jobs; developer↔engineer overlap in **scoreMatch**; conservative tie-break on modus.
- **Profession.hu / Indeed vs target location** — sync respects dashboard **Target location** (see Changed).

## [0.4.30] — 2026-05-09

### Fixed

- **Eval queue length vs failure cooldown** — `getEvalQueueLength` now counts rows still on disk that are not evaluated/suppressed, **including** jobs waiting out `eval_failures` cooldown. Previously the count could drop to 0 while cooldown rows remained, so drain could stop early, `/api/discovery/progress` could clear “awaiting drain”, and `markDiscoveryAwaitingDrain(false)` could run too soon.
- **Drain stall false positives** — `POST /api/discovery/process-queue` returns **`actionable_remaining`** (items not in failure cooldown). The hub drain loop only treats “stuck” when `actionable_remaining > 0`, so cooldown-only waits no longer trip the Ollama stall error after three no-op rounds.
- **Drain loop** — When everything left is cooldown-blocked, the hub stops after one round (with a clear message) instead of burning the max round budget on no-op `process-queue` calls.

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
[0.4.30]: https://github.com/NyiroM/Eliza/compare/v0.4.29...v0.4.30
[0.4.29]: https://github.com/NyiroM/Eliza/compare/v0.4.28...v0.4.29
[0.4.28]: https://github.com/NyiroM/Eliza/compare/v0.4.27...v0.4.28
[0.4.27]: https://github.com/NyiroM/Eliza/compare/v0.4.26...v0.4.27
[0.4.26]: https://github.com/NyiroM/Eliza/compare/v0.4.25...v0.4.26
[0.4.25]: https://github.com/NyiroM/Eliza/compare/v0.4.24...v0.4.25
[0.4.24]: https://github.com/NyiroM/Eliza/compare/v0.2.0...v0.4.24
