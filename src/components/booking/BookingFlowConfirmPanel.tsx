"use client";

import { motion } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BookingSummaryGlass } from "@/components/booking/BookingSummaryGlass";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";

export function BookingFlowConfirmPanel({
  t,
  shopLabel,
  service,
  timeSlot,
  clientName,
  clientPhone,
  error,
  submitting,
  stepDir,
  reducedMotion,
  stepTransition,
  confirmInputsInvalid,
  onClientNameChange,
  onClientPhoneChange,
  onBack,
  onConfirm,
}: {
  t: BookingMessages;
  shopLabel: string;
  service: BookingServiceItem;
  timeSlot: string;
  clientName: string;
  clientPhone: string;
  error: string | null;
  submitting: boolean;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  confirmInputsInvalid: boolean;
  onClientNameChange: (v: string) => void;
  onClientPhoneChange: (v: string) => void;
  onBack: () => void;
  onConfirm: () => void | Promise<void>;
}) {
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
            timeLabel={timeSlot}
          />
        </div>

        <div className="mt-8 space-y-6">
          <div>
            <label
              htmlFor="booking-client-name"
              className="mb-2 block text-sm font-medium text-nq-foreground"
            >
              {t.clientNameLabel}
            </label>
            <input
              id="booking-client-name"
              type="text"
              name="clientName"
              autoComplete="name"
              value={clientName}
              inputMode="text"
              autoCorrect="off"
              onChange={(e) => onClientNameChange(e.target.value)}
              className="nq-booking-field"
            />
          </div>
          <div>
            <label
              htmlFor="booking-client-phone"
              className="mb-2 block text-sm font-medium text-nq-foreground"
            >
              {t.clientPhoneLabel}
            </label>
            <input
              id="booking-client-phone"
              type="tel"
              name="clientPhone"
              autoComplete="tel"
              inputMode="tel"
              value={clientPhone}
              onChange={(e) => onClientPhoneChange(e.target.value)}
              className="nq-booking-field"
            />
          </div>
        </div>
        {error ? (
          <p className="mt-4 shrink-0 text-sm text-nq-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex flex-col gap-3 border-t border-nq-border/25 pt-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <Button
            type="button"
            variant="secondary"
            className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-white/[0.08] text-nq-primary shadow-none hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto sm:min-w-[8.5rem]"
            disabled={submitting}
            onClick={onBack}
          >
            {t.back}
          </Button>
          <LuxuryBookingCta
            className="lg:min-w-[14rem]"
            disabled={submitting || confirmInputsInvalid}
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
