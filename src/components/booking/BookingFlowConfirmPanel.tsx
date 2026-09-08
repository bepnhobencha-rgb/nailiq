"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "@/shared/lib/motionClient";
import {
  ConfirmStepCardCapture,
  type ConfirmStepCardHandle,
} from "@/components/booking/ConfirmStepCardCapture";
import type { NoShowCardRequirement } from "@/shared/noshow/resolveNoShowCardRequirement";
import type { SavedNoShowCard } from "@/shared/noshow/resolveSavedNoShowCard";
import { Button } from "@/components/ui/Button";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import {
  formatBookingPrice,
  formatBookingPriceReceipt,
} from "@/shared/booking/formatBookingPrice";
import type { Currency } from "@/shared/lib/currencyFormat";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import type { PublicBookingPricingQuote } from "@/shared/booking/publicBookingPricing";
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
  shopSlug,
  healthAckText,
  service,
  confirmTimeLabel,
  staffSummaryLabel,
  clientName,
  clientPhone,
  clientEmail,
  clientNotes,
  upsellCandidates,
  upsellGapMinutes,
  selectedAddonIds,
  selectedAddonsTotalMin,
  error,
  submitting,
  stepDir,
  reducedMotion,
  stepTransition,
  currency,
  pricingQuote,
  pricingQuoteLoading,
  pricingQuoteError,
  pricingReconfirmRequired,
  appliedVoucher,
  onToggleAddon,
  onAddonRepickTime,
  onClearAddons,
  onBack,
  onConfirm,
  onApplyVoucher,
  onRemoveVoucher,
  cardRequirement,
  cardRequirementLoading,
  savedCard,
  smsConsent,
  setSmsConsent,
  smsConsentRequired = true,
}: {
  t: BookingMessages;
  shopLabel: string;
  shopSlug: string;
  /** When set, a mandatory health-acknowledgment tick is shown and gates confirm. */
  healthAckText?: string | null;
  service: BookingServiceItem;
  confirmTimeLabel: string;
  staffSummaryLabel: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  clientNotes: string;
  upsellCandidates: readonly BookingServiceItem[];
  upsellGapMinutes: number;
  selectedAddonIds: readonly string[];
  selectedAddonsTotalMin: number;
  error: string | null;
  submitting: boolean;
  stepDir: BookingMotionDir;
  /** The only monetary source rendered on Confirm. */
  pricingQuote: PublicBookingPricingQuote | null;
  pricingQuoteLoading: boolean;
  pricingQuoteError: string | null;
  pricingReconfirmRequired: boolean;
  appliedVoucher: AppliedVoucher | null;
  onApplyVoucher: (code: string, totalCents: number) => Promise<{ error?: string }>;
  onRemoveVoucher: () => void;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  /** Salon's display currency. Drives the receipt total formatting. */
  currency: Currency;
  onToggleAddon: (id: string) => void;
  /** Hybrid: select a too-long add-on and jump back to re-pick a fitting time. */
  onAddonRepickTime: (id: string) => void;
  onClearAddons: () => void;
  onBack: () => void;
  onConfirm: (
    extra?: { noShowCardSourceId?: string; noShowCardVerificationToken?: string; noShowConsent?: boolean; noShowReuseSavedCard?: boolean; healthAck?: boolean },
  ) => void | Promise<void>;
  /** Option A no-show card gate, resolved BEFORE booking. When required, the card
   *  is captured here and must be entered before the booking can be confirmed. */
  cardRequirement?: NoShowCardRequirement | null;
  /** True while resolveNoShowCardRequirement is in-flight. Disables the confirm
   *  button to prevent racing past the card check before it resolves. */
  cardRequirementLoading?: boolean;
  /** Đợt 2 — returning OTP-verified customer's saved card (one-tap reuse). */
  savedCard?: SavedNoShowCard | null;
  /** SMS consent (collected at the phone gate). Confirm hides its own checkbox
   *  when already given; still gates the button on it as a safety net. */
  smsConsent: boolean;
  setSmsConsent: (v: boolean) => void;
  smsConsentRequired?: boolean;
}) {
  const [voucherInput, setVoucherInput] = useState("");
  const [voucherError, setVoucherError] = useState<string | null>(null);
  const [voucherLoading, setVoucherLoading] = useState(false);
  // SMS consent (CASL/TCPA) now comes from the phone gate via props; the local
  // checkbox below is only a fallback shown when it wasn't given there.
  // Option A no-show card gate.
  const cardRequired = cardRequirement?.required === true;
  const hasSavedCard = savedCard?.hasSavedCard === true;
  const [noShowConsent, setNoShowConsent] = useState(false);
  // Mandatory health-acknowledgment (massage/head spa/facial/waxing). Gates confirm.
  const healthAckOn = Boolean(healthAckText);
  const [healthAck, setHealthAck] = useState(false);
  // When a saved card exists, default to reusing it; the customer can switch to
  // entering a new one.
  const [useDifferentCard, setUseDifferentCard] = useState(false);
  const reuseSaved = cardRequired && hasSavedCard && !useDifferentCard;
  const cardRef = useRef<ConfirmStepCardHandle>(null);

  async function handleConfirm() {
    const ack = healthAckOn ? healthAck : undefined;
    if (cardRequired) {
      cardRef.current?.clearError();
      // One-tap reuse of the saved card — no new tokenization.
      if (reuseSaved) {
        await onConfirm({ noShowReuseSavedCard: true, noShowConsent: true, healthAck: ack });
        return;
      }
      const result = await cardRef.current?.tokenize();
      if (!result) {
        return;
      }
      await onConfirm({
        noShowCardSourceId: result.token,
        noShowCardVerificationToken: result.verificationToken,
        noShowConsent: true,
        healthAck: ack,
      });
      return;
    }
    await onConfirm({ healthAck: ack });
  }

  const customerRows = [
    { label: t.summaryClientName, value: clientName.trim() || "—" },
    { label: t.summaryClientPhone, value: clientPhone.trim() || "—" },
    ...(clientNotes.trim().length > 0
      ? [{ label: t.summaryClientNotes, value: clientNotes.trim() }]
      : []),
  ];

  // Selected add-ons, in candidate order, filtered to those still offered.
  const selectedAddOns = upsellCandidates.filter((s) =>
    selectedAddonIds.includes(s.id),
  );

  const baseTotalCents = pricingQuote?.preVoucherSubtotalCents ?? 0;

  // Auto-apply a voucher code carried on the landing URL (/<slug>?code=CODE),
  // e.g. from a re-opt-in email. Fires once, only when a code is present and the
  // customer hasn't already applied one; a mismatch (wrong phone, expired) is
  // silent — they can still book at full price.
  const autoVoucherTried = useRef(false);
  useEffect(() => {
    if (autoVoucherTried.current || appliedVoucher || baseTotalCents <= 0) return;
    const code =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase()
        : null;
    if (!code) return;
    autoVoucherTried.current = true;
    let cancelled = false;
    void (async () => {
      setVoucherInput(code);
      setVoucherLoading(true);
      const res = await onApplyVoucher(code, baseTotalCents);
      if (cancelled) return;
      setVoucherLoading(false);
      if (res.error) setVoucherError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [appliedVoucher, baseTotalCents, onApplyVoucher]);

  // Display the actual service time only (no inter-service rest buffer). The
  // buffer still drives scheduling via `selectedAddonsTotalMin`/totalMinutes,
  // but it's not part of what the customer "spends".
  const displayDurationMin =
    (service.durationMinutes || 0) +
    selectedAddOns.reduce(
      (sum, a) => sum + (a.addonConcurrent ? 0 : a.durationMinutes),
      0,
    );
  const durationLabel =
    displayDurationMin > 0
      ? selectedAddOns.length > 0
        ? `${t.summaryDurationMinutes.replace("{n}", String(displayDurationMin))} (${t.summaryDurationIncludesAddon})`
        : t.summaryDurationMinutes.replace("{n}", String(displayDurationMin))
      : null;

  // One pricing line per selected add-on.
  const addonRows = pricingQuote?.addonLines.map((a) => {
    const priceLabel = formatBookingPrice(a.priceCents, pricingQuote.currency);
    return {
      label: t.summaryAddOn,
      value: priceLabel ? `${a.name} — ${priceLabel}` : a.name,
    };
  }) ?? [];

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
      value: pricingQuote
        ? formatBookingPriceReceipt(
            pricingQuote.serviceOriginalCents,
            pricingQuote.currency,
          )
        : "…",
    },
    ...addonRows,
    ...(pricingQuote?.discountLines.map((line) => ({
      label: line.kind === "voucher" ? t.summaryDiscount : line.label,
      value: `–${formatBookingPriceReceipt(line.amountCents, pricingQuote.currency)}`,
    })) ?? []),
    ...((pricingQuote?.discountLines.length ?? 0) > 0 || (pricingQuote?.taxCents ?? 0) > 0
      ? [
          {
            label: t.summarySubtotal ?? "Subtotal",
            value: pricingQuote
              ? formatBookingPriceReceipt(pricingQuote.subtotalCents, pricingQuote.currency)
              : "…",
          },
          ...(pricingQuote?.taxBreakdown.map((b) => ({
            label: `${b.name} (${(b.rate * 100).toFixed(b.rate * 100 === Math.round(b.rate * 100) ? 0 : 3).replace(/\.?0+$/, "")}%)`,
            value: `+${formatBookingPriceReceipt(b.amountCents, pricingQuote.currency)}`,
          })) ?? []),
        ]
      : []),
    {
      label: t.summaryTotal,
      value: pricingQuote
        ? formatBookingPriceReceipt(pricingQuote.totalCents, pricingQuote.currency)
        : "…",
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
                onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter") { e.preventDefault(); void handleApply(); } }}
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
                onClick={() => onClearAddons()}
                className={cn(
                  "rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                  selectedAddonIds.length === 0
                    ? "border-[var(--salon-primary)] bg-[color-mix(in_srgb,var(--salon-primary)_15%,transparent)] text-[var(--salon-primary)]"
                    : "border-[var(--booking-border)] text-[var(--booking-text-muted)] hover:border-[var(--booking-border)]",
                )}
              >
                {t.upsellNoThanks}
              </button>
              {upsellCandidates.map((s) => {
                const on = selectedAddonIds.includes(s.id);
                // Concurrent add-ons cost no time (run during the service);
                // only sequential ones eat into the free gap. The fit check
                // uses the scheduled time (incl. buffer); the label shows the
                // actual service minutes only.
                const addedSchedule = s.addonConcurrent ? 0 : s.totalMinutes;
                const addedDisplay = s.addonConcurrent ? 0 : s.durationMinutes;
                const fits =
                  on ||
                  selectedAddonsTotalMin + addedSchedule <= upsellGapMinutes;
                const mins = s.addonConcurrent
                  ? " · ✨ +0′"
                  : addedDisplay > 0
                    ? ` · +${addedDisplay}′`
                    : "";
                // Hybrid: an add-on that doesn't fit the current slot's gap is
                // no longer dead-ended. Tapping it keeps the add-on and sends
                // the customer back to pick a time that fits the whole package.
                const needsMoreTime = !fits && !on;
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      needsMoreTime
                        ? onAddonRepickTime(s.id)
                        : onToggleAddon(s.id)
                    }
                    className={cn(
                      "rounded-full border px-4 py-2 text-left text-sm font-medium transition-colors",
                      on
                        ? "border-[var(--salon-primary)] bg-[color-mix(in_srgb,var(--salon-primary)_15%,transparent)] text-[var(--salon-primary)]"
                        : needsMoreTime
                          ? "border-dashed border-[var(--salon-primary)]/50 text-[var(--booking-text-muted)] hover:border-[var(--salon-primary)]"
                          : "border-[var(--booking-border)] text-[var(--booking-text)] hover:border-[var(--booking-border)]",
                    )}
                  >
                    {on ? "✓ " : ""}
                    {`${s.name}${mins}`}
                    {needsMoreTime
                      ? ` · 🕙 ${t.upsellAddonNeedsTime ?? "pick a longer time →"}`
                      : ""}
                  </button>
                );
              })}
            </div>
            {selectedAddOns.length > 0 ? (
              <p className="mt-3 text-xs font-medium text-[var(--salon-primary)]">
                {selectedAddOns.length} add-on
                {selectedAddOns.length > 1 ? "s" : ""} · +{selectedAddonsTotalMin}′
                {" · "}
                {pricingQuote
                  ? formatBookingPriceReceipt(pricingQuote.addonPreVoucherCents, pricingQuote.currency)
                  : "…"}
                {"  ·  "}
                <span className="text-[var(--booking-text-muted)]">
                  {Math.max(0, upsellGapMinutes - selectedAddonsTotalMin)}′ left
                </span>
              </p>
            ) : null}
          </div>
          );
        })() : null}

        {pricingQuoteLoading ? (
          <p className="mt-6 shrink-0 text-sm text-[var(--booking-text-muted)]" role="status">
            {t.pricingVerifying}
          </p>
        ) : null}
        {pricingQuoteError ? (
          <p className="mt-6 shrink-0 text-sm text-nq-error" role="alert">
            {t.pricingUnavailable}
          </p>
        ) : null}
        {pricingReconfirmRequired ? (
          <p className="mt-6 shrink-0 text-sm text-nq-error" role="alert">
            {t.pricingChanged}
          </p>
        ) : null}
        {error && error !== "pricing_changed" ? (
          <p className="mt-6 shrink-0 text-sm text-nq-error" role="alert">
            {error}
          </p>
        ) : null}

        {/* SMS consent is collected at the phone gate; show this only as a
            fallback if it wasn't given there. */}
        {smsConsentRequired && !smsConsent ? (
          <label className="mt-5 flex cursor-pointer items-start gap-2.5 border-t border-[var(--booking-border)]/25 pt-5 text-xs leading-relaxed text-[var(--booking-text-muted)]">
            <input
              type="checkbox"
              data-testid="sms-consent"
              checked={smsConsent}
              onChange={(e) => setSmsConsent(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--salon-primary)]"
            />
            <span>{t.smsConsent.replace("{salon}", shopLabel)}</span>
          </label>
        ) : null}

        {cardRequired && cardRequirement?.required ? (
          <>
            {reuseSaved && savedCard?.hasSavedCard ? (
              <div
                className="mt-4 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-card)] p-4"
                data-testid="saved-card-reuse"
              >
                <p className="text-sm font-semibold text-[var(--booking-text)]">
                  {t.noShowCardTitle ?? "Secure your appointment"}
                </p>
                <div className="mt-3 flex items-center gap-3 rounded-lg border border-[var(--booking-border)] bg-[var(--booking-bg-input)] px-3 py-3">
                  <span aria-hidden className="text-base">💳</span>
                  <span className="text-sm font-medium text-[var(--booking-text)]">
                    {savedCard.brand || "Card"} •••• {savedCard.last4}
                  </span>
                  <span className="ml-auto rounded-full bg-[var(--salon-primary)]/15 px-2 py-0.5 text-[11px] font-semibold text-[var(--salon-primary)]">
                    {t.noShowSavedCardOnFile ?? "On file"}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-[var(--booking-text-muted)]">
                  {(t.noShowSavedCardDesc ??
                    "We'll use your saved card. You're only charged {fee} if you don't show up — nothing now.").replace(
                    "{fee}",
                    formatBookingPrice(cardRequirement.feeCents, currency) ?? "",
                  )}
                </p>
                <button
                  type="button"
                  data-testid="use-different-card"
                  onClick={() => setUseDifferentCard(true)}
                  className="mt-2 text-xs font-semibold text-[var(--salon-primary)] underline"
                >
                  {t.noShowUseDifferentCard ?? "Use a different card"}
                </button>
              </div>
            ) : (
              <>
                <ConfirmStepCardCapture
                  ref={cardRef}
                  applicationId={cardRequirement.applicationId}
                  locationId={cardRequirement.locationId}
                  environment={cardRequirement.environment}
                  feeLabel={formatBookingPrice(cardRequirement.feeCents, currency) ?? ""}
                  customerName={clientName}
                  customerPhone={clientPhone}
                  customerEmail={clientEmail}
                  t={t}
                />
                {hasSavedCard ? (
                  <button
                    type="button"
                    data-testid="use-saved-card"
                    onClick={() => setUseDifferentCard(false)}
                    className="mt-2 text-xs font-semibold text-[var(--salon-primary)] underline"
                  >
                    {t.noShowUseSavedCard ?? "Use my saved card instead"}
                  </button>
                ) : null}
              </>
            )}
            <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-[var(--booking-text-muted)]">
              <input
                type="checkbox"
                data-testid="confirm-noshow-consent"
                checked={noShowConsent}
                onChange={(e) => setNoShowConsent(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--salon-primary)]"
              />
              <span>
                {(t.noShowConsent ??
                  "I agree to the no-show policy and authorize this salon to charge {fee} to this card only if I don't show up.").replace(
                  "{fee}",
                  formatBookingPrice(cardRequirement.feeCents, currency) ?? "",
                )}
              </span>
            </label>
          </>
        ) : null}

        {healthAckOn ? (
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-[var(--booking-text-muted)]">
            <input
              type="checkbox"
              data-testid="confirm-health-ack"
              checked={healthAck}
              onChange={(e) => setHealthAck(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--salon-primary)]"
            />
            <span>{healthAckText}</span>
          </label>
        ) : null}

        <div className="mt-4 flex flex-col gap-3 pt-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
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
            disabled={submitting || pricingQuoteLoading || !pricingQuote || Boolean(pricingQuoteError) || cardRequirementLoading || (smsConsentRequired && !smsConsent) || (cardRequired && !noShowConsent) || (healthAckOn && !healthAck)}
            onClick={handleConfirm}
          >
            <span>{submitting ? t.submitting : pricingReconfirmRequired ? t.confirmUpdatedPrice : t.confirmBooking}</span>
          </LuxuryBookingCta>
        </div>
        {/* Passive agreement to the customer Booking Terms + the salon's
            Cancellation Policy (links). Confirming the booking = agreement. */}
        <p className="mt-3 text-center text-[11px] leading-relaxed text-[var(--booking-text-muted)]" data-testid="confirm-terms-notice">
          {t.confirmTermsAgree ?? "By confirming, you agree to the"}{" "}
          <a href={`/${shopSlug}/booking-terms`} target="_blank" rel="noreferrer" className="underline">
            {t.confirmTermsLink ?? "Booking Terms & Cancellation Policy"}
          </a>
          .
        </p>
        <div
          className="pb-[max(env(safe-area-inset-bottom),0px)] pt-1"
          aria-hidden="true"
        />
      </section>
    </motion.div>
  );
}
