"use client";

import Link from "next/link";

export function SetupBackNav({ slug, title }: { slug: string; title: string }) {
  return (
    <header className="mb-6">
      <Link
        href={`/dashboard/${encodeURIComponent(slug)}`}
        className="inline-flex min-h-11 touch-manipulation items-center text-base font-medium text-nq-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40"
      >
        ← Dashboard
      </Link>
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-nq-foreground sm:text-2xl">
        {title}
      </h1>
    </header>
  );
}
