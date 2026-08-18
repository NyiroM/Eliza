// lib/discovery/jobText.ts
import type { DiscoveredJob } from "../../types/discovery";
import { isThinDiscoveryDescription } from "./descriptionQuality";
import { enrichDiscoveredJobDescription } from "./enrichJobDescription";

export type PipelineJobText = {
  text: string;
  stillThin: boolean;
};

function listingLocationLine(description: string): string | null {
  const m = description.match(/^Location:\s*(.+)$/im);
  const loc = m?.[1]?.trim();
  return loc && loc.length >= 2 ? `Location: ${loc}` : null;
}

export async function buildJobTextForPipeline(job: DiscoveredJob): Promise<PipelineJobText> {
  const locLine = listingLocationLine(job.description ?? "");
  const listingHeader = `[Discovery listing]
Provider: ${job.provider}
Title: ${job.title}
URL: ${job.url}
${job.company ? `Company: ${job.company}\n` : ""}${locLine ? `${locLine}\n` : ""}
---

`;
  let body = job.description?.trim() ?? "";
  const enriched = await enrichDiscoveredJobDescription(job);
  if (enriched) {
    const locValue = locLine?.replace(/^Location:\s*/i, "").trim() ?? "";
    body =
      locValue && !enriched.toLowerCase().includes(locValue.toLowerCase())
        ? `${locLine}\n\n${enriched}`
        : enriched;
  }
  if (body.length < 80) {
    body = `${job.title}\n${job.company ? `Company: ${job.company}\n` : ""}${locLine ? `${locLine}\n` : ""}URL: ${job.url}`;
  }
  return {
    text: (listingHeader + body).slice(0, 95_000),
    stillThin: isThinDiscoveryDescription(body, job.provider),
  };
}
