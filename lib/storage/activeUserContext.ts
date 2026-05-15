// lib/storage/activeUserContext.ts
/** Per-request active user: isolated storage under storage/users/<id>/. */
import { AsyncLocalStorage } from "node:async_hooks";
import { access, cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { ELIZA_ACTIVE_USER_HEADER } from "../elizaActiveUserHeader";

export { ELIZA_ACTIVE_USER_HEADER };

export type RegistryUser = {
  id: string;
  displayName: string;
  createdAt: string;
};

export type UserRegistry = {
  users: RegistryUser[];
  defaultUserId: string;
};

export type UserContext = {
  userId: string;
  /** Absolute path: .../storage/users/<userId> */
  root: string;
};

const userContextAls = new AsyncLocalStorage<UserContext>();

export function getUserContext(): UserContext | undefined {
  return userContextAls.getStore();
}

export function requireUserContext(): UserContext {
  const c = userContextAls.getStore();
  if (!c) {
    throw new Error("Missing Eliza user storage context.");
  }
  return c;
}

export function requireUserRoot(): string {
  return requireUserContext().root;
}

export async function runWithUserContext<T>(ctx: UserContext, fn: () => Promise<T>): Promise<T> {
  return userContextAls.run(ctx, fn);
}

const USERS_SUBDIR = "users";
const REGISTRY_FILENAME = "registry.json";
const DEFAULT_USER_ID = "default";

export function getUsersBaseDir(): string {
  return path.join(process.cwd(), "storage", USERS_SUBDIR);
}

export function getRegistryPath(): string {
  return path.join(getUsersBaseDir(), REGISTRY_FILENAME);
}

export function getUserDir(userId: string): string {
  return path.join(getUsersBaseDir(), sanitizeUserId(userId));
}

/** Slug: lowercase letters, digits, single hyphens between tokens, max 48 chars. */
export function sanitizeUserId(raw: string): string {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!s || s.length > 48) {
    throw new Error("Invalid user id: use 1–48 chars (a-z, 0-9, hyphen).");
  }
  return s;
}

