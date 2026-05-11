"use client";

import { useEffect, useRef } from "react";
import { motion } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import { cn } from "@/shared/lib/cn";

export function BookingFlowInfoPanel({
  t,
  clientName,
  clientPhone,
  clientEmail,
  clientNotes,
  error,
  nameError,
  phoneError,
  emailError,
  stepDir,
  reducedMotion,
  stepTransition,
  onClientNameChange,
  onClientPhoneChange,
  onClientEmailChange,
  onClientNotesChange,
  onClientNameBlur,
  onClientPhoneBlur,
  onClientEmailBlur,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  clientName: string;
  clientPhone: string;
  clientEmail: string;
  clientNotes: string;
  error: string | null;
  nameError: string | null;
  phoneError: string | null;
  emailError: string | null;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onClientNameChange: (v: string) => void;
  onClientPhoneChange: (v: string) => void;
  onClientEmailChange: (v: string) => void;
  onClientNotesChange: (v: string) => void;
  onClientNameBlur: () => void;
  onClientPhoneBlur: () => void;
  onClientEmailBlur: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const nameRef = useRef<HTMLInputElement | null>(null);
  const phoneRef = useRef<HTMLInputElement | null>(null);
  const emailRef = useRef<HTMLInputElement | null>(null);
  // Auto-focus the first invalid field after Continue surfaces an error.
  useEffect(() => {
    const target = nameError
      ? nameRef.current
      : phoneError
        ? phoneRef.current
        : emailError
          ? emailRef.current
          : null;
    if (target) {
      target.focus({ preventScroll: false });
      target.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [nameError, phoneError, emailError]);
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
        className="text-lg font-semibold tracking-tight text-[var(--booking-text)] sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
      >
        {t.stepInfoHeading}
      </h2>

      <div className="mt-6 space-y-6 lg:mt-8">
        <div>
          <label
            htmlFor="booking-info-name"
            className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.clientNameLabel}
          </label>
          <input
            id="booking-info-name"
            ref={nameRef}
            type="text"
            name="clientName"
            autoComplete="name"
            value={clientName}
            inputMode="text"
            autoCorrect="off"
            maxLength={BOOKING_GUEST_NAME_MAX}
            onChange={(e) => onClientNameChange(e.target.value)}
            onBlur={() => {
              void onClientNameBlur();
            }}
            aria-invalid={Boolean(nameError)}
            className={cn(
              "nq-booking-field",
              nameError && "border-nq-error/50",
            )}
            data-testid="booking-info-name"
          />
          {nameError ? (
            <p
              className="mt-1 text-xs text-nq-error"
              data-testid="booking-info-name-error"
              role="alert"
            >
              {nameError}
            </p>
          ) : null}
        </div>
        <div>
          <label
            htmlFor="booking-info-phone"
            className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.clientPhoneLabel}
          </label>
          <input
            id="booking-info-phone"
            ref={phoneRef}
            type="tel"
            name="clientPhone"
            autoComplete="tel"
            inputMode="tel"
            value={clientPhone}
            maxLength={24}
            placeholder={t.clientPhonePlaceholder}
            onChange={(e) => onClientPhoneChange(e.target.value)}
            onBlur={() => {
              void onClientPhoneBlur();
            }}
            className={cn(
              "nq-booking-field",
              phoneError && "border-nq-error/50",
            )}
            aria-invalid={Boolean(phoneError)}
            data-testid="booking-info-phone"
          />
          {phoneError ? (
            <p
              className="mt-1 text-xs text-nq-error"
              data-testid="booking-info-phone-error"
              role="alert"
            >
              {phoneError}
            </p>
          ) : null}
        </div>
        <div>
          <label
            htmlFor="booking-info-email"
            className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.clientEmailLabel}
          </label>
          <p className="mb-2 text-xs text-[var(--booking-text-muted)]">{t.clientEmailHint}</p>
          <input
            id="booking-info-email"
            ref={emailRef}
            type="email"
            name="clientEmail"
            autoComplete="email"
            inputMode="email"
            value={clientEmail}
            maxLength={254}
            onChange={(e) => onClientEmailChange(e.target.value)}
            onBlur={() => {
              void onClientEmailBlur();
            }}
            className={cn(
              "nq-booking-field",
              emailError && "border-nq-error/50",
            )}
            aria-invalid={Boolean(emailError)}
            data-testid="booking-info-email"
          />
          {emailError ? (
            <p
              className="mt-1 text-xs text-nq-error"
              data-testid="booking-info-email-error"
              role="alert"
            >
              {emailError}
            </p>
          ) : null}
        </div>
        <div>
          <label
            htmlFor="booking-info-notes"
            className="mb-2 block text-sm font-medium text-[var(--booking-text)]"
          >
            {t.clientNotesLabel}
          </label>
          <p className="mb-2 text-xs text-[var(--booking-text-muted)]">{t.clientNotesOptionalHint}</p>
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
          className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-[var(--booking-border)] bg-transparent text-[var(--booking-text)] shadow-none hover:bg-[var(--booking-bg-input)] sm:w-auto sm:min-w-[8.5rem]"
          onClick={onBack}
        >
          {t.back}
        </Button>
        <div className="flex w-full justify-end sm:flex-1">
          <LuxuryBookingCta onClick={onNext}>{t.next}</LuxuryBookingCta>
        </div>
      </div>
    </motion.section>
  );
}
