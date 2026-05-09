/**
 * Shared creative-generation instructions (cover letter, CV rewrite).
 * v0.3: grounds models on real CV/job prose and ignores PDF export noise.
 */
export const CREATIVE_STRUCTURAL_NOISE_INSTRUCTION =
  'CRITICAL: Ignore structural document markers, metadata, or formatting artifacts such as "Page Break", "Page (0)", "Header", or "Footer". Focus exclusively on the professional content and experience.';

/** Cover letters / CV edits for people (not ATS parsers): natural prose, no “AI brochure” cadence. */
export const CREATIVE_EXTERNAL_HUMAN_PROSE_INSTRUCTION =
  "For text the user may send externally (email, PDF, paste): weave any lists into flowing sentences; do not use a bold or titled lead-in line ending with a colon immediately before a bullet block; avoid stock AI openers and repetitive signposting; keep a grounded, conversational professional tone.";
