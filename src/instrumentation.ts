import { installInternalErrorHandler } from "@/shared/observability/errorReporter";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { logError } = await import("./shared/observability/errorLog");
    installInternalErrorHandler((error) => {
      void logError(error);
    });
  }
}

// Capture server request failures in NailIQ's own error_logs store.
export function onRequestError(err: unknown, request: unknown, context: unknown) {
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
}
