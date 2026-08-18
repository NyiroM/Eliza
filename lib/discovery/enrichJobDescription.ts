// lib/discovery/enrichJobDescription.ts — detail-page fetch for all discovery providers.
import type { DiscoveredJob } from "../../types/discovery";
import { jobNeedsDescriptionEnrichment } from "./descriptionQuality";
import { enrichIndeedJobDescription } from "./sources/indeedDetail";
import { enrichLinkedInJobDescription } from "./sources/linkedinGuest";
import { enrichProfessionJobDescription } from "./sources/professionDetail";

export async function enrichDiscoveredJobDescription(
  job: Pick<DiscoveredJob, "provider" | "url" | "description">,
): Promise<string | null> {
  if (!jobNeedsDescriptionEnrichment(job)) return null;

  switch (job.provider) {
    case "linkedin":
      return enrichLinkedInJobDescription(job.url);
    case "indeed":
      return enrichIndeedJobDescription(job.url);
    case "profession":
      return enrichProfessionJobDescription(job.url);
    default:
      return null;
  }
}
