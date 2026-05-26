/**
 * Server (Node.js) SDK — imported from `instrumentation.ts` when `NEXT_RUNTIME === "nodejs"`.
 */
import * as Sentry from "@sentry/nextjs";

const dsn =
  typeof process.env.NEXT_PUBLIC_SENTRY_DSN === "string"
    ? process.env.NEXT_PUBLIC_SENTRY_DSN.trim()
    : "";

Sentry.init({
  dsn: dsn || undefined,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.25,
  // Prevent Sentry from injecting sentry-trace/baggage headers into OpenAI requests.
  // Without this, the extra headers cause beta_api_shape_disabled on /v1/realtime.
  tracePropagationTargets: [/^(?!.*api\.openai\.com).*/],
});
