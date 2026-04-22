# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
