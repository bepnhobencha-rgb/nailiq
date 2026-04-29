import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  turbopack: {
    resolveAlias: {
      // Prefer the package's ESM build. Resolving `"framer-motion"` can pick the
      // CJS `default` entry → `require is not defined` in the browser under Turbopack.
      "framer-motion-esm": "./node_modules/framer-motion/dist/es/index.mjs",
    },
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  silent: !process.env.CI,

  // Optional: uncomment and set `SENTRY_AUTH_TOKEN` in CI for readable stacks.
  // authToken: process.env.SENTRY_AUTH_TOKEN,

  // widenClientFileUpload: true,
});
