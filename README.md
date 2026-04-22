# ELIZA

**ELIZA** is an AI-powered career co-pilot for **high-speed job-fit analysis**: paste a posting, compare it to your CV with transparent scoring math, optional semantic highlights, and generated application assets—all running **locally** via [Ollama](https://ollama.com).

## Vision

Help you decide **fit vs. pass** in seconds, with **auditable breakdowns** (not a black-box percentage), then optionally draft a cover letter and CV tweaks grounded in your real profile.

## Tech stack

| Layer | Choice |
|--------|--------|
| App | **Next.js** (App Router), **React**, **TypeScript** |
| Styling | **Tailwind CSS** v4 |
| Local AI | **Ollama** — tested with **Llama 3**, **DeepSeek-R1** 8B-class models, and similar JSON-capable tags |
| PDF | **pdf2json** for CV text extraction |
| Extension | **Vite** + **React** (Chrome MV3 side panel) |

## Key features

- **Semantic highlighting** — key phrases from the posting, positive vs. negative, with hover rationale (when the scorer returns `semantic_highlights`).
- **Fast analysis** — typical runs on a local GPU are on the order of **~15 seconds** for Turbo-English paths (heuristic English skip for translation where applicable); wall time depends on model size and hardware.
- **Two-column pro dashboard** — input (CV status, target location, job text) beside output (fit gauge, match analysis, corporate vibe, constraints, requirement analysis, application bundle).
- **Score transparency** — the model returns structured **`score_components`**; the API **reconciles** `fit_score` and lines **6–7** of the mathematical breakdown so the **arithmetic sum matches the headline percentage**.

## Repository layout

- `app/` — Next.js routes and dashboard UI  
- `app/api/*` — JSON APIs (`pipeline`, `upload-cv`, `generate-assets`, preferences, constraints, Ollama model list)  
- `lib/` — Pipeline, parsers, scoring, Ollama client, storage  
- `apps/extension/` — Chrome extension source (`npm run build` writes `dist/`)

Local CV and preferences are stored under `storage/` (gitignored).

## Prerequisites

- **Node.js** 20+ recommended  
- **npm**  
- **Ollama** installed and on your `PATH` (for `ollama list` from the Next server process)  
- At least one **pullable model**, e.g.:

```bash
ollama pull llama3
# optional, good for JSON-style scoring:
ollama pull deepseek-r1:8b
```

## Setup

```bash
git clone https://github.com/NyiroM/Eliza.git
cd Eliza
npm install
cp .env.example .env.local   # optional; see comments inside
npm run dev
```

Open **http://localhost:3000**, upload a **PDF CV**, paste a **job description** (minimum length enforced by the API), choose an Ollama model, and run analysis.

### Environment variables

See **`.env.example`**. The main variable is **`OLLAMA_HOST`** (default `http://localhost:11434`) so ELIZA can reach Ollama when it is not on localhost.

### Extension

```bash
cd apps/extension
npm install
npm run build
```

Load `apps/extension/dist` as an unpacked extension in Chrome. Set **`VITE_ELIZA_API_URL`** at build time if the Next app is not on `http://localhost:3000`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Next.js development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint |

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).
