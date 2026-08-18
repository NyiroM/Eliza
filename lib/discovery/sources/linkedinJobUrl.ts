// lib/discovery/sources/linkedinJobUrl.ts — numeric job id from guest/search/view URLs.
const LINKEDIN_ID = /\d{8,}/;

export function extractLinkedInJobPostingId(jobUrl: string): string | null {
  const raw = jobUrl.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!u.hostname.toLowerCase().includes("linkedin.com")) return null;
    const fromQuery = u.searchParams.get("currentJobId")?.trim();
    if (fromQuery && LINKEDIN_ID.test(fromQuery)) return fromQuery;
    const path = decodeURIComponent(u.pathname);
    const fromView = path.match(/\/jobs\/view\/(?:.*-)?(\d{8,})\/?$/i);
    if (fromView?.[1]) return fromView[1];
    const fromGuest = path.match(/\/jobPosting\/(\d{8,})\/?$/i);
    if (fromGuest?.[1]) return fromGuest[1];
    return null;
  } catch {
    const fallback = raw.match(/\/jobs\/view\/(?:.*-)?(\d{8,})/i);
    return fallback?.[1] ?? null;
  }
}

export function linkedInGuestJobPostingUrl(jobId: string): string {
  return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${jobId}`;
}

export function linkedInPublicJobViewUrl(jobId: string): string {
  return `https://www.linkedin.com/jobs/view/${jobId}`;
}
