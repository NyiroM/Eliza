// scripts/verify-indeed-job-url.mts — self-test for Indeed HU job URL resolution (run: npm run test:indeed-job-url).
import * as cheerio from "cheerio";
import assert from "node:assert/strict";
import * as indeedJobUrlModule from "../lib/discovery/sources/indeedJobUrl";

type IndeedJobUrlApi = typeof import("../lib/discovery/sources/indeedJobUrl");

const indeedJobUrl: IndeedJobUrlApi =
  (indeedJobUrlModule as unknown as { default?: IndeedJobUrlApi }).default ?? (indeedJobUrlModule as unknown as IndeedJobUrlApi);

const { canonicalIndeedViewJobUrl, resolveIndeedJobUrl } = indeedJobUrl;

const INDEED_HU_ORIGIN = "https://hu.indeed.com";
const REAL_JK = "f3a1b2c4d5e67890";

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
    const good = "a1b2c3d4e5f67890";
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
  {
    const $ = cheerio.load(`<a href="/viewjob?jk=${REAL_JK}">Only href</a>`, null, false);
    const a = $("a").get(0)!;
    assert.equal(resolveIndeedJobUrl($, a), canonicalIndeedViewJobUrl(REAL_JK));
  }
}

run();
console.log("verify-indeed-job-url: ok");
