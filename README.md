# ELIZA

**Local-first job fit analysis** for developers who want **transparent math**, not a mystery percentage. Paste a posting, compare it to your CV through a staged pipeline (extract → prune → score), then optionally draft application assets—all via **[Ollama](https://ollama.com)** on your machine.

---

## Why ELIZA

- **Auditable scores** — the semantic model returns **`score_components`**; the API **reconciles** the headline **`fit_score`** with the structured sum and the **6–7** lines of **`mathematical_breakdown`**.
- **Semantic highlights** — short phrases from the job text, labeled positive or negative, with rationale for the UI highlighter.
- **Constraint-aware** — saved preferences and hard vetoes (for example location conflicts) surface in the dashboard and API.
- **No cloud inference required** — PDF CV parsing and LLM calls stay on your network when Ollama runs locally.

---

## How it works

End-to-end flow from raw inputs to the dashboard:

```mermaid
flowchart LR
  subgraph Inputs
    J[Job posting text]
    C[CV PDF / text]
  end

  subgraph JobExtraction
    EN{English-first\nheuristic}
    LT[LLM language prep\nand translation]
    JE[Structured job\nentity extraction]
    J --> EN
    EN -->|high confidence| JE
    EN -->|ambiguous or\nnon-English| LT
    LT --> JE
  end

  subgraph CvExtraction
    CP[CV parser\nskills + stories]
  end

  subgraph Pruning
    P[Pruned CV context\nskills, seniority,\nexperience snippets]
  end

  subgraph Scoring
    B[Literal baseline\noverlap + rules]
    R["DeepSeek-R1\n(or other JSON model)\nsemantic review"]
  end

  subgraph Output
    U[Pipeline JSON\n→ UI mapping]
  end

  C --> CP
  JE --> P
  CP --> P
  JE --> B
  CP --> B
  P --> R
  B --> R
  R --> U
```

1. **Job / CV** — You provide posting text and a stored CV (uploaded PDF).
2. **Extraction** — **English-first:** a fast token-signal heuristic on job text and CV text decides whether to **skip** the LLM language/translation step. If confidence is low or the sample looks non-English (for example German orthography in the prefix), the pipeline runs **automatic translation prep**, then **structured entity extraction**. The CV path always extracts skills, seniority, and core stories.
3. **Pruning** — A compact CV profile is built for the scorer (token budget, noise-stripped experience lines).
4. **DeepSeek-R1 scoring** — Default stack targets **`deepseek-r1:8b`** (or any Ollama tag you select). A baseline literal score is merged with the LLM semantic review, **`score_components`**, and optional **veto** logic.
5. **UI mapping** — The Next.js dashboard and Chrome extension render fit gauge, breakdown, highlights, badges, and asset hooks.

Shared TypeScript contracts live under **`types/`**; limits and defaults under **`config/constants.ts`**.

---

## Benchmarks

On a typical **16 GB VRAM** workstation with **`deepseek-r1:8b`** pulled in Ollama, a full dashboard analysis (including extraction, pruning, and semantic scoring) commonly finishes in **~15 seconds** wall time. Actual latency varies with GPU class, CPU fallback, context size, and whether the **English-first** heuristic skips the LLM translation prep for both job and CV samples.

---

## Tech stack

| Layer        | Choice                                      |
| ------------ | --------------------------------------------- |
| App          | **Next.js** (App Router), **React**, **TypeScript** |
| Styling      | **Tailwind CSS** v4                          |
| Local AI     | **Ollama** — JSON-capable models (**DeepSeek-R1 8B**, **Llama 3**, similar tags) |
| PDF          | **pdf2json** for CV text extraction          |
| Extension    | **Vite** + **React** (Chrome MV3 side panel) |

---

## Repository layout

| Path | Purpose |
|------|---------|
| `app/` | Routes, dashboard UI, API route handlers |
| `lib/` | Pipeline, parsers, scoring, Ollama client, storage helpers |
| `types/` | Shared API and domain types (`PipelineOutput`, `JobParseResult`, …) |
| `config/constants.ts` | Central limits, timeouts, default model tag |
| `apps/extension/` | Chrome extension (`npm run build` → `dist/`) |

User data (CV, constraints) is written under **`/storage/`** at the project root (gitignored).

---

## Prerequisites

- **Node.js** 20+
- **npm**
- **[Ollama](https://ollama.com)** installed and on your **`PATH`** (so the Next.js server can run `ollama list`)

---

## Installation

### 1. Ollama (local inference)

Start the Ollama daemon, then pull the recommended reasoning model:

```bash
ollama serve
ollama pull deepseek-r1:8b
```

You can also pull a lighter default for smoke tests:

```bash
ollama pull llama3
```

Keep **`ollama serve`** running in a terminal (or as a service) while you use ELIZA.

### 2. Application

```bash
git clone https://github.com/NyiroM/Eliza.git
cd Eliza
npm install
cp .env.example .env.local   # optional; see file for OLLAMA_HOST
npm run dev
```

Open **http://localhost:3000**, upload a **PDF CV**, paste a job description, pick **`deepseek-r1:8b`** (or another installed tag), and run analysis.

### Environment

See **`.env.example`**. Set **`OLLAMA_HOST`** if Ollama is not at `http://localhost:11434`.

### Chrome extension

```bash
cd apps/extension
npm install
npm run build
```

Load **`apps/extension/dist`** as an unpacked extension. Set **`VITE_ELIZA_API_URL`** at build time if the API is not on `http://localhost:3000`.

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Next.js development server |
| `npm run build` | Production build |
| `npm run start` | Production server |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Typecheck (also run in CI on PRs to `main`) |

---

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)**.

---

## License

**MIT** — see **[LICENSE](./LICENSE)**.
