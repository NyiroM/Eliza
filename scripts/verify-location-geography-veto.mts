// scripts/verify-location-geography-veto.mts
import assert from "node:assert/strict";
import * as geoModule from "../lib/pipeline/locationGeographyVeto";
import * as huModule from "../lib/pipeline/hungaryGeography";

type GeoApi = typeof import("../lib/pipeline/locationGeographyVeto");
type HuApi = typeof import("../lib/pipeline/hungaryGeography");

const geo: GeoApi =
  (geoModule as unknown as { default?: GeoApi }).default ?? (geoModule as unknown as GeoApi);
const hu: HuApi = (huModule as unknown as { default?: HuApi }).default ?? (huModule as unknown as HuApi);

const {
  assessLocationGeographyConflict,
  inferLocationGeographyVeto,
  formatLocationVetoHeadline,
} = geo;
const { expandPreferredLocationToCitySlugs, primaryCitySlugForJobBoardSearch } = hu;

const defaultTactics = { tactics: {}, updated_at: "" };
const softTactics = { tactics: { location: "strong_preference" as const }, updated_at: "" };

const BAZ_PREF =
  "Miskolc, Sajószentpéter, Kazincbarcika, Borsod-Abaúj-Zemplén";
const joysonUrl =
  "https://www.profession.hu/allas/gyartasindito-mernok-joyson-safety-systems-hungary-kft-miskolc-2901499/pro";

const bazAllowed = expandPreferredLocationToCitySlugs(BAZ_PREF);
assert.ok(bazAllowed.has("miskolc"), "BAZ preference includes Miskolc");
assert.ok(bazAllowed.has("sajoszentpeter"), "BAZ preference includes Sajószentpéter");
assert.ok(bazAllowed.has("kazincbarcika"), "BAZ preference includes Kazincbarcika");
assert.ok(bazAllowed.has("ozd"), "county expands to Ózd");

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: BAZ_PREF,
    jobLocation: "Miskolc",
    jobTextEnglish: "On-site manufacturing engineer.",
    combinedJobText: `URL: ${joysonUrl}`,
    workModel: "on-site",
    tactics: defaultTactics,
  }).vetoed,
  false,
  "Miskolc job should align with BAZ multi-place preference",
);

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: BAZ_PREF,
    jobLocation: "Kazincbarcika",
    jobTextEnglish: "",
    combinedJobText: "",
    tactics: defaultTactics,
  }).vetoed,
  false,
  "Kazincbarcika job should align when city is listed",
);

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: "Borsod-Abaúj-Zemplén megye",
    jobLocation: "Miskolc",
    jobTextEnglish: "",
    combinedJobText: `URL: ${joysonUrl}`,
    tactics: defaultTactics,
  }).vetoed,
  false,
  "county-only preference should include Miskolc",
);

const budapestMiskolc = inferLocationGeographyVeto({
  preferredLocation: "Budapest",
  jobLocation: "Miskolc",
  jobTextEnglish: "On-site.",
  combinedJobText: `URL: ${joysonUrl}`,
  tactics: defaultTactics,
});
assert.equal(budapestMiskolc.vetoed, true, "Budapest vs Miskolc should veto");
assert.match(budapestMiskolc.user_message ?? "", /Rejected:.*Miskolc/i);

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: BAZ_PREF,
    jobLocation: "Debrecen",
    jobTextEnglish: "Debrecen plant.",
    tactics: defaultTactics,
  }).vetoed,
  true,
  "Debrecen should veto against BAZ preference",
);

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: "Budapest, Hungary",
    jobLocation: "Miskolc",
    jobTextEnglish: "",
    combinedJobText: `URL: ${joysonUrl}`,
    tactics: softTactics,
  }).vetoed,
  false,
  "strong_preference skips server hard veto",
);

assert.equal(
  assessLocationGeographyConflict({
    preferredLocation: "Budapest",
    jobLocation: "Szigetszentmiklós, Hungary",
    jobTextEnglish: "",
    tactics: defaultTactics,
  }).material_mismatch,
  false,
  "Budapest metro still aligns",
);

assert.equal(primaryCitySlugForJobBoardSearch(BAZ_PREF), "miskolc");
assert.equal(
  primaryCitySlugForJobBoardSearch("Borsod-Abaúj-Zemplén"),
  "miskolc",
  "county-only search uses county seat",
);

