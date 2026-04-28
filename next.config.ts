import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      // Prefer the package's ESM build. Resolving `"framer-motion"` can pick the
      // CJS `default` entry → `require is not defined` in the browser under Turbopack.
      "framer-motion-esm": "./node_modules/framer-motion/dist/es/index.mjs",
    },
  },
};

export default nextConfig;
