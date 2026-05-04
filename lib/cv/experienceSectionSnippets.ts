// lib/cv/experienceSectionSnippets.ts
/** Section headers that typically end the work-experience block. */
const EXPERIENCE_END_HEADERS =
  /^(education|academic|qualifications|skills|technical skills|projects|certifications|certificates|languages|publications|references|interests|volunteer)\b/i;

/** Lines that start a work-history region (English + common HU variants). */
const EXPERIENCE_START =
  /^(work experience|employment history|professional experience|career history|relevant experience|experience|employment|berufserfahrung|szakmai tapasztalat|munkatapasztalat)\s*:?\s*$/i;

/**
 * Extract a contiguous block after an experience header for semantic scoring
 * (recent roles, employer lines). Stops at next major section or char cap.
 */
export function extractRecentExperienceSection(rawCv: string, maxChars: number): string {
  const lines = rawCv.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (EXPERIENCE_START.test(t)) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";

  const buf: string[] = [];
  let len = 0;
  for (let i = start; i < lines.length && len < maxChars; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length > 0 && EXPERIENCE_END_HEADERS.test(trimmed)) break;
    const piece = line.length > 400 ? `${line.slice(0, 400)}…` : line;
    if (buf.length > 0 && trimmed.length === 0 && buf[buf.length - 1].trim() === "") continue;
    if (len + piece.length + 1 > maxChars) {
      buf.push(piece.slice(0, Math.max(0, maxChars - len - 1)));
      break;
    }
    buf.push(piece);
    len += piece.length + 1;
  }
  return buf.join("\n").trim().slice(0, maxChars);
}
