# Contributing to ELIZA

Thank you for your interest in improving ELIZA. This project is a small Next.js application plus an optional browser extension.

## Getting started

1. Fork the repository and clone your fork.
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env.local` if you need non-default Ollama URLs.
4. Run `npm run dev` and ensure [Ollama](https://ollama.com) is available for local LLM calls.

## Pull requests

- Keep changes focused on a single concern (feature, fix, or docs).
- Run `npx tsc --noEmit` before opening a PR.
- Run `npm run lint` when you touch TypeScript or React code.
- Describe **what** changed and **why** in the PR description.

## Documentation maintenance checklist

When your change touches runtime defaults or user-facing behavior, update docs in the same PR:

- **Version bump**: keep `package.json`, `package-lock.json`, and `CHANGELOG.md` aligned.
- **Model/runtime defaults**: if default Ollama model changes, update `README.md` install/run examples.
- **Scripts**: if npm scripts are added/renamed, update the scripts table in `README.md`.
- **Major feature behavior**: document extraction/fallback/safety logic changes (for example Salary Oracle rules) in `README.md` and `CHANGELOG.md`.
- **API response shape**: if `types/` contracts change, ensure dashboard/extension docs and examples still reflect actual fields.

## Extension

The Chrome extension lives under `apps/extension/`. Build it with:

```bash
cd apps/extension && npm install && npm run build
```

Optional: set `VITE_ELIZA_API_URL` in `apps/extension/.env` if the Next API is not on `http://localhost:3000`.

## Code style

- Prefer clear names and small functions over clever one-liners.
- Match existing formatting and patterns in nearby files.
- Do not commit files under the repo-root `storage/` data directory or real `.env` secrets.

## Questions

Open a discussion or issue on [GitHub](https://github.com/NyiroM/Eliza) if you are unsure whether a change fits the project direction.
