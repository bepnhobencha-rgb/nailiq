import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Capture server request errors to BOTH Sentry and our self-hosted error_logs.
export const onRequestError: typeof Sentry.captureRequestError = (err, request, context) => {
  // Self-hosted (Node runtime only — the service-role client isn't edge-safe).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    void import("./shared/observability/errorLog")
      .then(({ logError }) => {
        const e = err as { message?: string; stack?: string } | null;
        return logError({
          message: e?.message ? String(e.message) : String(err),
          stack: e?.stack ?? null,
          surface: "server",
          route: typeof (request as { path?: unknown })?.path === "string"
            ? (request as { path: string }).path
            : null,
          context: {
            routerKind: (context as { routerKind?: unknown })?.routerKind,
            routePath: (context as { routePath?: unknown })?.routePath,
          },
        });
      })
      .catch(() => {
        /* reporter must never throw */
      });
  }
  return Sentry.captureRequestError(err, request, context);
};
