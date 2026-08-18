// scripts/verify-job-id-canonicalization.mts — assert URL drift collapses to one stableJobId.
import assert from "node:assert/strict";
import * as idModule from "../lib/discovery/id";
import * as professionUrlModule from "../lib/discovery/professionHuUrlValidation";

type IdApi = typeof import("../lib/discovery/id");
const idApi: IdApi =
  (idModule as unknown as { default?: IdApi }).default ?? (idModule as unknown as IdApi);
const { canonicalizeJobUrl, stableJobId } = idApi;

type ProfessionUrlApi = typeof import("../lib/discovery/professionHuUrlValidation");
const professionUrl: ProfessionUrlApi =
  (professionUrlModule as unknown as { default?: ProfessionUrlApi }).default ??
  (professionUrlModule as unknown as ProfessionUrlApi);
const { isProfessionJobListingHref } = professionUrl;

type Equiv = { provider: string; label: string; urls: string[] };

const EQUIVALENTS: Equiv[] = [
  {
    provider: "linkedin",
    label: "LinkedIn jobs/view drift (utm + fragment + trailing slash)",
    urls: [
      "https://www.linkedin.com/jobs/view/3812345678/",
      "https://www.linkedin.com/jobs/view/3812345678",
      "https://www.linkedin.com/jobs/view/3812345678?utm_source=newsletter&utm_medium=email",
      "https://www.linkedin.com/jobs/view/3812345678?refId=abc123&trackingId=xyz#applicants",
      "https://www.linkedin.com/jobs/view/3812345678?pageNum=2",
    ],
  },
  {
    provider: "indeed",
    label: "Indeed viewjob/rc/clk drift",
    urls: [
      "https://hu.indeed.com/viewjob?jk=abcdef1234567890",
      "https://hu.indeed.com/viewjob?jk=abcdef1234567890&from=serp",
      "https://hu.indeed.com/viewjob?jk=abcdef1234567890&tk=1abcd&advn=1234",
      "https://hu.indeed.com/viewjob?jk=abcdef1234567890&utm_campaign=spring",
    ],
  },
  {
    provider: "profession",
    label: "Profession.hu /allas slug drift",
    urls: [
      "https://www.profession.hu/allas/123456-software-engineer",
      "https://www.profession.hu/allas/123456-software-engineer/",
      "https://www.profession.hu/allas/123456-software-engineer?keywordsearch=1",
      "https://www.profession.hu/allas/123456-software-engineer?utm_source=jobboard",
      "https://www.profession.hu/allas/123456",
    ],
  },
];

const NON_EQUIVALENTS: { provider: string; a: string; b: string }[] = [
  {
    provider: "linkedin",
    a: "https://www.linkedin.com/jobs/view/3812345678",
    b: "https://www.linkedin.com/jobs/view/9999999999",
  },
  {
    provider: "indeed",
    a: "https://hu.indeed.com/viewjob?jk=abcdef1234567890",
    b: "https://hu.indeed.com/viewjob?jk=fedcba0987654321",
  },
  {
    provider: "profession",
    a: "https://www.profession.hu/allas/123456-software-engineer",
    b: "https://www.profession.hu/allas/654321-other-role",
  },
];

let passes = 0;
let failures = 0;

function logResult(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`PASS  ${label}`);
    passes += 1;
  } else {
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
}

for (const group of EQUIVALENTS) {
  const ids = group.urls.map((u) => stableJobId(group.provider, u));
  const canon = group.urls.map((u) => canonicalizeJobUrl(group.provider, u));
  const allSame = ids.every((id) => id === ids[0]);
  if (!allSame) {
    logResult(
      group.label,
      false,
      `ids diverged:\n${group.urls
        .map((u, i) => `    ${ids[i]} ← ${u}\n      canon=${canon[i]}`)
        .join("\n")}`,
    );
  } else {
    logResult(`${group.label} (${ids[0]})`, true);
  }
}

for (const pair of NON_EQUIVALENTS) {
  const a = stableJobId(pair.provider, pair.a);
  const b = stableJobId(pair.provider, pair.b);
  if (a === b) {
    logResult(
      `${pair.provider} distinct postings collide`,
      false,
      `both -> ${a} (a=${pair.a}, b=${pair.b})`,
    );
  } else {
    logResult(`${pair.provider} distinct postings stay distinct`, true);
  }
}

assert.equal(canonicalizeJobUrl("indeed", ""), "");
assert.equal(canonicalizeJobUrl("linkedin", "   "), "");
logResult("Empty/whitespace input returns empty string", true);

assert.equal(
  isProfessionJobListingHref("/allas/gyartasindito-mernok-joyson-miskolc-2901499"),
  true,
);
assert.equal(isProfessionJobListingHref("/allas/123456-software-engineer"), true);
assert.equal(isProfessionJobListingHref("/allasok/1?adv_pattern=x"), false);
logResult("Profession listing href vs index URL", true);

console.log(`\nTotal: ${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
