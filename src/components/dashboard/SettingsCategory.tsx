"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * Collapsible category wrapper for the Settings hub. Groups a stack of
 * setting panels under a labelled header with a subtitle so owners can
 * scan five categories instead of one long heap. Open by default unless
 * `defaultOpen={false}` (used for less-common categories).
 *
 * Pure presentation — it does not touch any panel's own gating; callers
 * keep their existing conditional rendering inside `children`.
 */
export function SettingsCategory({
  id,
  title,
  subtitle,
  defaultOpen = true,
  children,
}: {
  /** Anchor id so the top jump-bar can scroll to this category. */
  id: string;
  title: string;
  subtitle: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      id={id}
      data-testid={`settings-category-${id}`}
      // scroll-mt offsets the sticky header when jumped to via anchor.
      className="mt-6 scroll-mt-20"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center justify-between gap-3 rounded-2xl border border-nq-border/40 bg-nq-surface/50 px-4 py-3 text-left transition-colors",
          "hover:border-nq-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
        )}
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold text-nq-foreground">
            {title}
          </span>
          <span className="mt-0.5 block truncate text-xs text-nq-muted">
            {subtitle}
          </span>
        </span>
        <span
          aria-hidden
          className={cn(
            "shrink-0 text-nq-muted transition-transform duration-[var(--duration-nq-base)]",
            open ? "rotate-180" : "rotate-0",
          )}
        >
          ▾
        </span>
      </button>

      {open ? (
        <div className="mt-3 flex flex-col gap-3">{children}</div>
      ) : null}
    </section>
  );
}

/**
 * Sticky chip bar that jumps to each category section. Plain anchor
 * links keep it working without JS and avoid coupling to scroll state.
 */
export function SettingsJumpBar({
  label,
  items,
}: {
  label: string;
  items: { id: string; title: string }[];
}) {
  return (
    <nav
      aria-label={label}
      className="sticky top-0 z-10 -mx-4 mt-4 flex gap-2 overflow-x-auto bg-nq-bg/85 px-4 py-2 backdrop-blur [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {items.map((it) => (
        <a
          key={it.id}
          href={`#${it.id}`}
          className={cn(
            "whitespace-nowrap rounded-full border border-nq-border/50 bg-nq-surface/50 px-3 py-1.5 text-xs font-medium text-nq-muted",
            "transition-colors hover:border-nq-primary/40 hover:text-nq-primary",
          )}
        >
          {it.title}
        </a>
      ))}
    </nav>
  );
}
