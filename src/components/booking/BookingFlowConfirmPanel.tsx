"use client";

import { useState } from "react";
import { motion } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import {
  formatBookingPrice,
  formatBookingPriceReceipt,
} from "@/shared/booking/formatBookingPrice";
import type { Currency } from "@/shared/lib/currencyFormat";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BookingSummaryGlass } from "@/components/booking/BookingSummaryGlass";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import { cn } from "@/shared/lib/cn";

export type AppliedVoucher = {
  voucher_id: string;
  code: string;
  discount_cents: number;
  final_price_cents: number;
};

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
  currency,
  salonId,
  appliedVoucher,
  onSelectAddonId,
  onBack,
  onConfirm,
  onApplyVoucher,
  onRemoveVoucher,
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
  /** Salon UUID — needed to call /api/vouchers/validate. */
  salonId: string;
  appliedVoucher: AppliedVoucher | null;
  onApplyVoucher: (code: string, totalCents: number) => Promise<{ error?: string }>;
  onRemoveVoucher: () => void;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  /** Salon's display currency. Drives the receipt total formatting. */
  currency: Currency;
  onSelectAddonId: (id: string | null) => void;
  onBack: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [voucherInput, setVoucherInput] = useState("");
  const [voucherError, setVoucherError] = useState<string | null>(null);
  const [voucherLoading, setVoucherLoading] = useState(false);

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

  const baseTotalCents =
    (service.priceCents ?? 0) + (selectedAddOn?.priceCents ?? 0);

  const totalCents = appliedVoucher
    ? appliedVoucher.final_price_cents
    : baseTotalCents;

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
          formatBookingPrice(selectedAddOn.priceCents, currency);
        return {
          label: t.summaryAddOn,
          value: priceLabel
            ? `${selectedAddOn.name} — ${priceLabel}`
            : selectedAddOn.name,
        };
      })()
    : null;

  async function handleApply() {
    const code = voucherInput.trim().toUpperCase();
    if (!code) return;
    setVoucherError(null);
    setVoucherLoading(true);
    const result = await onApplyVoucher(code, baseTotalCents);
    setVoucherLoading(false);
    if (result.error) {
      const errors = t.voucherErrors as Record<string, string>;
      setVoucherError(errors[result.error] ?? errors.generic ?? result.error);
    } else {
      setVoucherInput("");
    }
  }

  const pricingLines = [
    {
      label: t.summaryServicePrice,
      value:
        service.priceDisplay ??
        formatBookingPrice(service.priceCents, currency) ??
        "—",
    },
    ...(addonRow ? [addonRow] : []),
    ...(appliedVoucher
      ? [
          {
            label: `${t.summaryDiscount} (${appliedVoucher.code})`,
            value: `–${formatBookingPriceReceipt(appliedVoucher.discount_cents, currency)}`,
          },
        ]
      : []),
    {
      label: t.summaryTotal,
      value: formatBookingPriceReceipt(totalCents, currency),
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
          className="text-lg font-semibold tracking-tight text-[var(--booking-text)] sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
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

        {/* Voucher code input */}
        <div className="mt-5 shrink-0">
          {appliedVoucher ? (
            <div className="flex items-center justify-between rounded-xl border border-[var(--salon-primary)]/40 bg-[color-mix(in_srgb,var(--salon-primary)_10%,transparent)] px-4 py-3">
              <p className="text-sm font-medium text-[var(--booking-text)]">
                {(t.voucherApplied as string).replace("{code}", appliedVoucher.code)}
              </p>
              <button
                type="button"
                onClick={() => { onRemoveVoucher(); setVoucherError(null); }}
                className="ml-3 shrink-0 text-xs text-[var(--booking-text-muted)] underline underline-offset-2"
              >
                {t.voucherRemove}
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                value={voucherInput}
                onChange={(e) => { setVoucherInput(e.target.value.toUpperCase()); setVoucherError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void handleApply(); } }}
                placeholder={t.voucherPlaceholder}
                maxLength={32}
                className="nq-booking-glass h-12 min-w-0 flex-1 rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-input)] px-3 text-sm text-[var(--booking-text)] placeholder:text-[var(--booking-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--salon-primary)]/40"
                aria-label={t.voucherLabel}
              />
              <button
                type="button"
                disabled={!voucherInput.trim() || voucherLoading}
                onClick={() => void handleApply()}
                className="h-12 shrink-0 rounded-xl border border-[var(--booking-border)] bg-[var(--booking-bg-input)] px-4 text-sm font-medium text-[var(--booking-text)] transition-colors hover:bg-[var(--booking-bg-input)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {voucherLoading ? "…" : t.voucherApply}
              </button>
            </div>
          )}
          {voucherError && (
            <p className="mt-1.5 text-xs text-nq-error" role="alert">{voucherError}</p>
          )}
        </div>

        {upsellCandidates.length > 0 ? (() => {
          const heading = t.upsellHeading.replace(
            "{n}",
            String(upsellGapMinutes),
          );
          return (
          <div className="mt-8" role="group" aria-label={heading}>
            <p className="text-sm font-medium text-[var(--booking-text)]">{heading}</p>
            <p className="mt-1 text-xs text-[var(--booking-text-muted)]">{t.upsellToggleHint}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onSelectAddonId(null)}
                className={cn(
                  "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                  selectedAddonId === null
                    ? "border-[var(--salon-primary)] bg-[color-mix(in_srgb,var(--salon-primary)_15%,transparent)] text-[var(--salon-primary)]"
                    : "border-[var(--booking-border)] text-[var(--booking-text-muted)] hover:border-[var(--booking-border)]",
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
                        : "border-[var(--booking-border)] text-[var(--booking-text)] hover:border-[var(--booking-border)]",
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

        <div className="mt-5 flex flex-col gap-3 border-t border-[var(--booking-border)]/25 pt-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <Button
            type="button"
            variant="secondary"
            className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none hover:bg-[var(--booking-bg-input)] disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:min-w-[8.5rem]"
            disabled={submitting}
            onClick={onBack}
          >
            {t.back}
          </Button>
          <LuxuryBookingCta
            className="lg:min-w-[14rem]"
            data-testid="confirm-booking-btn"
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
