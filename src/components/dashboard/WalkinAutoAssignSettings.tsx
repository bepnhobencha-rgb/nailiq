"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { updateWalkinAutoAssign } from "@/shared/dashboard/salonOwnerActions";
import { getUserMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

/**
 * Owner-only toggle for `salons.walkin_auto_assign`.
 *
 * The setting decides whether the receptionist's "Assign immediately"
 * path is even offered. When OFF, every walk-in lands in
 * `status=waiting` so the desk reviews the queue before dispatching —
 * useful for salons that want a manual gate on staff assignment.
 *
 * Optimistic UI: flips the toggle locally before the server confirms;
 * rolls back + surfaces an inline error on failure. Same pattern as
 * `DashboardModulesSettings` so the settings page reads consistently.
 */

const toggleInputClass =
  "h-6 w-6 shrink-0 cursor-pointer rounded-md border border-nq-border bg-nq-bg accent-nq-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg disabled:cursor-not-allowed disabled:opacity-45";

export function WalkinAutoAssignSettings({
  slug,
  initialValue,
  canEdit,
}: {
  slug: string;
  initialValue: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { language } = useUserLanguage();
  const t = getUserMessages(language).salonSettings.walkinAutoAssign;

  const [enabled, setEnabled] = useState<boolean>(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  /* eslint-disable react-hooks/set-state-in-effect -- intentional sync when parent prop changes (server re-fetch) */
  useEffect(() => {
    setEnabled(initialValue);
    setError(null);
  }, [initialValue]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const onToggle = (next: boolean) => {
    if (!canEdit || isPending) return;
    const prev = enabled;
    setEnabled(next);
    setError(null);
    startTransition(() => {
      void (async () => {
        const r = await updateWalkinAutoAssign(slug, next);
        if (!r.ok) {
          setEnabled(prev);
          setError(t.errorGeneric);
          return;
        }
        router.refresh();
      })();
    });
  };

  return (
    <section
      data-testid="settings-walkin-auto-assign"
      className="mt-4 rounded-2xl border border-nq-border/40 bg-nq-surface/45 px-4 py-4"
    >
      <header className="flex items-center gap-2">
        <span aria-hidden>🚶</span>
        <h2 className="text-base font-semibold text-nq-foreground">
          {t.sectionTitle}
        </h2>
      </header>

      <label
        className={cn(
          "mt-3 flex cursor-pointer items-start gap-3",
          (!canEdit || isPending) && "cursor-not-allowed opacity-65",
        )}
      >
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canEdit || isPending}
          onChange={(e) => onToggle(e.target.checked)}
          data-testid="settings-walkin-auto-assign-toggle"
          className={toggleInputClass}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-nq-foreground">
            {t.toggleLabel}
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-nq-muted">
            {enabled ? t.descriptionOn : t.descriptionOff}
          </span>
        </span>
      </label>

      {error ? (
        <p
          role="alert"
          data-testid="settings-walkin-auto-assign-error"
          className="mt-2 text-xs text-nq-error"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}
