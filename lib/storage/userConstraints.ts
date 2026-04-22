import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STORAGE_DIR = path.join(process.cwd(), "storage");
const USER_CONSTRAINTS_PATH = path.join(STORAGE_DIR, "user_constraints.json");

export type StoredUserConstraints = {
  constraints: string[];
  updated_at: string;
};

const EMPTY_CONSTRAINTS: StoredUserConstraints = {
  constraints: [],
  updated_at: new Date(0).toISOString(),
};

export async function loadUserConstraintsFromStorage(): Promise<StoredUserConstraints> {
  try {
    const content = await readFile(USER_CONSTRAINTS_PATH, "utf-8");
    const parsed = JSON.parse(content) as Partial<StoredUserConstraints>;
    return {
      constraints: Array.isArray(parsed.constraints)
        ? parsed.constraints.filter((c): c is string => typeof c === "string")
        : [],
      updated_at:
        typeof parsed.updated_at === "string"
          ? parsed.updated_at
          : new Date().toISOString(),
    };
  } catch {
    return EMPTY_CONSTRAINTS;
  }
}

export async function saveUserConstraintsToStorage(
  data: StoredUserConstraints,
): Promise<void> {
  await mkdir(STORAGE_DIR, { recursive: true });
  await writeFile(USER_CONSTRAINTS_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export async function addUserConstraint(constraint: string): Promise<StoredUserConstraints> {
  const trimmed = constraint.trim();
  if (!trimmed) {
    return loadUserConstraintsFromStorage();
  }

  const existing = await loadUserConstraintsFromStorage();
  const deduped = [trimmed, ...existing.constraints.filter((c) => c !== trimmed)].slice(0, 50);
  const next: StoredUserConstraints = {
    constraints: deduped,
    updated_at: new Date().toISOString(),
  };

  await saveUserConstraintsToStorage(next);
  return next;
}

export async function removeUserConstraint(
  constraint: string,
): Promise<StoredUserConstraints> {
  const trimmed = constraint.trim();
  const existing = await loadUserConstraintsFromStorage();
  if (!trimmed) {
    return existing;
  }

  const next: StoredUserConstraints = {
    constraints: existing.constraints.filter((item) => item !== trimmed),
    updated_at: new Date().toISOString(),
  };
  await saveUserConstraintsToStorage(next);
  return next;
}
