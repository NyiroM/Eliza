/**
 * Shared creative-generation instructions (cover letter, CV rewrite).
 * v0.3: grounds models on real CV/job prose and ignores PDF export noise.
 */
export const CREATIVE_STRUCTURAL_NOISE_INSTRUCTION =
  'CRITICAL: Ignore structural document markers, metadata, or formatting artifacts such as "Page Break", "Page (0)", "Header", or "Footer". Focus exclusively on the professional content and experience.';
