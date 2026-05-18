import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // Pricing lives on the home page for now
      { source: "/pricing", destination: "/#pricing", permanent: false },
      // Placeholder pages redirect to contact until real pages exist
      { source: "/help", destination: "/contact", permanent: false },
      { source: "/docs", destination: "/contact", permanent: false },
      { source: "/blog", destination: "/", permanent: false },
      { source: "/changelog", destination: "/", permanent: false },
      { source: "/careers", destination: "/contact", permanent: false },
      { source: "/press", destination: "/contact", permanent: false },
      // External status page
      { source: "/status", destination: "https://www.vercel-status.com", permanent: false },
    ];
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
