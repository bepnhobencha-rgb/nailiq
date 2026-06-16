"use client";

import { useTransition } from "react";
import { signOutSuperadminAction } from "@/shared/superadmin/superadminAuth";
import { cn } from "@/shared/lib/cn";

type Props = {
  /** When true (collapsed sidebar), renders a compact icon-only button. */
  compact?: boolean;
};

/**
 * Sign-out affordance for the superadmin shell.
 *
 * - Expanded (default): labelled button matching `LogoutButton` style.
 * - Compact (`compact` prop): icon-only button for the collapsed sidebar;
 *   a `title` tooltip surfaces the label for screen readers / pointer users.
 * - Calls `signOutSuperadminAction` (server action) which signs out via
 *   Supabase then redirects to `/superadmin/login`.
 */
export function SuperadminSignOutButton({ compact = false }: Props) {
  const [pending, startTransition] = useTransition();

  const handleClick = () => {
    if (typeof window !== "undefined") {
      const confirmed = window.confirm("Are you sure you want to sign out?");
      if (!confirmed) return;
    }
    startTransition(async () => {
      await signOutSuperadminAction();
    });
  };

  if (compact) {
    return (
      <button
        type="button"
        aria-label="Sign out"
        title="Sign out"
        onClick={handleClick}
        disabled={pending}
        aria-busy={pending || undefined}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-nq-border text-nq-muted transition-colors",
          "hover:bg-nq-bg hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
          "disabled:cursor-not-allowed disabled:opacity-55",
        )}
      >
        <span aria-hidden="true" className="text-sm leading-none">
          →
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-busy={pending || undefined}
      className={cn(
        "inline-flex w-full min-h-9 touch-manipulation items-center gap-1.5 rounded-lg border border-nq-border/45 bg-nq-surface/45 px-2.5 py-1 text-xs font-medium text-nq-muted transition-colors",
        "hover:bg-nq-surface/65 hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
        "disabled:cursor-not-allowed disabled:opacity-55",
      )}
    >
      <span aria-hidden className="text-base leading-none">
        →
      </span>
      Sign out
    </button>
  );
}
