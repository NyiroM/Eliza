import type { NextConfig } from "next";
import fs from "fs";
import path from "path";

/**
 * Prefer `process.cwd()` when it is clearly this app (Next config + package.json there);
 * otherwise use this file's directory so resolution stays correct if the shell cwd is a parent folder.
 */
function resolveProjectRoot(): string {
  const cwd = path.resolve(process.cwd());
  const hasPkg = fs.existsSync(path.join(cwd, "package.json"));
  const hasThisConfig =
    fs.existsSync(path.join(cwd, "next.config.ts")) ||
    fs.existsSync(path.join(cwd, "next.config.mjs")) ||
    fs.existsSync(path.join(cwd, "next.config.js"));
  if (hasPkg && hasThisConfig) return cwd;
  return path.resolve(__dirname);
}

const projectRoot = resolveProjectRoot();

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright", "playwright-core"],
  transpilePackages: ["tailwindcss", "@tailwindcss/postcss"],
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
