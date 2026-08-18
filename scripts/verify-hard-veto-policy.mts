// scripts/verify-hard-veto-policy.mts — regression: removed substring universal pre-veto (can't vs CAN).
import assert from "node:assert/strict";

/** Legacy pre-veto (removed from pipeline) — kept only to document the false-positive class. */
function legacyDetectUniversalNegativeConstraintConflict(
  constraints: string[],
  requiredItems: string[],
): string | null {
  const normalize = (value: string) =>
    ` ${value.toLowerCase().replace(/[^a-z0-9+#/.\-\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  const hasNegative = (value: string) =>
    /\b(?:no|cannot|can't|do not|don't|excluding|exclude|avoid|never|will not|not willing|not interested|without(?!\s+exception))\b/i.test(
      value,
    );

  if (!constraints.length || !requiredItems.length) return null;
  const required = [...new Set(requiredItems.map((s) => s.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );

  for (const constraint of constraints) {
    if (!hasNegative(constraint)) continue;
    const normalizedConstraint = normalize(constraint);
    for (const skill of required) {
      const normalizedSkill = normalize(skill).trim();
      if (normalizedSkill.length < 2) continue;
      if (normalizedConstraint.includes(` ${normalizedSkill} `)) return skill;
    }
  }
  return null;
}

const languageConstraint =
  "Veto every job where English is required — I can't speak any language other than Hungarian.";
const chassisRequired = ["CAN", "chassis control", "mid"];

assert.equal(
  legacyDetectUniversalNegativeConstraintConflict([languageConstraint], chassisRequired),
  "CAN",
  "legacy substring veto falsely matched can't → can vs required CAN",
);

console.log("verify-hard-veto-policy: OK (legacy false-positive documented; pipeline uses LLM for this class)");
