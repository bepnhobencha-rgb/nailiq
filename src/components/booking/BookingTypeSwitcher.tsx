"use client";

import { useState, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { BookingComboItem, BookingServiceItem } from "@/shared/booking/catalog";
import type { ServiceCategorySummary } from "@/shared/booking/loadServiceCategories";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { BookingGroupFlow } from "@/components/booking/BookingGroupFlow";
import { VoiceBookingButton } from "@/components/booking/VoiceBookingButton";
import { cn } from "@/shared/lib/cn";

/** QA round-2: group bookings need at least N distinct staff free at
 * the same time. The picker is capped at 6 (anything bigger is rare
 * and stresses the salon layout); the real cap is whichever is
 * smaller — the salon's active-staff count, or 6. A salon with only
 * one stylist physically can't host a group booking, so the toggle
 * vanishes entirely below this threshold. */
const HARD_GROUP_CAP = 6;
const MIN_GROUP_SIZE = 2;

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
  combos,
  staff,
  salon,
  capabilityRows,
  categories,
  language = "en",
  voiceAiEnabled = false,
}: {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  combos: readonly BookingComboItem[];
  staff: readonly BookingStaffItem[];
  salon: BookingSalonMeta;
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  categories: readonly ServiceCategorySummary[];
  language?: "en" | "vi";
  voiceAiEnabled?: boolean;
}) {
  // P2.3 — initialize from ?mode= so language switch (which reloads
  // the page) doesn't drop the user back to individual.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const initialMode: "individual" | "group" =
    searchParams.get("mode") === "group" ? "group" : "individual";
  const [mode, setMode] = useState<"individual" | "group">(initialMode);

  // Reflect mode changes back into the URL so language-toggle reloads
  // pick the same mode up via `searchParams.get("mode")`. Uses
  // `router.replace` so the history stack stays clean (the user
  // doesn't want a back-button trail for "individual → group").
  useEffect(() => {
    const current = new URLSearchParams(searchParams.toString());
    if (mode === "group") current.set("mode", "group");
    else current.delete("mode");
    const qs = current.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [mode, pathname, router, searchParams]);
  // QA round-2: active-staff-count drives group capacity. `staff` is
  // already pre-filtered to `status='active'` upstream in
  // `loadBookingServicesForSalonSlug`, so .length is the count.
  const activeStaffCount = staff.length;
  const maxGroupSize = Math.min(activeStaffCount, HARD_GROUP_CAP);
  const groupEnabled = maxGroupSize >= MIN_GROUP_SIZE;

  // Defensive fallback — older deployed booking i18n bundles (before
  // PR #140 / #141) may not have the `groupBooking` namespace; if a
  // cached client gets here without it the destructure would throw
  // inside the error boundary. Synthesize a minimal English default
  // so the toggle still renders and we don't blank-screen.
  const groupCopy = (t.groupBooking ?? {
    entryTitle: "How would you like to book?",
    individual: "Individual",
    group: "Group 👥",
  }) as NonNullable<BookingMessages["groupBooking"]>;

  // Solo-staff salon → no group booking, no toggle. Render only the
  // individual flow so the page reads exactly like the pre-group
  // experience for these salons.
  if (!groupEnabled) {
    return (
      <div className="space-y-4">
        {voiceAiEnabled && (
          <VoiceBookingButton t={t} shopSlug={shopSlug} language={language} />
        )}
        <BookingFlow
          t={t}
          shopSlug={shopSlug}
          services={services}
          combos={combos}
          staff={staff}
          salon={salon}
          capabilityRows={capabilityRows}
          categories={categories}
          language={language}
        />
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-4" data-testid="booking-type-switcher-root">
      {voiceAiEnabled && (
        <VoiceBookingButton t={t} shopSlug={shopSlug} language={language} />
      )}
      {/* Heading + pill stacked. Was previously an inline-flex pill
          on its own line with no heading — easy to miss on first
          paint. Promoted to a small section so it's clearly part of
          the booking flow, not site chrome. */}
      <p
        id="booking-type-heading"
        className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--booking-text-muted)]"
      >
        {groupCopy.entryTitle}
      </p>
      <div
        role="tablist"
        aria-labelledby="booking-type-heading"
        aria-label={groupCopy.entryTitle}
        data-testid="booking-type-switcher"
        className="mt-2 flex w-full max-w-md rounded-full border border-[var(--booking-border)] bg-[var(--booking-bg-input)] p-1 text-sm font-semibold"
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
                // P2.4 — touch target 44px (was 40px). Matches the
                // Apple HIG / WCAG 2.2 SC 2.5.5 recommendation and
                // the rest of the booking surface.
                "flex-1 min-h-11 rounded-full px-4 py-2 transition-colors",
                active
                  ? "bg-[var(--salon-primary)] text-[var(--booking-bg)] shadow-sm"
                  : "text-[var(--booking-text)] hover:bg-[var(--booking-bg-card)]",
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
          combos={combos}
          staff={staff}
          salon={salon}
          capabilityRows={capabilityRows}
          categories={categories}
          language={language}
        />
      ) : (
        <BookingGroupFlow
          t={t}
          shopSlug={shopSlug}
          services={services}
          staff={staff}
          salon={salon}
          maxGroupSize={maxGroupSize}
          capabilityRows={capabilityRows}
        />
      )}
    </div>
  );
}
