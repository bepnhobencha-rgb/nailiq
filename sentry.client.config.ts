/**
 * Browser SDK — injected into the Next.js client bundle by `@sentry/nextjs`.
 * Must live at the project root (not under `src/`) so the webpack plugin picks it up.
 *
 * Do not call `Sentry.init()` again in `src/instrumentation-client.ts` — only export
 * `onRouterTransitionStart` there.
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
