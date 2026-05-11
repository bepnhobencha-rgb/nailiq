"use client";

import { motion } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import {
  formatGuestPriceUsd,
  formatGuestPriceUsdReceipt,
} from "@/shared/booking/formatBookingPrice";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BookingSummaryGlass } from "@/components/booking/BookingSummaryGlass";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import { cn } from "@/shared/lib/cn";

export function BookingFlowConfirmPanel({
  t,
  shopLabel,
  service,
  confirmTimeLabel,
  staffSummaryLabel,
  clientName,
  clientPhone,
  clientNotes,
  upsellCandidates,
  upsellGapMinutes,
  selectedAddonId,
  error,
  submitting,
  stepDir,
  reducedMotion,
  stepTransition,
  onSelectAddonId,
  onBack,
  onConfirm,
}: {
  t: BookingMessages;
  shopLabel: string;
  service: BookingServiceItem;
  confirmTimeLabel: string;
  staffSummaryLabel: string;
  clientName: string;
  clientPhone: string;
  clientNotes: string;
  upsellCandidates: readonly BookingServiceItem[];
  upsellGapMinutes: number;
  selectedAddonId: string | null;
  error: string | null;
  submitting: boolean;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onSelectAddonId: (id: string | null) => void;
  onBack: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const customerRows = [
    { label: t.summaryClientName, value: clientName.trim() || "—" },
    { label: t.summaryClientPhone, value: clientPhone.trim() || "—" },
    ...(clientNotes.trim().length > 0
      ? [{ label: t.summaryClientNotes, value: clientNotes.trim() }]
      : []),
  ];

  const selectedAddOn =
    selectedAddonId != null
      ? upsellCandidates.find((s) => s.id === selectedAddonId)
      : undefined;

  const totalCents =
    (service.priceCents ?? 0) + (selectedAddOn?.priceCents ?? 0);

  const totalMinutes =
    (service.totalMinutes || 0) + (selectedAddOn?.totalMinutes ?? 0);
  const durationLabel =
    totalMinutes > 0
      ? selectedAddOn
        ? `${t.summaryDurationMinutes.replace("{n}", String(totalMinutes))} (${t.summaryDurationIncludesAddon})`
        : t.summaryDurationMinutes.replace("{n}", String(totalMinutes))
      : null;

  const addonRow = selectedAddOn
    ? (() => {
        const priceLabel =
          selectedAddOn.priceDisplay ??
          formatGuestPriceUsd(selectedAddOn.priceCents);
        return {
          label: t.summaryAddOn,
          value: priceLabel
            ? `${selectedAddOn.name} — ${priceLabel}`
            : selectedAddOn.name,
        };
      })()
    : null;

  const pricingLines = [
    {
      label: t.summaryServicePrice,
      value:
        service.priceDisplay ??
        formatGuestPriceUsd(service.priceCents) ??
        "—",
    },
    ...(addonRow ? [addonRow] : []),
    {
      label: t.summaryTotal,
      value: formatGuestPriceUsdReceipt(totalCents),
      valueGold: true as const,
    },
  ];

  return (
    <motion.div
      key="confirm"
      custom={stepDir}
      variants={bookingStepVariants}
      initial={reducedMotion ? false : "initial"}
      animate="animate"
      exit="exit"
      transition={stepTransition}
      className="flex min-h-[min(100dvh,920px)] flex-col will-change-transform sm:min-h-[70vh] lg:min-h-[min(88dvh,880px)]"
    >
      <section
        aria-labelledby="conf-heading"
        className="flex min-h-0 flex-col"
      >
        <h2
          id="conf-heading"
          className="text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
        >
          {t.stepConfirmHeading}
        </h2>

        <div className="mt-5 shrink-0">
          <BookingSummaryGlass
            t={t}
            shopLabel={shopLabel}
            serviceName={service.name}
            staffSummary={staffSummaryLabel}
            timeLabel={confirmTimeLabel}
            durationLabel={durationLabel}
            pricingLines={pricingLines}
            customerRows={customerRows}
          />
        </div>

        {upsellCandidates.length > 0 ? (() => {
          const heading = t.upsellHeading.replace(
            "{n}",
            String(upsellGapMinutes),
          );
          return (
          <div className="mt-8" role="group" aria-label={heading}>
            <p className="text-sm font-medium text-nq-foreground">{heading}</p>
            <p className="mt-1 text-xs text-nq-muted">{t.upsellToggleHint}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onSelectAddonId(null)}
                className={cn(
                  "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                  selectedAddonId === null
                    ? "border-[var(--salon-primary)] bg-[color-mix(in_srgb,var(--salon-primary)_15%,transparent)] text-[var(--salon-primary)]"
                    : "border-white/[0.12] text-nq-muted hover:border-white/[0.2]",
                )}
              >
                {t.upsellNoThanks}
              </button>
              {upsellCandidates.map((s) => {
                const on = selectedAddonId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => onSelectAddonId(s.id)}
                    className={cn(
                      "rounded-full border px-4 py-2 text-left text-sm font-medium transition-colors",
                      on
                        ? "border-[var(--salon-primary)] bg-[color-mix(in_srgb,var(--salon-primary)_15%,transparent)] text-[var(--salon-primary)]"
                        : "border-white/[0.12] text-nq-foreground hover:border-white/[0.2]",
                    )}
                  >
                    {s.priceDisplay ? `${s.name} · ${s.priceDisplay}` : s.name}
                  </button>
                );
              })}
            </div>
          </div>
          );
        })() : null}

        {error ? (
          <p className="mt-6 shrink-0 text-sm text-nq-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-col gap-3 border-t border-nq-border/25 pt-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <Button
            type="button"
            variant="secondary"
            className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-white/[0.08] text-[var(--salon-primary)] shadow-none hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:min-w-[8.5rem]"
            disabled={submitting}
            onClick={onBack}
          >
            {t.back}
          </Button>
          <LuxuryBookingCta
            className="lg:min-w-[14rem]"
            disabled={submitting}
            onClick={onConfirm}
          >
            <span>{submitting ? t.submitting : t.confirmBooking}</span>
          </LuxuryBookingCta>
        </div>
        <div
          className="pb-[max(env(safe-area-inset-bottom),0px)] pt-1"
          aria-hidden="true"
        />
      </section>
    </motion.div>
  );
}
