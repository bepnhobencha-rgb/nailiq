"use client";

import Link from "next/link";
import { isOpeningHoursCustomized } from "@/shared/dashboard/openingHoursDefaults";
import { getUserMessages } from "@/shared/i18n/user";
import type { UserLanguage } from "@/shared/i18n/user/types";
import { cn } from "@/shared/lib/cn";

export type SetupChecklistSalon = {
  services_count: number;
  staff_count: number;
  address: string | null;
  opening_hours: unknown;
  email: string | null;
};

export function SetupChecklist({
  salon,
  slug,
  language,
}: {
  salon: SetupChecklistSalon;
  slug: string;
  language: UserLanguage;
}) {
  const t = getUserMessages(language).ownerDashboard.setupChecklist;
  const openingHoursCustomized = isOpeningHoursCustomized(salon.opening_hours);

  const items = [
    {
      key: "services",
      label: t.addServices,
      done: salon.services_count > 1,
      href: `/dashboard/${slug}/setup/services`,
    },
    {
      key: "staff",
      label: t.addStaff,
      done: salon.staff_count > 1,
      href: `/dashboard/${slug}/setup/staff`,
    },
    {
      key: "hours",
      label: t.setHours,
      done: openingHoursCustomized,
      href: `/dashboard/${slug}/setup/hours`,
    },
    {
      key: "address",
      label: t.addAddress,
      done: !!salon.address?.trim(),
      href: `/dashboard/${slug}/setup/address`,
    },
    {
      key: "email",
      label: t.addEmail,
      done: !!salon.email?.trim(),
      href: "#email",
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  const percent = Math.round((doneCount / items.length) * 100);

  if (percent === 100) {
    return null;
  }

  return (
    <section
      className="nq-setup-checklist-enter mb-4 w-full rounded-2xl border border-nq-primary/55 bg-nq-primary/[0.06] px-4 py-4 ring-1 ring-inset ring-nq-primary/20"
      aria-label={t.ariaLabel}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-semibold text-nq-foreground">{t.title}</p>
        <p
          className="text-xs font-medium tabular-nums text-nq-muted"
          aria-live="polite"
        >
          {t.percentComplete.replace("{n}", String(percent))}
        </p>
      </div>
      {/* Progress bar — width-only animation; pure CSS per
          ANIMATION_RULES.md (no library). */}
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-nq-surface"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={t.ariaLabel}
      >
        <div
          className="h-full rounded-full bg-nq-primary transition-[width] duration-200 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <ul className="mt-4 flex flex-col gap-2">
        {items.map((item) =>
          item.done ? (
            <li key={item.key}>
              <span className="flex min-h-11 items-center gap-2 rounded-xl border border-transparent bg-nq-success/[0.06] px-3 py-2 text-sm text-nq-muted">
                <span
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-nq-success/20 text-xs font-bold text-nq-success"
                  aria-hidden
                >
                  ✓
                </span>
                <span className="min-w-0 flex-1 truncate leading-snug line-through decoration-nq-muted/60">
                  {item.label}
                </span>
              </span>
            </li>
          ) : (
            <li key={item.key}>
              <Link
                href={item.href}
                className={cn(
                  // Button-like row: bordered + filled, not plain text.
                  // Hover lifts the surface + reveals a stronger gold
                  // border so it's unmistakably tappable.
                  "group flex min-h-11 w-full touch-manipulation items-center gap-3 rounded-xl",
                  "border border-nq-border/40 bg-nq-surface/40 px-3 py-2",
                  "transition-colors",
                  "hover:border-nq-primary/60 hover:bg-nq-primary/10 hover:text-nq-primary",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
                )}
              >
                <span
                  aria-hidden
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-nq-primary/40 text-xs font-bold text-nq-primary"
                >
                  +
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium leading-snug text-nq-foreground group-hover:text-nq-primary">
                  {item.label}
                </span>
                <span
                  aria-hidden
                  className="shrink-0 text-base text-nq-primary/70 transition-transform group-hover:translate-x-0.5 group-hover:text-nq-primary"
                >
                  →
                </span>
              </Link>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
