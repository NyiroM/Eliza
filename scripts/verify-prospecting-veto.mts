#!/usr/bin/env node
// scripts/verify-prospecting-veto.mts — deterministic detectors for no-hunting constraints vs hunter roles.
import * as prospectingNs from "../lib/pipeline/prospectingVeto";

function unwrapDefault<T extends Record<string, unknown>>(mod: T | { default: T }): T {
  if (mod && typeof mod === "object" && "default" in mod && (mod as { default: T }).default) {
    return (mod as { default: T }).default;
  }
  return mod as T;
}

const {
  buildProspectingHardVetoReason,
  hasNoProspectingConstraint,
  isNewBusinessHuntingRole,
} = unwrapDefault(prospectingNs as never) as typeof import("../lib/pipeline/prospectingVeto");

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const userConstraint = [
  "I do not want to work on hunting / prospecting / finding new customers or new clients. No cold outreach, no new-business hunting, no pipeline prospecting for net-new clients.",
];

assert(hasNoProspectingConstraint(userConstraint), "user constraint should match");
assert(!hasNoProspectingConstraint(["Prefer hybrid work in Budapest"]), "unrelated constraint");

const kardex = `
Title: Solutions Sales Consultant
Company: Kardex
As a member of our growing New Business Sales team, you will combine technical expertise with commercial ownership,
proactively developing new business opportunities, managing your sales pipeline, and delivering innovative solutions.
Success measured by sales targets, pipeline growth, new customer acquisition.
Develop your assigned sales territory and identify new business opportunities through regular prospecting and weekly customer visits.
Manage the complete sales cycle, including prospecting, qualification, consulting, proposal preparation, negotiation.
`;

const stiefel = `
Title: Technical Manager / product support
Providing technical support for hardware and software.
Delivering product demonstrations and user training for existing schools and reseller partners.
Supporting interactive display installations.
`;

const cetin = `
Title: Automation Expert
Building and maintaining automated workflows using RPA platforms.
Integrating automations with systems using APIs.
`;

assert(isNewBusinessHuntingRole(kardex), "Kardex should be hunting role");
assert(!isNewBusinessHuntingRole(stiefel), "Stiefel support role should not be hunting");
assert(!isNewBusinessHuntingRole(cetin), "CETIN automation should not be hunting");

const reason = buildProspectingHardVetoReason();
assert(/prospecting|hunting|new-business/i.test(reason), "veto reason wording");
assert(hasNoProspectingConstraint(userConstraint) && isNewBusinessHuntingRole(kardex), "combo");

console.log("verify-prospecting-veto: ok");
