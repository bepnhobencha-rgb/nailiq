"use client";

import { motion } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import type { TimeSlot } from "@/shared/booking/getAvailableTimeSlots";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";

export function BookingFlowTimePanel({
  t,
  timeSlots,
  timeSlot,
  slotsLoading,
  popularSlotLabels = [],
  timezoneAbbr,
  stepDir,
  reducedMotion,
  stepTransition,
  clientName,
  clientPhone,
  clientEmail,
  waitlistSubmitting,
  waitlistSlotJoined,
  waitlistPreferredTime,
  onWaitlistPreferredTimeChange,
  waitlistTimeOptions,
  waitlistContactInvalid,
  scarcityHint,
  error,
  onClientNameChange,
  onClientPhoneChange,
  onClientEmailChange,
  onWaitlistSubmit,
  onSelectSlot,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  timeSlots: readonly TimeSlot[];
  timeSlot: string | null;
  slotsLoading: boolean;
  popularSlotLabels?: string[];
  /** Short tz token, e.g. "PDT" or "GMT+7". Empty string hides the label. */
  timezoneAbbr: string;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  waitlistSubmitting: boolean;
  waitlistSlotJoined: boolean;
  waitlistPreferredTime: string;
  onWaitlistPreferredTimeChange: (v: string) => void;
  waitlistTimeOptions: string[];
  waitlistContactInvalid: boolean;
  scarcityHint: string | null;
  error: string | null;
  onClientNameChange: (v: string) => void;
  onClientPhoneChange: (v: string) => void;
  onClientEmailChange: (v: string) => void;
  onWaitlistSubmit: () => void;
  onSelectSlot: (slot: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <motion.section
      key="time"
      role="group"
      aria-labelledby="time-heading"
      custom={stepDir}
      variants={bookingStepVariants}
      initial={reducedMotion ? false : "initial"}
      animate="animate"
      exit="exit"
      transition={stepTransition}
      className="will-change-transform"
    >
      <h2
        id="time-heading"
        className="text-lg font-semibold tracking-tight text-[var(--booking-text)] sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
      >
        {t.stepTimeHeading}
      </h2>

      {timezoneAbbr ? (
        <p
          className="mt-2 text-sm text-[var(--booking-text-muted)] lg:text-[15px]"
          data-testid="slots-timezone-label"
        >
          {t.slotsTimezoneLabel.replace("{tz}", timezoneAbbr)}
        </p>
      ) : null}

      {scarcityHint ? (
        <p className="mt-3 text-sm font-medium text-[color-mix(in_srgb,var(--salon-primary)_95%,transparent)] lg:mt-4 lg:text-[15px]">
          {scarcityHint}
        </p>
      ) : null}

      <div className="mt-6 min-h-[8rem] lg:mt-8">
        {slotsLoading ? (
          <div
            className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-3 lg:gap-5"
            aria-busy="true"
            aria-live="polite"
            aria-label={t.slotLoading}
            data-testid="time-slots-skeleton"
          >
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="nq-booking-glass min-h-11 rounded-2xl border border-[var(--booking-border)] bg-[var(--booking-bg-input)] motion-safe:animate-pulse motion-reduce:opacity-60 sm:min-h-[3rem]"
                aria-hidden
              />
            ))}
          </div>
        ) : timeSlots.length === 0 ? (
          <div className="space-y-6 py-2">
            <p className="text-center text-sm text-[var(--booking-text-muted)]">{t.noSlotsAvailable}</p>
            {waitlistSlotJoined ? (
              <p className="rounded-2xl border border-nq-success/35 bg-nq-success/12 px-4 py-3 text-center text-sm font-medium text-nq-success">
                {t.waitlistJoined}
              </p>
            ) : (
              <>
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="booking-waitlist-name"
                      className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
                    >
                      {t.clientNameLabel}
                    </label>
                    <input
                      id="booking-waitlist-name"
                      type="text"
                      name="waitlistClientName"
                      autoComplete="name"
                      value={clientName}
                      inputMode="text"
                      autoCorrect="off"
                      maxLength={BOOKING_GUEST_NAME_MAX}
                      onChange={(e) => onClientNameChange(e.target.value)}
                      className="nq-booking-field"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="booking-waitlist-phone"
                      className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
                    >
                      {t.clientPhoneLabel}
                    </label>
                    <input
                      id="booking-waitlist-phone"
                      type="tel"
                      name="waitlistClientPhone"
                      autoComplete="tel"
                      inputMode="tel"
                      value={clientPhone}
                      onChange={(e) => onClientPhoneChange(e.target.value)}
                      className="nq-booking-field"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="booking-waitlist-email"
                      className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
                    >
                      {t.clientEmailLabel}
                    </label>
                    <input
                      id="booking-waitlist-email"
                      type="email"
                      name="waitlistClientEmail"
                      autoComplete="email"
                      inputMode="email"
                      value={clientEmail}
                      onChange={(e) => onClientEmailChange(e.target.value)}
                      className="nq-booking-field"
                      placeholder={t.clientEmailHint ?? ""}
                    />
                  </div>
                  {waitlistTimeOptions.length > 0 ? (
                    <div>
                      <label
                        htmlFor="booking-waitlist-time"
                        className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
                      >
                        {t.waitlistPreferredTimeLabel}
                      </label>
                      <select
                        id="booking-waitlist-time"
                        name="waitlistPreferredTime"
                        value={waitlistPreferredTime}
                        onChange={(e) =>
                          onWaitlistPreferredTimeChange(e.target.value)
                        }
                        className="nq-booking-field"
                      >
                        <option value="">{t.waitlistAnyTime}</option>
                        {waitlistTimeOptions.map((label) => (
                          <option key={label} value={label}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </div>
                {error ? (
                  <p className="text-sm text-nq-error" role="alert">
                    {error}
                  </p>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  className="nq-booking-glass h-12 min-h-11 w-full border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none hover:bg-[var(--booking-bg-input)] disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={
                    waitlistSubmitting ||
                    waitlistContactInvalid
                  }
                  onClick={onWaitlistSubmit}
                >
                  {waitlistSubmitting ? t.waitlistSubmitting : t.waitlistNotifyCta}
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-3 lg:gap-5">
            {timeSlots.map((slot) => {
              const selected = timeSlot === slot.label;
              const disabled = !slot.available;
              const popular = !disabled && popularSlotLabels.includes(slot.label);
              return (
                <button
                  key={slot.label}
                  type="button"
                  data-testid="time-slot"
                  data-available={slot.available}
                  aria-pressed={selected}
                  aria-disabled={disabled}
                  aria-label={
                    disabled
                      ? `${slot.label} (not available)`
                      : slot.scoringLabel === "best_fit"
                        ? `${slot.label} (${t.slotBestFit})`
                        : slot.scoringLabel === "recommended"
                          ? `${slot.label} (${t.slotRecommended})`
                          : popular
                            ? `${slot.label} (popular)`
                            : slot.label
                  }
                  disabled={disabled}
                  onClick={() => {
                    if (!disabled) onSelectSlot(slot.label);
                  }}
                  className={cn(
                    "nq-booking-glass relative min-h-11 rounded-2xl px-3 py-3 text-center text-sm font-medium tracking-tight transition-transform duration-75 motion-safe:active:scale-[0.99] sm:min-h-[3rem] sm:text-[15px]",
                    !selected && !disabled && "nq-booking-tile-interactive",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--booking-bg)]",
                    selected
                      ? "border border-[var(--salon-primary)] text-[var(--booking-text)] shadow-[var(--shadow-nq-tile-selected)]"
                      : disabled
                        ? "cursor-not-allowed border border-[var(--booking-border)] text-[var(--booking-text-muted)]/50 line-through opacity-50"
                        : "border border-[var(--booking-border)] text-[var(--booking-text)] hover:border-[var(--booking-border)]",
                  )}
                >
                  {/* Phase 5 — Smart Gap-Free Scheduling labels.
                      Priority: scoringLabel > popular (both are "good slot" signals). */}
                  {slot.scoringLabel === "best_fit" && !selected && (
                    <span
                      data-testid="slot-label-best-fit"
                      className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-[var(--salon-primary)] px-1.5 py-px text-[10px] font-semibold leading-tight text-[var(--booking-bg)] whitespace-nowrap"
                    >
                      ⭐ {t.slotBestFit}
                    </span>
                  )}
                  {slot.scoringLabel === "recommended" && !selected && (
                    <span
                      data-testid="slot-label-recommended"
                      className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full border border-[var(--salon-primary)]/40 bg-[var(--salon-primary)]/10 px-1.5 py-px text-[10px] font-semibold leading-tight text-[var(--salon-primary)] whitespace-nowrap"
                    >
                      {t.slotRecommended}
                    </span>
                  )}
                  {!slot.scoringLabel && popular && !selected && (
                    <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-[var(--salon-primary)] px-1.5 py-px text-[10px] font-semibold leading-tight text-[var(--booking-bg)] whitespace-nowrap">
                      {t.popularBadge}
                    </span>
                  )}
                  {slot.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:gap-4 lg:mt-12 lg:items-center lg:justify-between">
        <Button
          type="button"
          variant="secondary"
          className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text-muted)] shadow-none hover:bg-[var(--booking-bg-input)] sm:w-auto sm:min-w-[8.5rem]"
          onClick={onBack}
        >
          {t.back}
        </Button>
        <div className="flex w-full justify-end sm:flex-1">
          <LuxuryBookingCta disabled={slotsLoading || !timeSlot} onClick={onNext}>
            {t.next}
          </LuxuryBookingCta>
        </div>
      </div>
    </motion.section>
  );
}
