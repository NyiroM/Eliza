// lib/pipeline/constraintVetoTactics.ts
import type { ConstraintTacticDomain, StoredConstraintTactics, VetoStance } from "../storage/constraintTactics";

function stanceFor(tactics: StoredConstraintTactics, domain: ConstraintTacticDomain): VetoStance {
  return tactics.tactics[domain] ?? "default";
}

/** Heuristic: map veto reason text to a tactic domain, if any. */
export function classifyVetoReasonTactic(vetoReason: string | null): ConstraintTacticDomain | null {
  if (!vetoReason) return null;
  const s = vetoReason.toLowerCase();
  if (
    /\b(salary|compensation|pay|wage|€|\$|£|huf|gross|net|below your|above your|package|bonus)\b/.test(
      s,
    )
  ) {
    return "compensation";
  }
  if (
    /\b(us\s+only|u\.s\.|europe\s+only|eu\s+only|uk\s+only|timezone|time\s*zone|within\s+\d+\s*h|remote\s*-\s*|hybrid\s+in)\b/.test(
      s,
    ) ||
    /\b(remote|hybrid|on-?site|office|wfh)\b/.test(s)
  ) {
    if (/\b(us only|eu only|timezone|remote —|remote -)\b/i.test(vetoReason)) return "remote_zone";
  }
  if (
    /\b(location|located|region|country|city|based in|office in|hungary|budapest|relocation|geo)\b/.test(
      s,
    )
  ) {
    return "location";
  }
  if (/\b(remote|hybrid|on-?site)\b/.test(s)) return "remote_zone";
  return null;
}

export function shouldSuppressHardVetoForTactics(
  vetoReason: string | null,
  tactics: StoredConstraintTactics,
): boolean {
  const domain = classifyVetoReasonTactic(vetoReason);
  if (!domain) return false;
  const st = stanceFor(tactics, domain);
  return st === "strong_preference";
}

export function buildConstraintTacticHints(tactics: StoredConstraintTactics): string[] {
  const out: string[] = [];
  const domains: ConstraintTacticDomain[] = ["location", "remote_zone", "compensation"];
  for (const d of domains) {
    const st = stanceFor(tactics, d);
    if (st === "strong_preference") {
      out.push(
        `User policy: ${d.replaceAll("_", " ")} is a strong preference — never set vetoed=true for clashes that are only about this domain; apply a large negative constraint_delta instead.`,
      );
    }
  }
  return out;
}

export function inferFallbackConstraintVetoWithTactics(
  constraints: string[],
  jobLocation: string | null,
  jobTextEnglish: string,
  tactics: StoredConstraintTactics,
): { vetoed: boolean; veto_reason: string | null } {
  if (stanceFor(tactics, "location") === "strong_preference") {
    return { vetoed: false, veto_reason: null };
  }
  const joined = constraints.join(" ").toLowerCase();
  if (!joined.trim()) return { vetoed: false, veto_reason: null };
  const loc = (jobLocation ?? "").toLowerCase();
  const job = jobTextEnglish.toLowerCase();
  const blob = `${loc} ${job}`;
  const constraintsExcludeThisRegion =
    /(?:don'?t|do not|hate|never|avoid|not)\s+(?:like\s+)?(?:working|work|to\s+work).{0,50}hungary|hate.{0,30}hungary|no\s+hungary/i.test(
      joined,
    );
  if (
    constraintsExcludeThisRegion &&
    /\bhungary\b|budapest|debrecen|szeged|miskolc\b/i.test(blob)
  ) {
    return {
      vetoed: true,
      veto_reason:
        "Veto: saved constraints rule out this region, but the role is located there (offline check while semantic scoring is unavailable).",
    };
  }
  return { vetoed: false, veto_reason: null };
}
