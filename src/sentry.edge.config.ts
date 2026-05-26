/**
 * Edge runtime (proxy) — imported from `instrumentation.ts` when `NEXT_RUNTIME === "edge"`.
 */
import * as Sentry from "@sentry/nextjs";

const dsn =
  typeof process.env.NEXT_PUBLIC_SENTRY_DSN === "string"
    ? process.env.NEXT_PUBLIC_SENTRY_DSN.trim()
    : "";

Sentry.init({
  dsn: dsn || undefined,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.2,
  tracePropagationTargets: [/^(?!.*api\.openai\.com).*/],
});
