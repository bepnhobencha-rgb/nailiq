"use client";

import Link from "next/link";
import { isOpeningHoursCustomized } from "@/shared/dashboard/openingHoursDefaults";

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
}: {
  salon: SetupChecklistSalon;
  slug: string;
}) {
  const openingHoursCustomized = isOpeningHoursCustomized(salon.opening_hours);

  const items = [
    {
      key: "services",
      label: "Add your services",
      done: salon.services_count > 1,
      href: `/dashboard/${slug}/setup/services`,
    },
    {
      key: "staff",
      label: "Add your staff",
      done: salon.staff_count > 1,
      href: `/dashboard/${slug}/setup/staff`,
    },
    {
      key: "hours",
      label: "Set opening hours",
      done: openingHoursCustomized,
      href: `/dashboard/${slug}/setup/hours`,
    },
    {
      key: "address",
      label: "Add salon address",
      done: !!salon.address?.trim(),
      href: `/dashboard/${slug}/setup/address`,
    },
    {
      key: "email",
      label: "Add recovery email",
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
      aria-label="Salon setup checklist"
    >
      <p className="text-sm font-semibold text-nq-foreground">
        Setup {percent}% complete
      </p>
      <div className="mt-2 h-[4px] overflow-hidden rounded-[2px] bg-nq-surface">
        <div
          className="h-[4px] rounded-[2px] bg-nq-primary transition-[width] duration-200 ease-out"
          style={{
            width: `${percent}%`,
          }}
          role="presentation"
        />
      </div>
      <ul className="mt-4 flex flex-col gap-2">
        {items.map((item) =>
          item.done ? (
            <li key={item.key} className="flex text-sm">
              <span className="flex min-h-11 items-start gap-2 py-2 text-nq-muted">
                <span className="shrink-0 text-nq-success" aria-hidden>
                  ✓
                </span>
                <span className="leading-snug line-through decoration-nq-muted">
                  {item.label}
                </span>
              </span>
            </li>
          ) : (
            <li key={item.key}>
              <Link
                href={item.href}
                className="flex min-h-11 touch-manipulation items-start gap-2 rounded-xl py-2 text-left underline-offset-[3px] transition-colors hover:underline hover:decoration-nq-primary hover:text-nq-primary"
              >
                <span className="shrink-0 pt-0.5 text-nq-primary" aria-hidden>
                  →
                </span>
                <span className="text-sm font-medium leading-snug text-nq-foreground">
                  {item.label}
                </span>
              </Link>
            </li>
          ),
        )}
      </ul>
    </section>
  );
}
