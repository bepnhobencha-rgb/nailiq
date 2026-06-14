import { type ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * Shared empty-state primitive for dashboard surfaces. Centers an optional
 * icon chip, a title, a supporting line, and an optional action so every
 * "nothing here yet" screen reads the same way instead of each page
 * hand-rolling its own (and reaching for emoji). Pass `action` as a fully
 * styled button/link.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-nq-border/40 bg-nq-surface/30 px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden
          className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-nq-primary/10 text-nq-primary"
        >
          {icon}
        </span>
      ) : null}
      <p className="text-base font-semibold text-nq-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-nq-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
