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
  timezoneAbbr,
  stepDir,
  reducedMotion,
  stepTransition,
  clientName,
  clientPhone,
  waitlistSubmitting,
  waitlistSlotJoined,
  waitlistContactInvalid,
  scarcityHint,
  error,
  onClientNameChange,
  onClientPhoneChange,
  onWaitlistSubmit,
  onSelectSlot,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  timeSlots: readonly TimeSlot[];
  timeSlot: string | null;
  slotsLoading: boolean;
  /** Short tz token, e.g. "PDT" or "GMT+7". Empty string hides the label. */
  timezoneAbbr: string;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  clientName: string;
  clientPhone: string;
  waitlistSubmitting: boolean;
  waitlistSlotJoined: boolean;
  waitlistContactInvalid: boolean;
  scarcityHint: string | null;
  error: string | null;
  onClientNameChange: (v: string) => void;
  onClientPhoneChange: (v: string) => void;
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
        className="text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
      >
        {t.stepTimeHeading}
      </h2>

      {timezoneAbbr ? (
        <p
          className="mt-2 text-sm text-nq-muted lg:text-[15px]"
          data-testid="slots-timezone-label"
        >
          {t.slotsTimezoneLabel.replace("{tz}", timezoneAbbr)}
        </p>
      ) : null}

      {scarcityHint ? (
        <p className="mt-3 text-sm font-medium text-nq-primary/95 lg:mt-4 lg:text-[15px]">
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
                className="nq-booking-glass min-h-11 rounded-2xl border border-white/[0.06] bg-white/[0.03] motion-safe:animate-pulse motion-reduce:opacity-60 sm:min-h-[3rem]"
                aria-hidden
              />
            ))}
          </div>
        ) : timeSlots.length === 0 ? (
          <div className="space-y-6 py-2">
            <p className="text-center text-sm text-nq-muted">{t.noSlotsAvailable}</p>
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
                      className="mb-2 block text-sm font-medium text-nq-foreground"
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
                      className="mb-2 block text-sm font-medium text-nq-foreground"
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
                </div>
                {error ? (
                  <p className="text-sm text-nq-error" role="alert">
                    {error}
                  </p>
                ) : null}
                <Button
                  type="button"
                  variant="secondary"
                  className="nq-booking-glass h-12 min-h-11 w-full border border-white/[0.08] text-nq-primary shadow-none hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
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
              return (
                <motion.button
                  key={slot.label}
                  type="button"
                  data-testid="time-slot"
                  data-available={slot.available}
                  whileTap={disabled ? undefined : { scale: 0.99 }}
                  transition={{
                    type: "spring",
                    stiffness: 420,
                    damping: 28,
                  }}
                  aria-pressed={selected}
                  aria-disabled={disabled}
                  aria-label={
                    disabled ? `${slot.label} (not available)` : slot.label
                  }
                  disabled={disabled}
                  onClick={() => {
                    if (!disabled) onSelectSlot(slot.label);
                  }}
                  className={cn(
                    "nq-booking-glass min-h-11 rounded-2xl px-3 py-3 text-center text-sm font-medium tracking-tight sm:min-h-[3rem] sm:text-[15px]",
                    !selected && !disabled && "nq-booking-tile-interactive",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
                    selected
                      ? "border border-[#D4AF37] text-nq-foreground shadow-[var(--shadow-nq-tile-selected)]"
                      : disabled
                        ? "cursor-not-allowed border border-white/[0.04] text-nq-muted/50 line-through opacity-50"
                        : "border border-white/[0.06] text-nq-foreground hover:border-white/[0.12]",
                  )}
                >
                  {slot.label}
                </motion.button>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:gap-4 lg:mt-12 lg:items-center lg:justify-between">
        <Button
          type="button"
          variant="secondary"
          className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-white/[0.08] text-nq-primary shadow-none hover:bg-white/[0.04] sm:w-auto sm:min-w-[8.5rem]"
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
