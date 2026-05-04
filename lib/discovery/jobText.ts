// lib/discovery/jobText.ts
import type { DiscoveredJob } from "../../types/discovery";
import { enrichLinkedInJobDescription } from "./sources/linkedinGuest";

export async function buildJobTextForPipeline(job: DiscoveredJob): Promise<string> {
  const listingHeader = `[Discovery listing]
Provider: ${job.provider}
Title: ${job.title}
URL: ${job.url}
${job.company ? `Company: ${job.company}\n` : ""}
---

`;
  let body = job.description?.trim() ?? "";
  if (job.provider === "linkedin" && body.length < 200) {
    const full = await enrichLinkedInJobDescription(job.url);
    if (full) body = full;
  }
  if (body.length < 80) {
    body = `${job.title}\n${job.company ? `Company: ${job.company}\n` : ""}URL: ${job.url}`;
  }
  return (listingHeader + body).slice(0, 95_000);
}
