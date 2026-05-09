import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { absolute: "Page not found | NailIQ" },
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="min-h-dvh bg-nq-bg text-nq-foreground">
      <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col items-center justify-center gap-6 px-5 py-16 text-center md:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-nq-muted">
          404 · Not found
        </p>
        <h1 className="text-balance text-3xl font-semibold tracking-tight md:text-4xl">
          Page not found
        </h1>
        <p className="text-pretty text-base leading-relaxed text-nq-muted">
          The page you&rsquo;re looking for doesn&rsquo;t exist or may have moved.
        </p>
        <div className="mt-2 flex flex-col items-center gap-3 sm:flex-row">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-nq-primary/50 bg-nq-primary px-6 py-3 text-sm font-semibold text-nq-bg transition hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
          >
            Back to home
          </Link>
          <Link
            href="/register"
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-nq-border/60 bg-nq-surface/40 px-6 py-3 text-sm font-medium text-nq-foreground transition hover:bg-nq-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
          >
            Create your salon
          </Link>
        </div>
      </div>
    </main>
  );
}
