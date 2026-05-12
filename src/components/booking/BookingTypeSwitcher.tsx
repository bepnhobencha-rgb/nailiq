"use client";

import { useState } from "react";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type { ServiceCategorySummary } from "@/shared/booking/loadServiceCategories";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { BookingGroupFlow } from "@/components/booking/BookingGroupFlow";
import { cn } from "@/shared/lib/cn";

/**
 * Public booking entry-type selector — wraps both single-guest and
 * group flows so the customer can toggle between them on the
 * booking page. Default is `individual` so the existing UX is
 * unchanged for the 95% case.
 *
 * The toggle is intentionally a tiny two-button pill — no full
 * stepper for the choice itself, because going down the wrong path
 * is cheap to undo (just flip the pill back).
 */
export function BookingTypeSwitcher({
  t,
  shopSlug,
  services,
  staff,
  salon,
  capabilityRows,
  categories,
}: {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  salon: BookingSalonMeta;
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  categories: readonly ServiceCategorySummary[];
}) {
  const [mode, setMode] = useState<"individual" | "group">("individual");
  const groupCopy = t.groupBooking;

  return (
    <div>
      <div
        role="tablist"
        aria-label={groupCopy.entryTitle}
        data-testid="booking-type-switcher"
        className="mt-6 inline-flex rounded-full border border-[var(--booking-border)] bg-[var(--booking-bg-input)]/40 p-0.5 text-sm font-medium"
      >
        {(["individual", "group"] as const).map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={active}
              data-testid={`booking-type-${m}`}
              onClick={() => setMode(m)}
              className={cn(
                "min-h-9 rounded-full px-4 py-1.5 transition-colors",
                active
                  ? "bg-[var(--salon-primary)] text-[var(--booking-bg)]"
                  : "text-[var(--booking-text-muted)] hover:text-[var(--booking-text)]",
              )}
            >
              {m === "individual" ? groupCopy.individual : groupCopy.group}
            </button>
          );
        })}
      </div>

      {mode === "individual" ? (
        <BookingFlow
          t={t}
          shopSlug={shopSlug}
          services={services}
          staff={staff}
          salon={salon}
          capabilityRows={capabilityRows}
          categories={categories}
        />
      ) : (
        <BookingGroupFlow
          t={t}
          shopSlug={shopSlug}
          services={services}
          staff={staff}
          salon={salon}
        />
      )}
    </div>
  );
}
