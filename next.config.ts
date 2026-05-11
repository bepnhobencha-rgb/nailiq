import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  silent: !process.env.CI,

  // Optional: uncomment and set `SENTRY_AUTH_TOKEN` in CI for readable stacks.
  // authToken: process.env.SENTRY_AUTH_TOKEN,

  // widenClientFileUpload: true,
});
