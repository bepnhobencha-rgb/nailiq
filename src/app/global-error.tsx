"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
    // Self-hosted capture (in addition to Sentry).
    try {
      void fetch("/api/errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          message: error?.message ?? "Global render error",
          stack: error?.stack ?? null,
          level: "fatal",
          route: typeof location !== "undefined" ? location.pathname : null,
          context: { digest: error?.digest ?? null },
        }),
      });
    } catch {
      /* never throw from the error screen */
    }
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col items-center justify-center bg-nq-bg px-6 py-16 text-center text-nq-foreground antialiased">
        <p className="text-lg font-medium tracking-tight">
          Something went wrong on our side.
        </p>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-nq-muted">
          Reload the page to continue. Your data is unchanged.
        </p>
      </body>
    </html>
  );
}
