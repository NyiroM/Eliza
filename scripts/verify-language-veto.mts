// scripts/verify-language-veto.mts
import assert from "node:assert/strict";
import * as langModule from "../lib/pipeline/languageRequirementVeto";

type LangApi = typeof import("../lib/pipeline/languageRequirementVeto");
const lang: LangApi =
  (langModule as unknown as { default?: LangApi }).default ?? (langModule as unknown as LangApi);

const CONSTRAINTS = [
  "I don't speak english, or any other language other than Hungarian. Veto every job where this is mentioned.",
];

const {
  userConstraintsAllowOnlyHungarian,
  detectNonHungarianLanguageRequirement,
  inferLanguageRequirementVeto,
} = lang;

assert.equal(userConstraintsAllowOnlyHungarian(CONSTRAINTS), true);

assert.equal(
  detectNonHungarianLanguageRequirement("Hungarian-speaking Customer, Tech, Sales Experts"),
  null,
);

assert.match(
  detectNonHungarianLanguageRequirement("Very good command of English required.")?.language ?? "",
  /English/,
);

const enrichedSnippet =
  "We are looking for Hungarian-Speaking Professionals. Benefits include English lessons for staff.";
const hit = detectNonHungarianLanguageRequirement(enrichedSnippet);
assert.ok(hit?.language === "English");

const veto = inferLanguageRequirementVeto(CONSTRAINTS, "Fluent in English and Hungarian.");
assert.equal(veto.vetoed, true);

console.log("verify-language-veto: ok");
