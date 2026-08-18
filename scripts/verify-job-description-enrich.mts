// scripts/verify-job-description-enrich.mts
import assert from "node:assert/strict";
import * as qualityModule from "../lib/discovery/descriptionQuality";
import * as indeedParseModule from "../lib/discovery/sources/indeedDetailParse";
import * as professionParseModule from "../lib/discovery/sources/professionDetailParse";
import * as htmlExtractModule from "../lib/discovery/sources/htmlTextExtract";
import * as linkedinParseModule from "../lib/discovery/sources/linkedinDetailParse";
import * as linkedinUrlModule from "../lib/discovery/sources/linkedinJobUrl";

type QualityApi = typeof import("../lib/discovery/descriptionQuality");
type IndeedParseApi = typeof import("../lib/discovery/sources/indeedDetailParse");
type ProfessionParseApi = typeof import("../lib/discovery/sources/professionDetailParse");
type HtmlExtractApi = typeof import("../lib/discovery/sources/htmlTextExtract");
type LinkedinParseApi = typeof import("../lib/discovery/sources/linkedinDetailParse");
type LinkedinUrlApi = typeof import("../lib/discovery/sources/linkedinJobUrl");

const quality: QualityApi =
  (qualityModule as unknown as { default?: QualityApi }).default ?? (qualityModule as unknown as QualityApi);
const indeedParse: IndeedParseApi =
  (indeedParseModule as unknown as { default?: IndeedParseApi }).default ??
  (indeedParseModule as unknown as IndeedParseApi);
const professionParse: ProfessionParseApi =
  (professionParseModule as unknown as { default?: ProfessionParseApi }).default ??
  (professionParseModule as unknown as ProfessionParseApi);
const htmlExtract: HtmlExtractApi =
  (htmlExtractModule as unknown as { default?: HtmlExtractApi }).default ??
  (htmlExtractModule as unknown as HtmlExtractApi);
const linkedinParse: LinkedinParseApi =
  (linkedinParseModule as unknown as { default?: LinkedinParseApi }).default ??
  (linkedinParseModule as unknown as LinkedinParseApi);
const linkedinUrl: LinkedinUrlApi =
  (linkedinUrlModule as unknown as { default?: LinkedinUrlApi }).default ??
  (linkedinUrlModule as unknown as LinkedinUrlApi);

const {
  isListingOnlyDiscoveryBlurb,
  isThinDiscoveryDescription,
  jobNeedsDescriptionEnrichment,
} = quality;
const { extractIndeedDescriptionFromHtml, isIndeedChallengeHtml } = indeedParse;
const { extractProfessionDescriptionFromHtml } = professionParse;
const { jobPostingDescriptionFromJsonLd } = htmlExtract;
const { extractLinkedInDescriptionFromHtml, isLikelyLinkedInAuthWall } = linkedinParse;
const { extractLinkedInJobPostingId } = linkedinUrl;

assert.equal(
  isThinDiscoveryDescription(
    "Költöztetési csomag\nIndeed: https://hu.indeed.com/jobs?q=test&l=Miskolc",
    "indeed",
  ),
  true,
);

assert.equal(
  jobNeedsDescriptionEnrichment({
    provider: "indeed",
    description: "Sales role\nIndeed: https://hu.indeed.com/jobs?q=x",
  }),
  true,
);

assert.equal(isListingOnlyDiscoveryBlurb("Title only\nIndeed: https://hu.indeed.com/jobs?q=a"), true);

const longBody = `${"Requirement line. ".repeat(40)}Very good command of English.`;
assert.equal(isThinDiscoveryDescription(longBody, "indeed"), false);

const ldJson = `<html><script type="application/ld+json">${JSON.stringify({
  "@type": "JobPosting",
  description: "<p>Fluent English required for client calls.</p>",
})}</script></html>`;
assert.match(jobPostingDescriptionFromJsonLd(ldJson) ?? "", /Fluent English required/);

const indeedHtml = `<h1>Job</h1><div id="jobDescriptionText"><p>Very good command of English</p></div>`;
assert.match(extractIndeedDescriptionFromHtml(indeedHtml) ?? "", /Very good command of English/);

assert.equal(
  extractIndeedDescriptionFromHtml("<html><head><title>Security Check - Indeed.com</title></head><body>Verify</body></html>"),
  null,
);
assert.equal(isIndeedChallengeHtml("<title>Security Check - Indeed.com</title>"), true);

const mosaicHtml = `<script>window.mosaic={}; var x={"jobDescription":"<p>Maintain production Python services and CI pipelines.</p>"};</script>`;
assert.match(extractIndeedDescriptionFromHtml(mosaicHtml) ?? "", /production Python services/);

const mosaicTextKey = `<script>var x={"jobDescriptionText":"<p>Own the Kubernetes platform, CI pipelines, and production services.</p>"};</script>`;
assert.match(extractIndeedDescriptionFromHtml(mosaicTextKey) ?? "", /Kubernetes platform/);

const professionHtml = `<article><p>Magyar és angol nyelvtudás elvárás.</p></article>`;
assert.match(extractProfessionDescriptionFromHtml(professionHtml) ?? "", /angol nyelvtudás/);

assert.equal(
  extractLinkedInJobPostingId(
    "https://hu.linkedin.com/jobs/view/ai-research-engineer-aidrive-at-aimotive-4406398076",
  ),
  "4406398076",
);
assert.equal(
  extractLinkedInJobPostingId("https://www.linkedin.com/jobs/view/3812345678"),
  "3812345678",
);
assert.equal(
  extractLinkedInJobPostingId("https://example.com/jobs/view/not-linkedin-12345678"),
  null,
);

const linkedinHtml = `<div class="show-more-less-html__markup"><p>Strong Python programming and software design skills</p></div>`;
assert.match(extractLinkedInDescriptionFromHtml(linkedinHtml) ?? "", /Python programming/);
assert.equal(isLikelyLinkedInAuthWall("Sign in Join now to see more jobs"), true);
assert.equal(isLikelyLinkedInAuthWall("Key requirements: Strong Python programming"), false);

console.log("verify-job-description-enrich: ok");
