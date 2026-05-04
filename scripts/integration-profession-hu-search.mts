#!/usr/bin/env node
// scripts/integration-profession-hu-search.mts — verifies Profession.hu Playwright search returns relevant IT titles for "Software Engineer".

import type { DiscoveredJob } from "../types/discovery";

const BANNED = /\b(Cukrász|Pék|Eladó)\b/i;
const TECH = /\b(software|engineer|developer|fejleszt|programoz|mérn|it\b|frontend|backend|full[\s-]?stack|devops|cloud|java|python|react|node|typescript|kubernetes|architect|qa|tester|agile|scrum|data\s+engineer|system\s+admin|rendsz|applikáció|szoftver)\b/i;

async function main(): Promise<void> {
  const keyword = "Software Engineer";
  const { fetchProfessionHuJobsPlaywright } = await import(
    new URL("../lib/discovery/sources/professionHuPlaywright", import.meta.url).href,
  );
  const jobs = (await fetchProfessionHuJobsPlaywright(keyword, 22, 0)) as DiscoveredJob[];
  const titles = jobs.map((j: DiscoveredJob) => j.title).filter(Boolean);

  if (titles.length < 6) {
    console.error(`FAIL: expected at least 6 listing titles, got ${titles.length}`);
    process.exit(1);
  }

  const bannedHits = titles.filter((t) => BANNED.test(t));
  if (bannedHits.length > 0) {
    console.error("FAIL: generic retail titles still present:", bannedHits.slice(0, 8));
    process.exit(1);
  }

  const techHits = titles.filter((t) => TECH.test(t)).length;
  const ratio = techHits / titles.length;
  if (ratio < 0.5) {
    console.error(`FAIL: tech keyword ratio ${(ratio * 100).toFixed(0)}% < 50%`, { titles: titles.slice(0, 14) });
    process.exit(1);
  }

  console.log(`OK: ${titles.length} titles, ${techHits} tech matches (${(ratio * 100).toFixed(0)}%), no banned retail strings.`);
  console.log(titles.slice(0, 8).join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
