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
  transpilePackages: ["tailwindcss", "@tailwindcss/postcss"],
  turbopack: {
    root: projectRoot,
    resolveAlias: {
      tailwindcss: path.join(projectRoot, "node_modules", "tailwindcss"),
      "@tailwindcss/postcss": path.join(projectRoot, "node_modules", "@tailwindcss", "postcss"),
    },
  },
};

export default nextConfig;
