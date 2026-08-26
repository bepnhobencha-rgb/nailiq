"use client";

import { useEffect } from "react";
import * as ErrorReporter from "@/shared/observability/errorReporter";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    ErrorReporter.captureException(error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-nq-bg px-6 py-16 text-center text-nq-foreground">
      <section className="w-full max-w-sm rounded-2xl border border-nq-border bg-nq-surface p-6 shadow-nq-card">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-nq-primary/35 bg-nq-primary/10 text-sm font-bold text-nq-primary">
          NQ
        </div>
        <h1 className="mt-5 text-lg font-semibold">Dashboard could not load</h1>
        <p className="mt-2 text-sm leading-relaxed text-nq-muted">
          Please try again. Your salon data has not been changed.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-6 min-h-11 w-full rounded-xl bg-nq-primary px-4 py-2.5 text-sm font-semibold text-black transition hover:bg-nq-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary-soft"
        >
          Try again
        </button>
      </section>
    </main>
  );
}
