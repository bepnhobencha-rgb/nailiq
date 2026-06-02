"use client";

import { motion, AnimatePresence } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { cn } from "@/shared/lib/cn";
import type { ReturningCustomer } from "@/components/booking/useBookingFlowState";

// ReturningCustomer now includes lastBooking directly. This alias keeps
// the public API stable for any callers already using the extended type.
export type ReturningCustomerWithLastBooking = ReturningCustomer;

// Localized day names used for the rebook card.
const DAY_NAMES_VI = [
  "Chủ nhật",
  "Thứ hai",
  "Thứ ba",
  "Thứ tư",
  "Thứ năm",
  "Thứ sáu",
  "Thứ bảy",
];
const DAY_NAMES_EN = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function getDayName(dayOfWeek: number, lang: string): string {
  return lang === "vi"
    ? (DAY_NAMES_VI[dayOfWeek] ?? "")
    : (DAY_NAMES_EN[dayOfWeek] ?? "");
}

export function BookingFlowPhonePanel({
  t,
  language,
  clientPhone,
  returningCustomer,
  lookupLoading,
  stepDir,
  reducedMotion,
  stepTransition,
  onClientPhoneChange,
  onContinue,
  onRebook,
}: {
  t: BookingMessages;
  /** Locale string — "vi" or "en". Used to localise day names in the rebook card. */
  language: string;
  clientPhone: string;
  /** Set when a returning customer is identified via phone lookup. */
  returningCustomer: ReturningCustomerWithLastBooking | null;
  /** True while the phone lookup API call is in-flight. */
  lookupLoading: boolean;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onClientPhoneChange: (v: string) => void;
  /** Normal flow — advance to the service selection step. */
  onContinue: () => void;
  /** Fast rebook — pre-fill everything from last booking and jump to time step. */
  onRebook: (
    lastBooking: NonNullable<ReturningCustomerWithLastBooking["lastBooking"]>,
  ) => void;
}) {
  const phoneTrimmed = clientPhone.trim();
  const phoneLocallyInvalid =
    phoneTrimmed.length > 0 && !validateGuestPhone(phoneTrimmed).ok;
  const continueDisabled = phoneTrimmed.length === 0 || phoneLocallyInvalid;

  const hasRebook =
    returningCustomer !== null && returningCustomer.lastBooking !== null;

  return (
    <motion.section
      key="phone"
      role="group"
      aria-labelledby="phone-step-heading"
      custom={stepDir}
      variants={bookingStepVariants}
      initial={reducedMotion ? false : "initial"}
      animate="animate"
      exit="exit"
      transition={stepTransition}
      className="will-change-transform"
    >
      {/* ── Heading ── */}
      <h2
        id="phone-step-heading"
        className="text-2xl font-semibold text-[var(--booking-text)]"
      >
        {t.phoneStepHeading}
      </h2>
      {returningCustomer === null && (
        <p className="mt-1 text-sm text-[var(--booking-text-muted)]">
          {t.phoneStepSubheading}
        </p>
      )}

      <div className="mt-6 space-y-5 lg:mt-8">
        {/* ── Phone input ── */}
        <div>
          <label
            htmlFor="booking-phone-step-phone"
            className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.clientPhoneLabel}
          </label>
          <div className="relative">
            <input
              id="booking-phone-step-phone"
              type="tel"
              name="clientPhone"
              autoComplete="tel"
              inputMode="tel"
              value={clientPhone}
              maxLength={24}
              placeholder={t.clientPhonePlaceholder}
              autoFocus
              onChange={(e) => onClientPhoneChange(e.target.value)}
              className={cn(
                "nq-booking-field",
                returningCustomer !== null &&
                  "border-nq-primary/40 pr-8 text-[var(--booking-text)]",
              )}
              aria-invalid={phoneLocallyInvalid}
              data-testid="booking-phone-step-phone"
            />
            {/* Tick icon when a returning customer is recognised */}
            {returningCustomer !== null && (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-nq-primary">
                ✓
              </span>
            )}
          </div>

          {/* Lookup-in-flight dots — visible only while loading and no result yet */}
          {lookupLoading && returningCustomer === null && (
            <p
              className="mt-1.5 flex gap-1 text-xs text-[var(--booking-text-muted)]"
              aria-live="polite"
              data-testid="phone-step-lookup-loading"
            >
              <span className="animate-pulse">●</span>
              <span className="animate-pulse [animation-delay:150ms]">●</span>
              <span className="animate-pulse [animation-delay:300ms]">●</span>
            </p>
          )}
        </div>

        {/* ── Returning-customer welcome card — fades in when recognised ── */}
        <AnimatePresence>
          {returningCustomer !== null && (
            <motion.div
              key="phone-step-returning-card"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="rounded-2xl border border-nq-primary/25 bg-nq-primary/5 p-4"
              data-testid="phone-step-returning-card"
            >
              {/* Header: avatar + name + VIP badge */}
              <div className="flex items-start gap-3">
                {/* First-letter avatar */}
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-nq-primary/20 text-base font-semibold text-nq-primary">
                  {returningCustomer.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--booking-text)]">
                      {returningCustomer.name}
                    </span>
                    {returningCustomer.isVip && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-nq-warning/30 bg-nq-warning/15 px-2 py-0.5 text-[11px] font-semibold text-nq-warning">
                        ✨ {t.returningCustomer.vipBadge}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--booking-text-muted)]">
                    {t.returningCustomer.visitCount.replace(
                      "{n}",
                      String(returningCustomer.visitCount),
                    )}
                  </p>
                </div>
              </div>

              {/* ── Rebook section — only when lastBooking is present ── */}
              {returningCustomer.lastBooking !== null && (
                <div className="mt-4">
                  {/* Section divider label */}
                  <p className="mb-3 text-center text-xs text-[var(--booking-text-muted)]">
                    ── {t.rebookHeading} ──
                  </p>

                  {/* Last-booking summary lines */}
                  <div className="mb-3 space-y-1 text-sm text-[var(--booking-text)]">
                    <p>
                      💅{" "}
                      {returningCustomer.lastBooking.serviceName}
                      {" · "}
                      {returningCustomer.lastBooking.staffName
                        ? t.rebookWith.replace(
                            "{name}",
                            returningCustomer.lastBooking.staffName,
                          )
                        : t.rebookAnyStaff}
                    </p>
                    <p>
                      ⏰{" "}
                      {getDayName(
                        returningCustomer.lastBooking.dayOfWeek,
                        language,
                      )}{" "}
                      · {returningCustomer.lastBooking.timeLabel}
                    </p>
                  </div>

                  {/* Action buttons */}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() =>
                        // lastBooking is confirmed non-null inside this block
                        onRebook(returningCustomer.lastBooking!)
                      }
                      data-testid="phone-step-rebook-now"
                    >
                      {t.rebookNow}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={onContinue}
                      data-testid="phone-step-rebook-change"
                    >
                      {t.rebookChange}
                    </Button>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── New-customer hint — visible only when no returning customer found ── */}
        {returningCustomer === null && (
          <p className="text-xs text-[var(--booking-text-muted)]">
            {t.phoneStepNewCustomerHint}
          </p>
        )}
      </div>

      {/* ── Footer CTA ── */}
      <div className="mt-10 lg:mt-12">
        {/* When returning customer with rebook: show a softer "or continue" label above the CTA */}
        {hasRebook && (
          <p className="mb-4 text-center text-xs text-[var(--booking-text-muted)]">
            ← {t.phoneStepSubheading} →
          </p>
        )}
        {/* When returning customer exists but no lastBooking, just show the normal CTA */}
        {/* When no returning customer, show normal CTA */}
        {/* The CTA always calls onContinue (normal flow). Rebook is handled by the card buttons above. */}
        <div className="flex w-full justify-end">
          <LuxuryBookingCta
            onClick={onContinue}
            disabled={continueDisabled}
            data-testid="phone-step-continue"
          >
            {t.next}
          </LuxuryBookingCta>
        </div>
      </div>
    </motion.section>
  );
}
