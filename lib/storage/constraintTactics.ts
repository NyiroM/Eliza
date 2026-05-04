// lib/storage/constraintTactics.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STORAGE_DIR = path.join(process.cwd(), "storage");
const CONSTRAINT_TACTICS_PATH = path.join(STORAGE_DIR, "constraint_tactics.json");

/** Constraint clash families for veto vs soft scoring. */
export type ConstraintTacticDomain = "location" | "remote_zone" | "compensation";

/** default: normal veto rules; never_veto / soft_only: do not hard-veto for that family (use constraint_delta only). */
export type VetoStance = "default" | "never_veto" | "soft_only";

export type StoredConstraintTactics = {
  tactics: Partial<Record<ConstraintTacticDomain, VetoStance>>;
  updated_at: string;
};

const EMPTY: StoredConstraintTactics = {
  tactics: {},
  updated_at: new Date(0).toISOString(),
};

const DOMAINS: ConstraintTacticDomain[] = ["location", "remote_zone", "compensation"];

function normalizeStance(v: unknown): VetoStance {
  if (v === "never_veto" || v === "soft_only" || v === "default") return v;
  return "default";
}

export async function loadConstraintTacticsFromStorage(): Promise<StoredConstraintTactics> {
  try {
    const content = await readFile(CONSTRAINT_TACTICS_PATH, "utf-8");
    const parsed = JSON.parse(content) as Partial<StoredConstraintTactics>;
    const raw = parsed.tactics && typeof parsed.tactics === "object" ? parsed.tactics : {};
    const tactics: Partial<Record<ConstraintTacticDomain, VetoStance>> = {};
    for (const d of DOMAINS) {
      const s = normalizeStance((raw as Record<string, unknown>)[d]);
      if (s !== "default") tactics[d] = s;
    }
    return {
      tactics,
      updated_at:
        typeof parsed.updated_at === "string" ? parsed.updated_at : new Date().toISOString(),
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function saveConstraintTacticsToStorage(data: StoredConstraintTactics): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
  await writeFile(CONSTRAINT_TACTICS_PATH, JSON.stringify(data, null, 2), "utf-8");
}