const pestBelt =
  "Budapest, Pest, Güd, Vác, Visegrád, Gödöllő, Biatorbágy";
const pestAllowed = expandPreferredLocationToCitySlugs(pestBelt);
assert.ok(pestAllowed.has("budapest"));
assert.ok(pestAllowed.has("vac"));
assert.ok(pestAllowed.has("godollo"));
assert.ok(pestAllowed.has("god"), "Güd aliases to Göd");
assert.ok(pestAllowed.has("visegrad"));
assert.ok(pestAllowed.has("biatorbagy"));
assert.equal(hu.linkedInLocationFromPreference(pestBelt), "Budapest, Hungary");

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: pestBelt,
    jobLocation: "Vác",
    jobTextEnglish: "Hybrid role based in Vác.",
    tactics: defaultTactics,
  }).vetoed,
  false,
  "Vác aligns with Budapest+Pest list",
);

const lifted = geo.enforceLocationGeographyOnReview(
  {
    vetoed: true,
    veto_reason: 'Veto: job is based in "Vác" not "Budapest".',
    fit_score: 0,
    metadata_fit_badge: "Location Conflict",
    mathematical_breakdown: "VETO: location\nFinal Score: 0%.",
    one_sentence_summary: "Rejected on location.",
    matched_skills: [],
    missing_skills: [],
    seniority_match: true,
    fit_score_reconciled_from_components: false,
  },
  {
    preferredLocation: pestBelt,
    jobLocation: "Vác",
    jobTextEnglish: "Based in Vác.",
    tactics: defaultTactics,
  },
  { fit_score: 72, matched_skills: ["python"], missing_skills: [], seniority_match: true },
);
assert.equal(lifted.vetoed, false, "false Budapest-only location veto is lifted");
assert.equal(lifted.fit_score, 72);

assert.equal(
  formatLocationVetoHeadline("Budapest", ["miskolc"]),
  "Rejected: role is based in Miskolc, but your target location is Budapest.",
);

const pestPref =
  "Budapest, Pest, Göd, Vác, Visegrád, Gödöllő, Biatorbágy, Szentendre";
const noarkBody = `Technical Sales Support Hungary
NOARK Electric. As we continue to expand across Europe, we are looking for a Technical Sales Support to join our growing team in Hungary.
Location
Hungary, with close cooperation with the local Country Manager and headquarters in Prague.
Send us your CV in English.
`;

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: pestPref,
    jobLocation: "Prague",
    jobTextEnglish: noarkBody,
    combinedJobText: noarkBody,
    workModel: "unknown",
    tactics: defaultTactics,
  }).vetoed,
  false,
  "HQ Prague must not veto a Hungary-hired role",
);

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: pestPref,
    jobLocation: "Prague",
    jobTextEnglish: noarkBody,
    combinedJobText: noarkBody,
    workModel: "remote",
    tactics: defaultTactics,
  }).vetoed,
  false,
  "remote Hungary role with HQ abroad is aligned",
);

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: pestPref,
    jobLocation: "Prague",
    jobTextEnglish: "Based in Prague. You will cover the Hungary market from the Prague office.",
    combinedJobText: "Based in Prague.",
    workModel: "on-site",
    tactics: defaultTactics,
  }).vetoed,
  true,
  "explicit Prague duty station still vetoes",
);

const sphBody = `[Discovery listing]
Title: Academic & Research Sales Manager
Location: Budapest, Budapest, Hungary
---
Universities and research agencies purchase our magnetometry systems. Experience in remote sensing is useful.
This role is remote or hybrid (our offices are in Latvia, Serbia, Hungary).
`;

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: pestPref,
    jobLocation: "Latvia, Serbia, Hungary",
    jobTextEnglish: sphBody,
    combinedJobText: sphBody,
    workModel: "hybrid",
    tactics: defaultTactics,
  }).vetoed,
  false,
  "Latvia in an office list must not veto a Budapest/Hungary hybrid role",
);

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: "Budapest",
    jobLocation: "Miskolc",
    jobTextEnglish: "On-site in Miskolc. Experience in remote sensing required.",
    combinedJobText: "On-site in Miskolc. Experience in remote sensing required.",
    workModel: "on-site",
    tactics: defaultTactics,
  }).vetoed,
  true,
  "remote sensing must not be treated as a remote work model",
);

console.log("verify-location-geography-veto: ok");
