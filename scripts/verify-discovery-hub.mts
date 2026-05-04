// scripts/verify-discovery-hub.mts — HTTP checks for Discovery Hub (run dev server first).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchIndeedRssJobs } from "../lib/discovery/sources/indeedRss";

const BASE = process.env.VERIFY_BASE ?? "http://127.0.0.1:3010";
const VERIFY_MODEL = process.env.VERIFY_MODEL ?? "deepseek-r1:8b";
const JOBS_JSONL = path.join(process.cwd(), "storage", "discovery", "jobs.jsonl");
const USER_CV_JSON = path.join(process.cwd(), "storage", "user_cv.json");

const headers = {
  "Content-Type": "application/json",
  "X-Eliza-Internal": "true",
} as const;

const BANANA_CONSTRAINT = "The job description must contain the word Banana";

type Progress = { phase: string; message?: string };

async function getProgress(): Promise<Progress> {
  const r = await fetch(`${BASE}/api/discovery/progress`, { cache: "no-store" });
  return (await r.json()) as Progress;
}

async function postSync(body: Record<string, unknown>) {
  return fetch(`${BASE}/api/discovery/sync`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function postQueue(body: Record<string, unknown>) {
  return fetch(`${BASE}/api/discovery/process-queue`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function dedupePhases(samples: Progress[]): string[] {
  const out: string[] = [];
  let last = "";
  for (const s of samples) {
    const k = `${s.phase}|${s.message ?? ""}`;
    if (k !== last) {
      out.push(s.phase);
      last = k;
    }
  }
  return out;
}

async function drainAll(log: (s: string) => void): Promise<void> {
  let remaining = 1;
  let rounds = 0;
  while (remaining > 0 && rounds < 40) {
    const pr = await postQueue({ model: VERIFY_MODEL });
    const pd = (await pr.json()) as { queue_remaining?: number; jobs_evaluated?: number; locked?: boolean };
    if (pr.status === 409 || pd.locked) break;
    remaining = Number(pd.queue_remaining ?? 0);
    if ((pd.jobs_evaluated ?? 0) === 0 && remaining > 0) break;
    if ((pd.jobs_evaluated ?? 0) === 0) break;
    rounds += 1;
  }
  log(`cleanup drain: stopped at rounds=${rounds}`);
}

async function main() {
  const out: string[] = [];
  const log = (s: string) => {
    out.push(s);
    console.log(s);
  };

  log(`VERIFY_BASE=${BASE}`);

  if (!existsSync(USER_CV_JSON)) {
    mkdirSync(path.dirname(USER_CV_JSON), { recursive: true });
    writeFileSync(
      USER_CV_JSON,
      JSON.stringify(
        {
          raw_text: "Verify harness stub CV. TypeScript, Node.js, REST APIs.",
          parsed: {
            skills: ["typescript", "node"],
            seniority_level: "mid",
            core_stories: ["Shipping backend services"],
            parser_source: "fallback",
          },
          uploaded_at: new Date().toISOString(),
          source_filename: "verify-stub.pdf",
        },
        null,
        2,
      ),
      "utf-8",
    );
    log("Seeded storage/user_cv.json (minimal stub) so /api/discovery/sync checks pass.");
  }

  log("\n--- Indeed RSS (library fetch, browser-like headers) ---");
  try {
    const jobs = await fetchIndeedRssJobs("developer", 3);
    log(`fetchIndeedRssJobs: ${jobs.length} job(s) (expect >0 if RSS reachable).`);
    if (jobs.length === 0) {
      log("WARN: zero jobs — RSS may still block this network or returned empty feed.");
    }
  } catch (e) {
    log(`fetchIndeedRssJobs ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }

  const pr0 = await getProgress();
  log(`\nInitial progress: phase=${pr0.phase}`);

  log("\n--- Concurrent manual sync (Indeed) ---");
  const [r1, r2] = await Promise.all([
    postSync({ mode: "manual", provider: "indeed", model: VERIFY_MODEL }),
    postSync({ mode: "manual", provider: "indeed", model: VERIFY_MODEL }),
  ]);
  log(`HTTP statuses: ${r1.status}, ${r2.status}`);
  const bodies = await Promise.all([r1.json(), r2.json()]);
  const lockedCount = bodies.filter((b: { locked?: boolean }) => b.locked).length;
  log(`locked=true in bodies: ${lockedCount}`);

  log("\n--- Progress during sequential Indeed sync ---");
  const samples: Progress[] = [];
  const pollMs = 50;
  let syncing = true;
  const pollLoop = (async () => {
    while (syncing) {
      try {
        samples.push(await getProgress());
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    for (let i = 0; i < 8; i += 1) {
      try {
        samples.push(await getProgress());
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  })();

  const rs = await postSync({ mode: "manual", provider: "indeed", model: VERIFY_MODEL });
  syncing = false;
  await pollLoop;
  const syncJson = (await rs.json()) as Record<string, unknown>;
  log(`Indeed sync HTTP ${rs.status} jobs_added=${syncJson.jobs_added} queue=${syncJson.queue_remaining}`);
  if (syncJson.errors && Object.keys(syncJson.errors as object).length) {
    log(`Indeed sync errors: ${JSON.stringify(syncJson.errors)}`);
  }
  log(`Indeed phase trail: ${dedupePhases(samples).join(" → ")}`);

  log("\n--- Progress during LinkedIn-only sync ---");
  const samples2: Progress[] = [];
  syncing = true;
  const poll2 = (async () => {
    while (syncing) {
      try {
        samples2.push(await getProgress());
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    for (let i = 0; i < 8; i += 1) {
      try {
        samples2.push(await getProgress());
      } catch {
        /* ignore */
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  })();
  const rsLi = await postSync({ mode: "manual", provider: "linkedin", model: VERIFY_MODEL });
  syncing = false;
  await poll2;
  const liJson = (await rsLi.json()) as Record<string, unknown>;
  log(`LinkedIn sync HTTP ${rsLi.status} jobs_added=${liJson.jobs_added} evaluated=${liJson.jobs_evaluated} queue=${liJson.queue_remaining}`);
  log(`LinkedIn phase trail: ${dedupePhases(samples2).join(" → ")}`);

  const qRem = Number(liJson.queue_remaining ?? 0);
  if (qRem > 0) {
    log("\n--- Session lock: second sync before drain (expect 409 awaiting_drain) ---");
    const rBlock = await postSync({ mode: "manual", provider: "linkedin", model: VERIFY_MODEL });
    const blockBody = (await rBlock.json()) as { locked?: boolean; awaiting_drain?: boolean; error?: string };
    log(`Second sync HTTP ${rBlock.status} awaiting_drain=${blockBody.awaiting_drain} locked=${blockBody.locked}`);
    if (rBlock.status !== 409 || !blockBody.awaiting_drain) {
      log("WARN: expected 409 with awaiting_drain while queue is draining.");
    }
  } else {
    log("\n--- Session lock: skipped (queue already empty; no drain pending) ---");
  }

  log("\n--- Client-style process-queue drain loop ---");
  let remaining = Number(liJson.queue_remaining ?? 0);
  let rounds = 0;
  let totalEval = Number(liJson.jobs_evaluated ?? 0);
  let totalWins = Number(liJson.new_high_matches ?? 0);
  while (remaining > 0 && rounds < 40) {
    const pr = await postQueue({ model: VERIFY_MODEL });
    const pd = (await pr.json()) as Record<string, unknown>;
    const mid = await getProgress();
    log(
      `  round ${rounds + 1}: HTTP ${pr.status} remaining=${pd.queue_remaining} evaluated=${pd.jobs_evaluated} wins=${pd.new_high_matches} progress_phase=${mid.phase}`,
    );
    if (pr.status === 409 || pd.locked) break;
    if (!pr.ok) break;
    totalWins += Number(pd.new_high_matches ?? 0);
    totalEval += Number(pd.jobs_evaluated ?? 0);
    remaining = Number(pd.queue_remaining ?? 0);
    rounds += 1;
  }
  log(`Drain finished: rounds=${rounds}, totalEvaluated=${totalEval}, totalStrictWins=${totalWins}, remaining=${remaining}`);

  log("\n--- Sync after drain completes ---");
  const rAfter = await postSync({ mode: "manual", provider: "indeed", model: VERIFY_MODEL });
  log(`Follow-up Indeed sync HTTP ${rAfter.status}`);

  log("\n--- jobs.jsonl duplicate IDs ---");
  try {
    const raw = readFileSync(JOBS_JSONL, "utf-8");
    const ids: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line) as { id?: string };
        if (j.id) ids.push(j.id);
      } catch {
        /* skip */
      }
    }
    const counts = new Map<string, number>();
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    const dups = [...counts.entries()].filter(([, n]) => n > 1);
    log(`Total lines: ${ids.length}, unique ids: ${counts.size}, duplicate id keys: ${dups.length}`);
  } catch {
    log("jobs.jsonl missing.");
  }

  log("\n--- Parallel process-queue + sync ---");
  const [pqP, syP] = await Promise.all([
    postQueue({ model: VERIFY_MODEL }),
    postSync({ mode: "manual", provider: "indeed", model: VERIFY_MODEL }),
  ]);
  log(`process-queue ${pqP.status}, concurrent sync ${syP.status}`);

  await drainAll(log);

  log("\n--- Duplicate-rerun: same provider seed twice (expect duplicates_skipped on round 2) ---");
  const dupSeed1 = await postSync({ mode: "manual", provider: "indeed", model: VERIFY_MODEL });
  const dupSeed1Body = (await dupSeed1.json()) as {
    jobs_added?: number;
    duplicates_skipped?: Record<string, number>;
    queue_remaining?: number;
  };
  log(
    `  round 1: HTTP ${dupSeed1.status} jobs_added=${dupSeed1Body.jobs_added} duplicates=${JSON.stringify(
      dupSeed1Body.duplicates_skipped ?? {},
    )}`,
  );
  await drainAll(log);
  const dupSeed2 = await postSync({ mode: "manual", provider: "indeed", model: VERIFY_MODEL });
  const dupSeed2Body = (await dupSeed2.json()) as {
    jobs_added?: number;
    duplicates_skipped?: Record<string, number>;
    queue_remaining?: number;
  };
  log(
    `  round 2: HTTP ${dupSeed2.status} jobs_added=${dupSeed2Body.jobs_added} duplicates=${JSON.stringify(
      dupSeed2Body.duplicates_skipped ?? {},
    )}`,
  );
  const dupRound2 = Number(dupSeed2Body.duplicates_skipped?.indeed ?? 0);
  if (Number(dupSeed2Body.jobs_added ?? 0) === 0 && dupRound2 > 0) {
    log("PASS: re-run added 0 jobs and reported duplicates_skipped > 0 on Indeed.");
  } else if (Number(dupSeed1Body.jobs_added ?? 0) === 0) {
    log("SKIP: round 1 returned no jobs (provider blocked / empty feed); cannot assert dedupe.");
  } else {
    log(
      `WARN: expected jobs_added=0 and duplicates_skipped>0 on round 2, got jobs_added=${dupSeed2Body.jobs_added} duplicates=${dupRound2}.`,
    );
  }
  await drainAll(log);

  if (process.env.SKIP_BANANA === "1") {
    log("\n--- Banana veto test: skipped (SKIP_BANANA=1) ---");
  } else {
    log("\n--- Banana veto test (POST /api/user-constraints + /api/pipeline) ---");
    const add = await fetch(`${BASE}/api/user-constraints`, {
      method: "POST",
      headers,
      body: JSON.stringify({ constraint: BANANA_CONSTRAINT }),
    });
    log(`Add constraint HTTP ${add.status}`);
    const jobText =
      "Senior Software Engineer — TypeScript and Node.js backend. Fully remote EU team. " +
      "No special vocabulary requirements in this description.";
    const pipe = await fetch(`${BASE}/api/pipeline`, {
      method: "POST",
      headers,
      body: JSON.stringify({ job: jobText, model: VERIFY_MODEL }),
    });
    const pj = (await pipe.json()) as {
      constraint_veto?: boolean;
      match_strength?: string;
      error?: string;
    };
    const vetoed = pj.constraint_veto === true || pj.match_strength === "Vetoed";
    log(`Pipeline HTTP ${pipe.status} constraint_veto=${pj.constraint_veto} match_strength=${pj.match_strength}`);
    if (pipe.ok && vetoed) {
      log("PASS: non-matching job treated as vetoed.");
    } else if (!pipe.ok) {
      log(`SKIP/FAIL: pipeline error — ${pj.error ?? "unknown"} (Ollama / CV required).`);
    } else {
      log("WARN: expected veto for job without 'Banana' (LLM may vary).");
    }
    const del = await fetch(`${BASE}/api/user-constraints`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ constraint: BANANA_CONSTRAINT }),
    });
    log(`Remove constraint HTTP ${del.status}`);
  }

  try {
    writeFileSync("verify-discovery-hub.log.txt", out.join("\n"), "utf-8");
  } catch {
    /* optional */
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
