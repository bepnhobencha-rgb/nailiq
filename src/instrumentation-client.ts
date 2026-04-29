/**
 * Browser / client-side Sentry bootstrap (App Router — `src/instrumentation-client.ts`).
 *
 * Requires `NEXT_PUBLIC_SENTRY_DSN` in `.env`; if unset the SDK initializes as a no-op.
 */
import * as Sentry from "@sentry/nextjs";

const dsn =
  typeof process.env.NEXT_PUBLIC_SENTRY_DSN === "string"
    ? process.env.NEXT_PUBLIC_SENTRY_DSN.trim()
    : "";

Sentry.init({
  dsn: dsn || undefined,
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.2,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
