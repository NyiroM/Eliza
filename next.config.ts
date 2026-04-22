import type { NextConfig } from "next";
import path from "path";

/** Absolute app root (directory that contains this config and `package.json`). */
const projectRoot = path.resolve(__dirname);

const nextConfig: NextConfig = {
  turbopack: {
    /** Keep resolution anchored to this package; avoids hoisting confusion when a parent folder also has lockfiles. */
    root: projectRoot,
    resolveAlias: {
      tailwindcss: path.join(projectRoot, "node_modules", "tailwindcss"),
      "@tailwindcss/postcss": path.join(projectRoot, "node_modules", "@tailwindcss", "postcss"),
    },
  },
};

export default nextConfig;
