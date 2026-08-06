// lib/pipeline/prospectingVeto.ts — hard/soft veto when user bans new-client hunting vs hunter/new-business roles.

/**
 * True when saved constraints say the user does not want prospecting / hunting / net-new clients.
 */
export function hasNoProspectingConstraint(constraints: string[]): boolean {
  return constraints.some((raw) => {
    const t = raw.toLowerCase();
    if (!/\b(no|not|don't|do not|never|avoid|excluding|exclude|won't|will not|refuse)\b/i.test(t)) {
      // Also accept positive phrasing like "I do not want … hunting"
      if (!/\b(do not want|don't want|not interested|no interest)\b/i.test(t)) return false;
    }
    return (
      /\b(prospect(ing|s)?|cold[- ]?(outreach|call|calling)|hunter|hunting)\b/i.test(t) ||
      /\b(new[- ]?(business|clients?|customers?)|net[- ]?new)\b/i.test(t) ||
      /\b(find(ing)?|search(ing)?|acquisit(ion|e))\s+(new\s+)?(clients?|customers?)\b/i.test(t) ||
      /\bpipeline\s+prospect/i.test(t) ||
      /\b(lead\s+gen(eration)?|bdr|sdr)\b/i.test(t)
    );
  });
}

/**
 * True when the posting is clearly a new-business / hunter / prospecting-heavy sales role
 * (not mere account management or technical support of existing customers).
 */
export function isNewBusinessHuntingRole(jobText: string): boolean {
  const t = jobText.toLowerCase();

  const titleish = t.slice(0, 900);
  const hunterTitle =
    /\b(new business|business development|bdr|sdr|hunter|account executive|solutions?\s+sales|sales\s+consultant|outside\s+sales)\b/i.test(
      titleish,
    );

  const dutyHits = [
    /\bprospect(ing|s)?\b/i,
    /\bcold[- ]?(outreach|call|calling)\b/i,
    /\bnew\s+customer\s+acquisition\b/i,
    /\bnew\s+business\s+(sales|opportunit|team|pipeline)\b/i,
    /\b(identify|develop(ing)?)\s+new\s+business\b/i,
    /\bweekly\s+customer\s+visits\b/i,
    /\bregular\s+prospecting\b/i,
    /\bsales\s+pipeline\b/i,
    /\bpipeline\s+growth\b/i,
    /\bnet[- ]?new\b/i,
    /\bhunter\b/i,
    /\blead\s+generation\b/i,
  ].filter((re) => re.test(t)).length;

  // Need either a hunter-shaped title plus at least one duty signal, or strong duty density.
  if (hunterTitle && dutyHits >= 1) return true;
  if (dutyHits >= 3) return true;
  return false;
}

export function buildProspectingHardVetoReason(): string {
  return (
    "Vetoed: This role centers on new-business hunting / prospecting / acquiring new clients, " +
    "which you explicitly excluded in your constraints."
  );
}
