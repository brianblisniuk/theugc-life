import type { NextConfig } from "next";

/**
 * Next.js configuration.
 *
 * `reactStrictMode` surfaces unsafe lifecycles early. We intentionally keep this
 * minimal for Sprint 0 — no experimental flags, no custom webpack, no image
 * remote patterns until a feature requires them.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: {
    // Lint is run explicitly via `npm run lint` / CI; do not silently ignore.
    ignoreDuringBuilds: false,
  },
  typescript: {
    // Type errors must fail the build.
    ignoreBuildErrors: false,
  },
};

export default nextConfig;
