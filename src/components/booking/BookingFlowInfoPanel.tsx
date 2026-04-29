"use client";

import { motion } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";

export function BookingFlowInfoPanel({
  t,
  clientName,
  clientPhone,
  clientNotes,
  infoNextDisabled,
  error,
  stepDir,
  reducedMotion,
  stepTransition,
  onClientNameChange,
  onClientPhoneChange,
  onClientNotesChange,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  clientName: string;
  clientPhone: string;
  clientNotes: string;
  infoNextDisabled: boolean;
  error: string | null;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onClientNameChange: (v: string) => void;
  onClientPhoneChange: (v: string) => void;
  onClientNotesChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const phoneBad =
    clientPhone.trim().length > 0 && !validateGuestPhone(clientPhone).ok;

  return (
    <motion.section
      key="info"
      role="group"
      aria-labelledby="info-heading"
      custom={stepDir}
      variants={bookingStepVariants}
      initial={reducedMotion ? false : "initial"}
      animate="animate"
      exit="exit"
      transition={stepTransition}
      className="will-change-transform"
    >
      <h2
        id="info-heading"
        className="text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
      >
        {t.stepInfoHeading}
      </h2>

      <div className="mt-6 space-y-6 lg:mt-8">
        <div>
          <label
            htmlFor="booking-info-name"
            className="mb-2 block text-sm font-medium text-nq-foreground"
          >
            {t.clientNameLabel}
          </label>
          <input
            id="booking-info-name"
            type="text"
            name="clientName"
            autoComplete="name"
            value={clientName}
            inputMode="text"
            autoCorrect="off"
            maxLength={120}
            onChange={(e) => onClientNameChange(e.target.value)}
            className="nq-booking-field"
          />
        </div>
        <div>
          <label
            htmlFor="booking-info-phone"
            className="mb-2 block text-sm font-medium text-nq-foreground"
          >
            {t.clientPhoneLabel}
          </label>
          <input
            id="booking-info-phone"
            type="tel"
            name="clientPhone"
            autoComplete="tel"
            inputMode="tel"
            value={clientPhone}
            maxLength={24}
            onChange={(e) => onClientPhoneChange(e.target.value)}
            className={cn(
              "nq-booking-field",
              phoneBad && "border-nq-error/50",
            )}
            aria-invalid={phoneBad}
          />
        </div>
        <div>
          <label
            htmlFor="booking-info-notes"
            className="mb-2 block text-sm font-medium text-nq-foreground"
          >
            {t.clientNotesLabel}
          </label>
          <p className="mb-2 text-xs text-nq-muted">{t.clientNotesOptionalHint}</p>
          <textarea
            id="booking-info-notes"
            name="clientNotes"
            rows={3}
            maxLength={2000}
            value={clientNotes}
            onChange={(e) => onClientNotesChange(e.target.value)}
            className="nq-booking-field min-h-[5.5rem] resize-y py-3"
          />
        </div>
        {error ? (
          <p className="text-sm text-nq-error" role="alert">
            {error}
          </p>
        ) : null}
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
          <LuxuryBookingCta disabled={infoNextDisabled} onClick={onNext}>
            {t.next}
          </LuxuryBookingCta>
        </div>
      </div>
    </motion.section>
  );
}
