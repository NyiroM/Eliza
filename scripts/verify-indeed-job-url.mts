// scripts/verify-indeed-job-url.mts — self-test for Indeed HU job URL resolution (run: npm run test:indeed-job-url).
import * as cheerio from "cheerio";
import assert from "node:assert/strict";
import * as indeedJobUrlModule from "../lib/discovery/sources/indeedJobUrl";

type IndeedJobUrlApi = typeof import("../lib/discovery/sources/indeedJobUrl");

const indeedJobUrl: IndeedJobUrlApi =
  (indeedJobUrlModule as unknown as { default?: IndeedJobUrlApi }).default ?? (indeedJobUrlModule as unknown as IndeedJobUrlApi);

const { canonicalIndeedViewJobUrl, resolveIndeedJobUrl } = indeedJobUrl;

const INDEED_HU_ORIGIN = "https://hu.indeed.com";
// Pick a jk that does NOT contain every hex digit exactly once (otherwise the
// "rotation-of-0123456789abcdef" sentinel guard would reject it). Real Indeed
// jks have repeated digits (e.g. observed "852d19abda8aadcb", "065da41c4f01aba6").
const REAL_JK = "852d19abda8aadcb";

function run(): void {
  {
    const $ = cheerio.load(
      `<a data-jk="${REAL_JK}" href="/viewjob?jk=${REAL_JK}&from=serp">Title</a>`,
      null,
      false,
    );
    const a = $("a").get(0)!;
    assert.equal(
      resolveIndeedJobUrl($, a),
      `${INDEED_HU_ORIGIN}/viewjob?jk=${encodeURIComponent(REAL_JK)}`,
    );
  }
  {
    const href = `https://hu.indeed.com/rc/clk?jk=${REAL_JK}&from=vj&tk=1`;
    const $ = cheerio.load(`<a href="${href}">Job</a>`, null, false);
    const a = $("a").get(0)!;
    assert.equal(resolveIndeedJobUrl($, a), canonicalIndeedViewJobUrl(REAL_JK));
  }
  {
    const good = "065da41c4f01aba6";
    const $ = cheerio.load(
      `<a data-jk="123456789abcdef0" href="/rc/clk?jk=${good}&from=vj">Job</a>`,
      null,
      false,
    );
    const a = $("a").get(0)!;
    assert.equal(resolveIndeedJobUrl($, a), canonicalIndeedViewJobUrl(good));
  }
  {
    const $ = cheerio.load(`<a data-jk="123456789abcdef0" href="/jobs?q=dev">Nav</a>`, null, false);
    const a = $("a").get(0)!;
    assert.equal(resolveIndeedJobUrl($, a), null);
  }
  // Reject other rotations of "0123456789abcdef" (real-world skeleton card seen in jobs.jsonl).
  {
    const $ = cheerio.load(
      `<a data-jk="789abcdef0123456" href="/viewjob?jk=789abcdef0123456">Skeleton</a>`,
      null,
      false,
    );
    const a = $("a").get(0)!;
    assert.equal(resolveIndeedJobUrl($, a), null);
  }
  // Generic permutation guard: any 16-char hex jk that contains every hex digit exactly once.
  {
    const $ = cheerio.load(
      `<a data-jk="fedcba9876543210" href="/viewjob?jk=fedcba9876543210">Skeleton</a>`,
      null,
      false,
    );
    const a = $("a").get(0)!;
    assert.equal(resolveIndeedJobUrl($, a), null);
  }
  {
    const $ = cheerio.load(`<a href="/viewjob?jk=${REAL_JK}">Only href</a>`, null, false);
    const a = $("a").get(0)!;
    assert.equal(resolveIndeedJobUrl($, a), canonicalIndeedViewJobUrl(REAL_JK));
  }
}

run();
console.log("verify-indeed-job-url: ok");
