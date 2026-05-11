"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { formatNailiqBookingRef } from "@/shared/lib/formatNailiqBookingRef";
import {
  cleanPhone,
  formatPhone,
  isValidPhoneE164,
} from "@/shared/lib/phoneFormat";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import { getPublicStaffDisplayName } from "@/shared/booking/publicStaffDisplay";
import { formatGuestPriceUsd } from "@/shared/booking/formatBookingPrice";
import {
  formatInSalonTz,
  salonTimezoneAbbreviation,
} from "@/shared/lib/salonTime";

export function BookingFlowDonePanel({
  t,
  shopLabel,
  service,
  staffName,
  addonServiceName,
  addonPriceCents,
  displayStartUtc,
  displayEndUtc,
  bookingId,
  salonPhone,
  salonTimezone,
  totalPaidFormatted,
  onAddToCalendar,
  onBookAnother,
}: {
  t: BookingMessages;
  shopLabel: string;
  service: BookingServiceItem | undefined;
  staffName: string;
  addonServiceName: string | null;
  addonPriceCents: number | null;
  displayStartUtc: string;
  displayEndUtc: string;
  bookingId: string;
  /** Public salon line: `salons.salon_phone` only (not owner `phone`, never guest). */
  salonPhone: string | null;
  /** IANA TZ — confirmation displays the booking time in the salon's local zone (B-16). */
  salonTimezone: string;
  /** Receipt-style total from `bookingResult.price_cents`. */
  totalPaidFormatted: string;
  /** Fires the .ics download. Returns true if the click was dispatched. */
  onAddToCalendar: () => boolean;
  onBookAnother: () => void;
}) {
  const refLabel = formatNailiqBookingRef(bookingId);
  const [shareHint, setShareHint] = useState<string | null>(null);
  const [calendarHint, setCalendarHint] = useState<string | null>(null);

  const handleAddToCalendarClick = useCallback(() => {
    const ok = onAddToCalendar();
    if (!ok) return;
    setCalendarHint(t.addToCalendarDownloaded);
    window.setTimeout(() => setCalendarHint(null), 2800);
  }, [onAddToCalendar, t.addToCalendarDownloaded]);

  const start = new Date(displayStartUtc);
  const end = new Date(displayEndUtc);
  // Show the time in the *salon's* timezone, not the customer's browser-local
  // (B-16). Append the short tz abbreviation when Intl can resolve one so the
  // customer can disambiguate (e.g. "Sat, Jun 7 · 2:00 PM PDT").
  const whenLabel = (() => {
    if (Number.isNaN(start.getTime())) return "—";
    try {
      const dt = formatInSalonTz(displayStartUtc, salonTimezone, "datetime");
      const abbr = salonTimezoneAbbreviation(salonTimezone, displayStartUtc);
      return abbr ? `${dt} ${abbr}` : dt;
    } catch {
      return "—";
    }
  })();
  const totalMinutes =
    Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
      ? 0
      : Math.max(
          0,
          Math.round((end.getTime() - start.getTime()) / 60_000),
        );
  const hasAddon =
    !!(addonServiceName && addonServiceName.trim().length > 0);
  const durationLabel =
    totalMinutes > 0
      ? hasAddon
        ? `${t.summaryDurationMinutes.replace("{n}", String(totalMinutes))} (${t.summaryDurationIncludesAddon})`
        : t.summaryDurationMinutes.replace("{n}", String(totalMinutes))
      : null;

  const staffDisplayName = getPublicStaffDisplayName(
    staffName,
    t.staffPlaceholderName,
  );
  const staffLine =
    staffName.trim().length > 0
      ? t.successStaffLine.replace("{name}", staffDisplayName)
      : "";

  const callPhoneRaw = salonPhone?.trim() || null;
  const manageTel =
    callPhoneRaw && isValidPhoneE164(callPhoneRaw)
      ? `tel:${cleanPhone(callPhoneRaw)}`
      : null;
  const callPhoneDisplay = callPhoneRaw ? formatPhone(callPhoneRaw) : "";

  const handleShare = useCallback(async () => {
    if (typeof window === "undefined") return;
    const url = window.location.href.split("#")[0];
    if (!url) return;

    const detailLines = [
      `${refLabel} — ${shopLabel}`,
      whenLabel !== "—" ? whenLabel : null,
      service?.name?.trim() ? service.name.trim() : null,
    ].filter((x): x is string => typeof x === "string" && x.length > 0);
    const textBody = [...detailLines, url].join("\n");
    const title = `${t.shareBookingSheetTitle} · ${shopLabel}`;

    const copyDetails = async (): Promise<boolean> => {
      if (!navigator.clipboard?.writeText) return false;
      try {
        await navigator.clipboard.writeText(textBody);
        setShareHint(t.shareBookingCopied);
        window.setTimeout(() => setShareHint(null), 2800);
        return true;
      } catch {
        return false;
      }
    };

    try {
      if (typeof navigator.share === "function") {
        await navigator.share({
          title,
          text: textBody,
          url,
        });
        return;
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }

    await copyDetails();
  }, [
    refLabel,
    service,
    shopLabel,
    t.shareBookingCopied,
    t.shareBookingSheetTitle,
    whenLabel,
  ]);

  return (
    <div
      className="fade-in mt-10 w-full space-y-8"
      data-testid="booking-success"
    >
      <div className="flex flex-col items-center text-center">
        <div
          className="flex h-[5.25rem] w-[5.25rem] shrink-0 items-center justify-center rounded-full bg-[var(--salon-primary)] text-nq-bg ring-4 ring-[color-mix(in_srgb,var(--salon-primary)_25%,transparent)]"
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
        {staffLine ? (
          <p className="mt-3 text-lg font-medium tracking-tight text-[var(--salon-primary)]">
            {staffLine}
          </p>
        ) : null}
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
          {addonServiceName && addonServiceName.trim().length > 0 ? (
            <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] pb-3.5 text-[15px] sm:text-base">
              <span className="font-semibold text-nq-muted">
                {t.summaryAddOn}
              </span>
              <span className="min-w-0 shrink text-right font-semibold text-nq-foreground">
                {(() => {
                  const priceLabel = formatGuestPriceUsd(addonPriceCents);
                  return priceLabel
                    ? `${addonServiceName.trim()} — ${priceLabel}`
                    : addonServiceName.trim();
                })()}
              </span>
            </div>
          ) : null}
          {staffName.trim().length > 0 ? (
            <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] pb-3.5 text-[15px] sm:text-base">
              <span className="font-semibold text-nq-muted">{t.summaryStaff}</span>
              <span className="min-w-0 shrink text-right font-semibold text-nq-foreground">
                {staffDisplayName}
              </span>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-4 text-[15px] sm:text-base">
            <span className="font-semibold text-nq-muted">{t.summaryTime}</span>
            <span className="min-w-0 shrink text-right font-semibold text-[var(--salon-primary)]">
              {whenLabel}
            </span>
          </div>
          {durationLabel ? (
            <div className="flex items-baseline justify-between gap-4 border-t border-white/[0.06] pt-3.5 text-[15px] sm:text-base">
              <span className="font-semibold text-nq-muted">
                {t.summaryDuration}
              </span>
              <span className="min-w-0 shrink text-right font-semibold text-nq-foreground">
                {durationLabel}
              </span>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-4 border-t border-white/[0.06] pt-3.5 text-[15px] sm:text-base">
            <span className="font-semibold text-nq-muted">{t.summaryTotal}</span>
            <span className="min-w-0 shrink text-right font-semibold tabular-nums text-[var(--salon-primary)]">
              {totalPaidFormatted}
            </span>
          </div>
        </div>
        <p className="mt-5 border-t border-white/[0.08] pt-4 text-sm text-nq-muted">
          <span className="text-nq-muted">{t.bookingReferenceLabel}: </span>
          <span className="font-mono text-[var(--salon-primary)]">{refLabel}</span>
        </p>
      </div>

      {shareHint || calendarHint ? (
        <p
          className="text-center text-sm text-nq-success"
          role="status"
          aria-live="polite"
        >
          {shareHint ?? calendarHint}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:justify-center lg:justify-end lg:gap-4">
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="nq-booking-glass min-h-11 w-full shrink-0 border border-[color-mix(in_srgb,var(--salon-primary)_35%,transparent)] bg-transparent text-[var(--salon-primary)] shadow-none hover:bg-white/[0.04] hover:opacity-100 sm:min-w-[11rem] lg:w-auto"
          onClick={handleAddToCalendarClick}
        >
          {t.addToCalendar}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="nq-booking-glass min-h-11 w-full shrink-0 border border-[color-mix(in_srgb,var(--salon-primary)_35%,transparent)] bg-transparent text-[var(--salon-primary)] shadow-none hover:bg-white/[0.04] hover:opacity-100 sm:min-w-[11rem] lg:w-auto"
          onClick={() => void handleShare()}
        >
          {t.shareBooking}
        </Button>
        <LuxuryBookingCta className="lg:min-w-[11rem]" onClick={onBookAnother}>
          {t.doneCta}
        </LuxuryBookingCta>
      </div>

      {manageTel ? (
        <div className="flex justify-center lg:justify-end">
          {(() => {
            const callLabel = t.manageBookingCall.replace(
              "{phone}",
              callPhoneDisplay,
            );
            return (
              <a
                data-testid="booking-call-reschedule"
                href={manageTel}
                aria-label={callLabel}
                className="nq-booking-glass inline-flex min-h-14 w-full max-w-md items-center justify-center rounded-2xl border border-white/[0.12] px-6 py-3 text-center text-base font-medium text-nq-foreground shadow-none hover:bg-white/[0.04] sm:w-auto"
              >
                {callLabel}
              </a>
            );
          })()}
        </div>
      ) : null}
    </div>
  );
}
