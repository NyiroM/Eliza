import type { NextConfig } from "next";
import fs from "fs";
import path from "path";

function isAppRoot(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "package.json")) &&
    (fs.existsSync(path.join(dir, "next.config.ts")) ||
      fs.existsSync(path.join(dir, "next.config.mjs")) ||
      fs.existsSync(path.join(dir, "next.config.js")))
  );
}

/** Walk up from `start` until this app's next.config + package.json. */
function walkToAppRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (isAppRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Root of this copy of the app — from this config file, not cwd.
 * Cwd-first pinning kept writing `.next` to an old drive after the project was moved.
 */
function resolveProjectRoot(): string {
  const fromConfig = walkToAppRoot(__dirname);
  if (fromConfig) return fromConfig;
  const fromCwd = walkToAppRoot(process.cwd());
  if (fromCwd) return fromCwd;
  return path.resolve(process.cwd());
}

const projectRoot = resolveProjectRoot();

const nextConfig: NextConfig = {
  // Allow LAN IP access to Next.js HMR /dev resources (phone, other PC on same network)
  allowedDevOrigins: ["192.168.50.166"],
  serverExternalPackages: ["playwright", "playwright-core"],
  transpilePackages: ["tailwindcss", "@tailwindcss/postcss"],
  outputFileTracingRoot: projectRoot,
  /**
   * Dev only: suppress high-frequency / low-signal request lines (RSC root, domain JSON,
   * discovery lists, pipeline POST timing) so errors and intentional `[discovery]` logs stand out.
   */
  logging: {
    incomingRequests: {
      ignore: [
        /^\/$/,
        /^\/api\/discovery\/progress$/,
        /^\/api\/discovery\/settings$/,
        /^\/api\/discovery\/matches$/,
        /^\/api\/discovery\/reset-catalog$/,
        /^\/api\/discovery\/reset-match-lists$/,
        /^\/api\/domain\/skill-synonyms/,
        /^\/api\/domain\/constraint-tactics/,
        /^\/api\/user-constraints$/,
        /^\/api\/ollama-models$/,
        /^\/api\/pipeline/,
      ],
    },
  },
  turbopack: {
    root: projectRoot,
    resolveAlias: {
      tailwindcss: path.join(projectRoot, "node_modules", "tailwindcss"),
      "@tailwindcss/postcss": path.join(projectRoot, "node_modules", "@tailwindcss", "postcss"),
    },
  },
};

export default nextConfig;
