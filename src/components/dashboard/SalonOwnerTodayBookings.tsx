"use client";

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
import { cn } from "@/shared/lib/cn";

export function SalonOwnerTodayBookings({
  items,
  language,
  bookingHref,
  isSaving,
  onAdvanceStatus,
}: {
  items: SalonDashboardBooking[];
  language: "en" | "vi";
  /** Public booking page path, e.g. `/my-salon` */
  bookingHref: string;
  isSaving: boolean;
  onAdvanceStatus: (b: SalonDashboardBooking) => void;
}) {
  const t = getUserMessages(language).salonDashboard;

  return (
    <section className="mt-8" aria-label={t.todayAppointments}>
      <h2 className="text-lg font-semibold text-nq-foreground">{t.todayAppointments}</h2>
      <ul className="mt-3 flex flex-col gap-2">
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
          items.map((b) => (
            <li
              key={b.id}
              className={cn(
                "rounded-2xl border px-4 py-3",
                salonBookingStatusClass(b.status),
              )}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold tabular-nums text-nq-foreground">
                  {new Date(b.start_time_utc).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
                <span className="rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-medium">
                  {salonBookingStatusLabel(b.status, t)}
                </span>
              </div>
              <p className="mt-1 font-mono text-[11px] text-nq-muted/90">
                {formatNailiqBookingRef(b.id)}
              </p>
              <p className="mt-2 text-[15px] font-medium text-nq-foreground">
                {b.client_name}
              </p>
              <p className="text-base text-nq-muted">
                {t.phone}: {maskPhoneDigits(b.client_phone.replace(/\D/g, ""))}
              </p>
              <p className="mt-1 text-base text-nq-muted">
                {t.service}: {b.service_name}
              </p>
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
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
