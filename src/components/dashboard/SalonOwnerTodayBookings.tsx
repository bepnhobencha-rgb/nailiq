"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import {
  nextBookingStatus,
  salonBookingStatusClass,
  salonBookingStatusLabel,
} from "@/components/dashboard/salonDashboardFormat";
import { getUserMessages } from "@/shared/i18n/user";
import { formatNailiqBookingRef } from "@/shared/lib/formatNailiqBookingRef";
import { maskPhoneDigits } from "@/shared/lib/maskPhone";
import type { SalonDashboardBooking } from "@/shared/types";
import { bookingIdsEqual } from "@/shared/lib/bookingIdsEqual";
import { cn } from "@/shared/lib/cn";

export function SalonOwnerTodayBookings({
  items,
  language,
  bookingHref,
  isSaving,
  onAdvanceStatus,
  highlightBookingId,
}: {
  items: SalonDashboardBooking[];
  language: "en" | "vi";
  /** Public booking page path, e.g. `/my-salon` */
  bookingHref: string;
  isSaving: boolean;
  onAdvanceStatus: (b: SalonDashboardBooking) => void;
  highlightBookingId?: string | null;
}) {
  const t = getUserMessages(language).salonDashboard;
  // `toLocaleTimeString` uses the runtime's local timezone — server (UTC) and
  // browser TZ disagree, which would crash hydration. Render the dash placeholder
  // through hydration, swap to the localized time after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe mounted flag (TZ-dependent locale time)
    setMounted(true);
  }, []);

  return (
    <section className="mt-8 overflow-visible" aria-label={t.todayAppointments}>
      <h2 className="text-lg font-semibold text-nq-foreground">{t.todayAppointments}</h2>
      <ul className="mt-3 flex flex-col gap-2 overflow-visible">
        {items.length === 0 ? (
          <li className="rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-6 text-center">
            <p className="text-base font-medium text-nq-foreground">
              {t.emptyTodayTitle}
            </p>
            <p className="mt-2 text-sm leading-snug text-nq-muted">
              {t.emptyTodayHint}
            </p>
            <Link
              href={bookingHref}
              className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl border border-nq-primary/45 bg-nq-primary/10 px-4 text-base font-semibold text-nq-primary transition-colors hover:bg-nq-primary/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/50"
            >
              {t.viewBookingPage}
            </Link>
          </li>
        ) : (
          items.map((b) => {
            const showHighlight = bookingIdsEqual(b.id, highlightBookingId);
            return (
            <li
              key={b.id}
              className={cn(
                "relative overflow-visible rounded-2xl border px-4 py-3",
                salonBookingStatusClass(b.status),
              )}
            >
              {showHighlight ? (
                <span
                  className="nq-new-booking-highlight absolute inset-0 z-0 rounded-2xl"
                  aria-hidden
                />
              ) : null}
              <div className="relative z-[1] w-full min-w-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold tabular-nums text-nq-foreground">
                  {b.start_time_utc && mounted
                    ? new Date(b.start_time_utc).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}
                </p>
                <span className="flex items-center gap-1.5">
                  {b.seat_together ? (
                    <span
                      data-testid={`owner-booking-seat-together-${b.id}`}
                      title={t.seatTogether}
                      className="rounded-full border border-[var(--salon-primary)]/40 bg-[var(--salon-primary)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--salon-primary)]"
                    >
                      💕 {t.seatTogether}
                    </span>
                  ) : null}
                  <span className="rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-medium">
                    {salonBookingStatusLabel(b.status, t)}
                  </span>
                </span>
              </div>
              <p className="mt-1 font-mono text-[11px] text-nq-muted/90">
                {formatNailiqBookingRef(b.id)}
              </p>
              <p className="mt-2 text-[15px] font-medium text-nq-foreground">
                {b.client_name}
              </p>
              <p className="text-base text-nq-muted">
                {t.phone}:{" "}
                {b.client_phone
                  ? maskPhoneDigits(b.client_phone.replace(/\D/g, ""))
                  : "—"}
              </p>
              <p className="mt-1 text-base text-nq-muted">
                {t.service}: {b.service_name}
              </p>
              {b.staff_name ? (
                <p className="mt-1 text-base text-nq-muted">
                  {t.salonStaffLabel}: {b.staff_name}
                </p>
              ) : null}
              {b.client_notes ? (
                <p className="mt-2 rounded-xl border border-nq-border/25 bg-nq-bg/40 px-3 py-2 text-sm leading-snug text-nq-foreground/95">
                  <span className="font-medium text-nq-muted">{t.clientNotes}: </span>
                  {b.client_notes}
                </p>
              ) : null}
              {nextBookingStatus(b.status) ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  className="mt-3 w-full min-h-11 border-nq-border/50"
                  disabled={isSaving}
                  onClick={() => onAdvanceStatus(b)}
                >
                  {t.advanceStatus}
                </Button>
              ) : null}
              </div>
            </li>
            );
          })
        )}
      </ul>
    </section>
  );
}
