/**
 * App Router client instrumentation — `Sentry.init` lives in root `sentry.client.config.ts`.
 */
import * as Sentry from "@sentry/nextjs";

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
