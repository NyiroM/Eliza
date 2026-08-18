// lib/pipeline/semanticVetoConsistency.ts — LLM often writes veto prose while leaving vetoed=false.
const CLAIMS_VETO =
  /(?:the\s+)?(?:application|candidate|profile)\s+is\s+vetoed\b|\bvetoed\s+because\b|^veto(?:ed)?\s*:/im;

const DENIES_VETO = /\b(?:not|never|no)\s+vetoed\b/i;

/** True when review text asserts a hard veto (not "not vetoed"). */
export function textClaimsHardVeto(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (DENIES_VETO.test(t) && !/\bis\s+vetoed\b/i.test(t)) return false;
  return CLAIMS_VETO.test(t);
}

export function reviewFieldsClaimHardVeto(fields: {
  one_sentence_summary?: string | null;
  narrative_summary?: string | null;
  mathematical_breakdown?: string | null;
  veto_reason?: string | null;
}): boolean {
  return (
    textClaimsHardVeto(fields.one_sentence_summary) ||
    textClaimsHardVeto(fields.narrative_summary) ||
    textClaimsHardVeto(fields.mathematical_breakdown) ||
    textClaimsHardVeto(fields.veto_reason)
  );
}
