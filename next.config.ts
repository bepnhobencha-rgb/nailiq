import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

// `upgrade-insecure-requests` must only be sent over HTTPS. Playwright WebKit
// (unlike Chromium) does not respect the spec exception for localhost and will
// upgrade http://localhost:3000/_next/static/... to https://localhost:3000/...,
// causing all JS bundles to fail to load and React to never hydrate in CI E2E.
// Omit the directive when the site URL is HTTP (local dev / CI test server).
const isHttpsOrigin = (process.env.NEXT_PUBLIC_SITE_URL ?? "").startsWith("https://");

const nextConfig: NextConfig = {
  async headers() {
    const cspDirectives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.vercel-scripts.com https://*.sentry.io https://js.stripe.com",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.sentry.io https://api.stripe.com https://api.openai.com",
      "frame-src https://js.stripe.com https://hooks.stripe.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      ...(isHttpsOrigin ? ["upgrade-insecure-requests"] : []),
    ];
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: cspDirectives.join("; "),
          },
        ],
      },
    ];
  },
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
