<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# ELIZA — agent notes

Human-oriented overview: **[README.md](./README.md)**. Release history: **[CHANGELOG.md](./CHANGELOG.md)**. Contributor workflow: **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

## Stack and layout

- **App:** Next.js App Router (`app/`), React 19, TypeScript, Tailwind CSS v4.
- **Tailwind:** `app/globals.css` may use `@source` so utilities defined under `lib/**/*.ts` are picked up (for example shared class strings in `lib/ui/`).
- **Inference:** Ollama via `lib/llm/ollama.ts`; default host from **`OLLAMA_HOST`** (see `.env.example`).
- **Discovery Hub:** sync and queue under `app/api/discovery/`; logic in `lib/discovery/` (catalog, `sync.ts`, `processEvalQueue.ts`, Playwright fetchers, **`dupeFingerprint.ts` / `dupeIndexStore.ts`**, **`suppressedStore.ts`**).
- **Contracts:** shared types in `types/` (especially `types/discovery.ts` for hub rows and API shapes).
- **Limits / discovery env defaults:** `config/constants.ts` (overrides via env vars listed in `.env.example` and README).

## Commands (sanity before a PR)

- `npm run lint` — ESLint.
- `npx tsc --noEmit` — typecheck.
- `npm run build` — production build (run when changing `app/`, `lib/`, or config).

Optional checks: `npm run test:salary-oracle`, `npx tsx scripts/verify-discovery-dedupe.mts`.

## Local data (never commit)

- **`storage/`** at repo root (gitignored): CV uploads, user JSON, **`storage/discovery/`** (`jobs.jsonl`, `dupe_index.json`, `suppressed_ids.json`, match lists, queue, progress, etc.).
- **`benchmarks/`** — local Ollama tuning output from `npm run benchmark:ollama-tuning`.

## Discovery behavior (high level)

- **Sync** ingests provider listings into the catalog; **cross-provider dedupe** uses a persisted index on disk.
- **`POST /api/discovery/reevaluate`** re-queues evaluation without necessarily re-fetching all listings (see route and `lib/discovery` callers).
- **Suppressed job IDs** are respected across sync, re-evaluate, and queue processing.

When changing discovery semantics, update **README** (Discovery Hub), **CHANGELOG**, and any new **env** knobs in **`.env.example`**.

## Style

- Match patterns in neighboring files; keep diffs focused.
- Do not add markdown files unless the task calls for documentation.
