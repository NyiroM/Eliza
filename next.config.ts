import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  /** Pin Turbopack root to this app so nested lockfiles in parent folders are not picked up. */
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
