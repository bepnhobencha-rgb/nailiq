"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function SetupBackNav({
  slug,
  title,
  titleAccessory,
  backHref,
  backLabel,
}: {
  slug: string;
  title: string;
  /** Icon or badge shown before the title (e.g. settings gear). */
  titleAccessory?: ReactNode;
  /** Optional guided-setup return path. Defaults to the Dashboard. */
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <header className="mb-6">
      <Link
        href={backHref ?? `/dashboard/${encodeURIComponent(slug)}`}
        className="inline-flex min-h-11 touch-manipulation items-center text-base font-medium text-nq-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40"
      >
        {backLabel ?? "← Dashboard"}
      </Link>
      <h1 className="mt-3 flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight text-nq-foreground sm:text-2xl">
        {titleAccessory ? (
          <span className="inline-flex shrink-0 text-nq-primary" aria-hidden>
            {titleAccessory}
          </span>
        ) : null}
        <span className="min-w-0">{title}</span>
      </h1>
    </header>
  );
}