function slugFromDisplayName(name: string): string {
  try {
    return sanitizeUserId(
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s-]+/g, "")
        .replace(/\s+/g, "-"),
    ).slice(0, 40);
  } catch {
    return "user";
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const LEGACY_FILES = [
  "user_cv.json",
  "user_constraints.json",
  "user_preferences.json",
  "user_corrections.json",
  "skill_synonyms.json",
  "constraint_tactics.json",
] as const;

async function migrateLegacyToDefaultUser(defaultDir: string): Promise<boolean> {
  const storageRoot = path.join(process.cwd(), "storage");
  const legacyDiscovery = path.join(storageRoot, "discovery");
  let moved = false;
  await mkdir(defaultDir, { recursive: true });
  for (const f of LEGACY_FILES) {
    const from = path.join(storageRoot, f);
    const to = path.join(defaultDir, f);
    if (await pathExists(from)) {
      if (!(await pathExists(to))) {
        await rename(from, to);
        moved = true;
      }
    }
  }
  if (await pathExists(legacyDiscovery)) {
    const targetDiscovery = path.join(defaultDir, "discovery");
    if (!(await pathExists(targetDiscovery))) {
      try {
        await rename(legacyDiscovery, targetDiscovery);
      } catch {
        await cp(legacyDiscovery, targetDiscovery, { recursive: true });
      }
      moved = true;
    }
  }
  return moved;
}

async function writeDefaultRegistry(registryPath: string): Promise<UserRegistry> {
  const now = new Date().toISOString();
  const reg: UserRegistry = {
    users: [{ id: DEFAULT_USER_ID, displayName: "Default", createdAt: now }],
    defaultUserId: DEFAULT_USER_ID,
  };
  await mkdir(path.dirname(registryPath), { recursive: true });
  await writeFile(registryPath, JSON.stringify(reg, null, 2), "utf-8");
  return reg;
}

function parseRegistryJson(raw: string): UserRegistry {
  const parsed = JSON.parse(raw) as Partial<UserRegistry>;
  const usersRaw = Array.isArray(parsed.users) ? parsed.users : [];
  const users = usersRaw
    .filter((u): u is RegistryUser => u != null && typeof (u as RegistryUser).id === "string")
    .map((u) => ({
      ...u,
      id: sanitizeUserId((u as RegistryUser).id),
      displayName:
        typeof (u as RegistryUser).displayName === "string" && (u as RegistryUser).displayName.trim()
          ? (u as RegistryUser).displayName.trim()
          : (u as RegistryUser).id,
      createdAt:
        typeof (u as RegistryUser).createdAt === "string"
          ? (u as RegistryUser).createdAt
          : new Date().toISOString(),
    }));
  const defaultUserId =
    typeof parsed.defaultUserId === "string" && parsed.defaultUserId.trim()
      ? sanitizeUserId(parsed.defaultUserId)
      : DEFAULT_USER_ID;
  if (users.length === 0) {
    throw new Error("registry_empty");
  }
  return { users, defaultUserId };
}

async function loadRegistryFromDisk(): Promise<UserRegistry> {
  const raw = await readFile(getRegistryPath(), "utf-8");
  return parseRegistryJson(raw);
}

/** Idempotent: ensures storage/users, registry, and migrates flat storage/ into users/default when needed. */
export async function ensureRegistryInitialized(): Promise<UserRegistry> {
  const usersBase = getUsersBaseDir();
  const registryPath = getRegistryPath();
  await mkdir(usersBase, { recursive: true });

  if (await pathExists(registryPath)) {
    try {
      const reg = await loadRegistryFromDisk();
      return reg;
    } catch {
      const reg = await writeDefaultRegistry(registryPath);
      await ensureUserScaffold(DEFAULT_USER_ID);
      return reg;
    }
  }

  const defaultDir = getUserDir(DEFAULT_USER_ID);
  const hasLegacy =
    (await pathExists(path.join(process.cwd(), "storage", "user_cv.json"))) ||
    (await pathExists(path.join(process.cwd(), "storage", "discovery")));

  if (hasLegacy) {
    await migrateLegacyToDefaultUser(defaultDir);
    const now = new Date().toISOString();
    const reg: UserRegistry = {
      users: [{ id: DEFAULT_USER_ID, displayName: "Default", createdAt: now }],
      defaultUserId: DEFAULT_USER_ID,
    };
    await writeFile(registryPath, JSON.stringify(reg, null, 2), "utf-8");
    await ensureUserScaffold(DEFAULT_USER_ID);
    return reg;
  }

  const reg = await writeDefaultRegistry(registryPath);
  await ensureUserScaffold(DEFAULT_USER_ID);
  return reg;
}

export async function readRegistry(): Promise<UserRegistry> {
  await ensureRegistryInitialized();
  return loadRegistryFromDisk();
}

export async function ensureUserScaffold(userId: string): Promise<void> {
  const id = sanitizeUserId(userId);
  const root = getUserDir(id);
  await mkdir(path.join(root, "discovery"), { recursive: true });
  const emptyConstraints = { constraints: [], updated_at: new Date().toISOString() };
  const emptyPrefs = { preferred_location: null, preferred_currency: null, ollama_model: null };
  const emptyCorrections = { corrections: [], updated_at: new Date(0).toISOString() };
  const emptySynonyms = {
    pairs: [],
    pending_suggestions: [],
    updated_at: new Date(0).toISOString(),
  };
  const emptyTactics = { tactics: {}, updated_at: new Date(0).toISOString() };

  const files: Array<[string, unknown]> = [
    ["user_constraints.json", emptyConstraints],
    ["user_preferences.json", emptyPrefs],
    ["user_corrections.json", emptyCorrections],
    ["skill_synonyms.json", emptySynonyms],
    ["constraint_tactics.json", emptyTactics],
  ];
  for (const [name, payload] of files) {
    const p = path.join(root, name);
    if (!(await pathExists(p))) {
      await writeFile(p, JSON.stringify(payload, null, 2), "utf-8");
    }
  }
}

export async function appendUserToRegistry(
  id: string,
  displayName: string,
): Promise<{ registry: UserRegistry; user: RegistryUser }> {
  const registryPath = getRegistryPath();
  await ensureRegistryInitialized();
  const reg = await loadRegistryFromDisk();
  const safeId = sanitizeUserId(id);
  if (reg.users.some((u) => u.id === safeId)) {
    throw new Error(`User id already exists: ${safeId}`);
  }
  const user: RegistryUser = {
    id: safeId,
    displayName: displayName.trim() || safeId,
    createdAt: new Date().toISOString(),
  };
  const next: UserRegistry = { ...reg, users: [...reg.users, user] };
  await writeFile(registryPath, JSON.stringify(next, null, 2), "utf-8");
  await ensureUserScaffold(safeId);
  return { registry: next, user };
}

export async function createUserFromDisplayName(displayName: string): Promise<{ id: string; user: RegistryUser }> {
  await ensureRegistryInitialized();
  const reg = await loadRegistryFromDisk();
  const base = slugFromDisplayName(displayName);
  let id = base;
  let n = 2;
  while (reg.users.some((u) => u.id === id)) {
    id = sanitizeUserId(`${base}-${n}`);
    n += 1;
    if (n > 999) throw new Error("Could not allocate unique user id.");
  }
  const { user } = await appendUserToRegistry(id, displayName.trim() || id);
  return { id: user.id, user };
}
