// lib/llm/extractCompleteJSON.ts
// Extract the first syntactically balanced {...} slice from text, tracking JSON string literals and backslash escapes.

/**
 * Returns the substring from the first `{` through the matching closing `}`,
 * respecting double-quoted strings and `\\` escapes (JSON-style).
 * Single quotes do not start strings (avoids apostrophe false positives in English prose).
 */
export function extractCompleteJSON(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        continue;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }

    if (c === "{") {
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
      continue;
    }
  }

  return null;
}
