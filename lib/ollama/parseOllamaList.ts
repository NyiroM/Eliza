/**
 * Parse stdout from `ollama list` into model names (e.g. "llama3:latest").
 * Handles a header row and variable column spacing.
 */
export function parseOllamaListStdout(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const names: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^NAME\b/i.test(trimmed) && /\bID\b/i.test(trimmed)) {
      continue;
    }
    if (/^-+$/.test(trimmed)) {
      continue;
    }

    const columns = trimmed.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    let first = columns[0] ?? "";

    if (!first) {
      continue;
    }

    if (/^NAME$/i.test(first)) {
      continue;
    }

    if (!/^[\w.+\/@:-]+$/.test(first)) {
      const token = trimmed.match(/^([\w.+\/@:-]+)/);
      first = token?.[1] ?? "";
    }

    if (first && !/^NAME$/i.test(first)) {
      names.push(first);
    }
  }

  return [...new Set(names)];
}
