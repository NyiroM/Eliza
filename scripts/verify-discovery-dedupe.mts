// scripts/verify-discovery-dedupe.mts
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

async function main() {
  const storage = path.join(process.cwd(), "storage", "debug");
  await mkdir(storage, { recursive: true });
  const tmp = path.join(storage, "dupe_index_test.json");
  await rm(tmp, { force: true });

  // Seed with a canonical job.
  const modUnknown: unknown = await import(
    new URL("../lib/discovery/dupeIndexStore.ts", import.meta.url).toString()
  );
  const mod = modUnknown as {
    loadDupeIndex: (
      filePath?: string,
    ) => Promise<{
      recordJob: (j: unknown) => void;
      findDuplicate: (j: unknown) => unknown;
      save: () => Promise<void>;
    }>;
  };
  const idx = await mod.loadDupeIndex(tmp);
  const canonical = {
    id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    provider: "linkedin",
    title: "Technical Product Manager",
    company: "Sparkrock Finance",
    url: "https://example.com/a",
    description:
      "Own the product roadmap, work with engineering, stakeholders, pricing, and customer discovery. Product strategy and delivery.",
    discovered_at: new Date().toISOString(),
  } as const;
  idx.recordJob(canonical as unknown);

  const sameOtherProvider = {
    ...canonical,
    id: "bbbbbbbbbbbbbbbbbbbbbbbb",
    provider: "profession",
    url: "https://example.com/b",
  } as const;
  const dupe1 = idx.findDuplicate(sameOtherProvider as unknown);
  if (!dupe1) throw new Error("Expected cross-provider duplicate (company+title).");

  const sameTitleDifferentCompany = {
    ...canonical,
    id: "cccccccccccccccccccccccc",
    provider: "indeed",
    company: "Totally Different Ltd",
    url: "https://example.com/c",
    description:
      "This is a different posting with the same title but different scope. Contracting role for an unrelated domain.",
  } as const;
  const dupe2 = idx.findDuplicate(sameTitleDifferentCompany as unknown);
  if (dupe2) throw new Error("Did not expect duplicate for same title but different company (precision-first).");

  const noCompanyCanonical = {
    ...canonical,
    id: "dddddddddddddddddddddddd",
    provider: "linkedin",
    company: null,
  } as const;
  idx.recordJob(noCompanyCanonical as unknown);

  const noCompanyNearIdentical = {
    ...noCompanyCanonical,
    id: "eeeeeeeeeeeeeeeeeeeeeeee",
    provider: "profession",
    url: "https://example.com/e",
    description:
      "Own the product roadmap, work with engineering, stakeholders, pricing, and customer discovery. Product strategy and delivery.",
  } as const;
  const dupe3 = idx.findDuplicate(noCompanyNearIdentical as unknown);
  if (!dupe3) throw new Error("Expected duplicate when company is missing but description+title are near-identical.");

  await idx.save();
  await writeFile(path.join(storage, "dupe_index_test_result.json"), JSON.stringify({ ok: true, dupe1, dupe3 }, null, 2), "utf-8");
  console.log("✅ verify-discovery-dedupe: PASS");
}

main().catch((e) => {
  console.error("❌ verify-discovery-dedupe: FAIL");
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});

