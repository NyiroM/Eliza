import type { SemanticHighlight } from "@/types/pipeline";

export type SemanticHighlightMatch = {
  id: string;
  start: number;
  end: number;
  sentiment: "positive" | "negative";
  reason: string;
};

export type SemanticHighlightPart = {
  id: string;
  text: string;
  match: SemanticHighlightMatch | null;
};

export function buildSemanticHighlightMatches(
  text: string,
  highlights: SemanticHighlight[],
): SemanticHighlightMatch[] {
  if (!text || highlights.length === 0) {
    return [];
  }

  const matches: Omit<SemanticHighlightMatch, "id">[] = [];
  const lowerText = text.toLowerCase();
  const used = new Array(text.length).fill(false);
  const sortedHighlights = [...highlights]
    .filter((highlight) => highlight.phrase?.trim())
    .sort((a, b) => b.phrase.trim().length - a.phrase.trim().length);

  for (const highlight of sortedHighlights) {
    const phrase = highlight.phrase.trim();
    const normalizedPhrase = phrase.toLowerCase();
    let from = 0;

    while (true) {
      const index = lowerText.indexOf(normalizedPhrase, from);
      if (index === -1) {
        break;
      }

      let overlaps = false;
      for (let cursor = index; cursor < index + phrase.length; cursor += 1) {
        if (used[cursor]) {
          overlaps = true;
          break;
        }
      }

      if (!overlaps) {
        for (let cursor = index; cursor < index + phrase.length; cursor += 1) {
          used[cursor] = true;
        }
        matches.push({
          start: index,
          end: index + phrase.length,
          sentiment: highlight.sentiment,
          reason: highlight.reason,
        });
      }

      from = index + 1;
    }
  }

  matches.sort((a, b) => a.start - b.start);
  return matches.map((match, index) => ({ ...match, id: `semantic-match-${index}-${match.start}` }));
}

export function buildSemanticHighlightParts(
  text: string,
  matches: SemanticHighlightMatch[],
): SemanticHighlightPart[] {
  if (!text) {
    return [];
  }

  const parts: SemanticHighlightPart[] = [];
  let cursor = 0;
  let plainIndex = 0;

  for (const match of matches) {
    if (match.start < cursor) {
      continue;
    }

    if (match.start > cursor) {
      parts.push({
        id: `plain-${plainIndex}`,
        text: text.slice(cursor, match.start),
        match: null,
      });
      plainIndex += 1;
    }

    parts.push({
      id: match.id,
      text: text.slice(match.start, match.end),
      match,
    });
    cursor = match.end;
  }

  if (cursor < text.length) {
    parts.push({
      id: `plain-${plainIndex}`,
      text: text.slice(cursor),
      match: null,
    });
  }

  return parts;
}
