// scripts/verify-location-geography-veto.mts
import assert from "node:assert/strict";
import * as geoModule from "../lib/pipeline/locationGeographyVeto";

type GeoApi = typeof import("../lib/pipeline/locationGeographyVeto");

const geo: GeoApi =
  (geoModule as unknown as { default?: GeoApi }).default ?? (geoModule as unknown as GeoApi);

const { assessLocationGeographyConflict, inferLocationGeographyVeto, formatLocationVetoHeadline } =
  geo;

const defaultTactics = { tactics: {}, updated_at: "" };
const softTactics = { tactics: { location: "strong_preference" as const }, updated_at: "" };

const joysonUrl =
  "https://www.profession.hu/allas/gyartasindito-mernok-joyson-safety-systems-hungary-kft-miskolc-2901499/pro";

const budapestMiskolc = inferLocationGeographyVeto({
  preferredLocation: "Budapest",
  jobLocation: "Miskolc",
  jobTextEnglish: "Manufacturing start-up engineer. On-site at plant.",
  combinedJobText: `URL: ${joysonUrl}`,
  workModel: "on-site",
  tactics: defaultTactics,
});
assert.equal(budapestMiskolc.vetoed, true, "Budapest vs Miskolc should hard-veto with default location tactic");
assert.match(
  budapestMiskolc.user_message ?? "",
  /Rejected:.*Miskolc.*Budapest/i,
  "user_message should name both cities",
);
assert.equal(
  formatLocationVetoHeadline("Budapest", ["miskolc"]),
  "Rejected: role is based in Miskolc, but your target location is Budapest.",
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
  "strong_preference should not hard-veto geography alone",
);

assert.equal(
  assessLocationGeographyConflict({
    preferredLocation: "Budapest",
    jobLocation: "Szigetszentmiklós, Hungary",
    jobTextEnglish: "Hybrid role with Budapest-area travel.",
    tactics: defaultTactics,
  }).material_mismatch,
  false,
  "Budapest metro commuter city should align",
);

assert.equal(
  assessLocationGeographyConflict({
    preferredLocation: "Hungary",
    jobLocation: "Miskolc",
    jobTextEnglish: "",
    tactics: defaultTactics,
  }).material_mismatch,
  false,
  "country-only preference should not trigger city mismatch",
);

assert.equal(
  inferLocationGeographyVeto({
    preferredLocation: "Budapest",
    jobLocation: null,
    jobTextEnglish: "Engineer role",
    combinedJobText: `URL: ${joysonUrl}`,
    tactics: defaultTactics,
  }).vetoed,
  true,
  "miskolc in Profession URL should veto even when job_location is null",
);

console.log("verify-location-geography-veto: ok");
