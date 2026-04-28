"use client";

import { Button } from "@/components/ui/Button";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { formatNailiqBookingRef } from "@/shared/lib/formatNailiqBookingRef";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";

export function BookingFlowDonePanel({
  t,
  shopLabel,
  service,
  timeSlot,
  bookingId,
  onAddToCalendar,
  onBookAnother,
}: {
  t: BookingMessages;
  shopLabel: string;
  service: BookingServiceItem | undefined;
  timeSlot: string | null;
  bookingId: string;
  onAddToCalendar: () => void;
  onBookAnother: () => void;
}) {
  const refLabel = formatNailiqBookingRef(bookingId);

  return (
    <div className="fade-in mt-10 w-full space-y-8">
      <div className="flex flex-col items-center text-center">
        <div
          className="flex h-[5.25rem] w-[5.25rem] shrink-0 items-center justify-center rounded-full bg-nq-primary text-nq-bg ring-4 ring-nq-primary/25"
          aria-hidden
        >
          <svg
            className="h-11 w-11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="mt-5 text-2xl font-semibold tracking-tight text-nq-foreground sm:text-3xl lg:text-[2.0625rem]">
          {t.successHeading}
        </h2>
        <p className="mt-2 max-w-md text-base leading-relaxed text-nq-muted">
          {t.successSeeYouSoonBefore}
          <span className="font-medium text-nq-foreground">{shopLabel}</span>
        </p>
      </div>

      <div
        className="nq-booking-glass rounded-[1.35rem] px-5 py-5"
        role="group"
        aria-labelledby="success-summary-heading"
      >
        <h3 id="success-summary-heading" className="sr-only">
          {t.stepConfirmHeading}
        </h3>
        <div className="space-y-3.5">
          <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] pb-3.5 text-[15px] sm:text-base">
            <span className="font-semibold text-nq-muted">{t.summaryShop}</span>
            <span className="min-w-0 shrink text-right font-semibold text-nq-foreground tabular-nums">
              {shopLabel}
            </span>
          </div>
          {service ? (
            <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] pb-3.5 text-[15px] sm:text-base">
              <span className="font-semibold text-nq-muted">
                {t.summaryService}
              </span>
              <span className="min-w-0 shrink text-right font-semibold text-nq-foreground">
                {service.name}
              </span>
            </div>
          ) : null}
          {timeSlot ? (
            <div className="flex items-baseline justify-between gap-4 text-[15px] sm:text-base">
              <span className="font-semibold text-nq-muted">{t.summaryTime}</span>
              <span className="min-w-0 shrink text-right font-semibold text-nq-primary">
                {timeSlot}
              </span>
            </div>
          ) : null}
        </div>
        <p className="mt-5 border-t border-white/[0.08] pt-4 text-sm text-nq-muted">
          <span className="text-nq-muted">{t.bookingReferenceLabel}: </span>
          <span className="font-mono text-nq-primary">{refLabel}</span>
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center lg:justify-end lg:gap-4">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="nq-booking-glass min-h-11 w-full shrink-0 border border-nq-primary/35 bg-transparent text-nq-primary shadow-none hover:bg-white/[0.04] hover:opacity-100 sm:min-w-[11rem] lg:w-auto"
          onClick={onAddToCalendar}
        >
          {t.addToCalendar}
        </Button>
        <LuxuryBookingCta className="lg:min-w-[11rem]" onClick={onBookAnother}>
          {t.doneCta}
        </LuxuryBookingCta>
      </div>
    </div>
  );
}
