"use client";

import { SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/shared/lib/cn";

type ReceptionistDisplayMenuProps = {
  language: "en" | "vi";
  children: ReactNode;
  className?: string;
};

/**
 * Keeps low-frequency appearance and interface controls out of the live-desk
 * action row. The receptionist should see booking actions first; owners can
 * still reach every display preference from one predictable place.
 */
export function ReceptionistDisplayMenu({
  language,
  children,
  className,
}: ReceptionistDisplayMenuProps) {
  const label = language === "vi" ? "Tùy chọn hiển thị" : "Display options";

  return (
    <details
      className={cn("group relative", className)}
      onClick={(event) => {
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest('[data-testid="receptionist-interface-switcher"]')
        ) {
          event.currentTarget.removeAttribute("open");
        }
      }}
    >
      <summary
        data-testid="receptionist-display-menu-trigger"
        aria-label={label}
        className="inline-flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg border border-nq-border bg-nq-surface px-2.5 text-xs font-semibold text-nq-muted outline-none transition hover:text-nq-foreground focus-visible:ring-2 focus-visible:ring-nq-primary/45 [&::-webkit-details-marker]:hidden"
      >
        <SlidersHorizontal className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">
          {language === "vi" ? "Hiển thị" : "View"}
        </span>
      </summary>
      <div
        data-testid="receptionist-display-menu"
        role="group"
        aria-label={label}
        className="fixed inset-x-3 top-20 z-[80] rounded-2xl border border-nq-border bg-nq-surface p-3 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80"
      >
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-nq-muted">
          {label}
        </p>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
    </details>
  );
}
