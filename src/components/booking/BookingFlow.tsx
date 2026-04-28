"use client";

import { AnimatePresence, useReducedMotion } from "@/shared/lib/motionClient";
import { useMemo } from "react";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BOOKING_STEP_EASE } from "@/components/booking/bookingMotion";
import { BookingFlowConfirmPanel } from "@/components/booking/BookingFlowConfirmPanel";
import { BookingFlowDonePanel } from "@/components/booking/BookingFlowDonePanel";
import { BookingFlowServicePanel } from "@/components/booking/BookingFlowServicePanel";
import { BookingFlowTimePanel } from "@/components/booking/BookingFlowTimePanel";
import { BookingStepper, type BookingWizardStep } from "@/components/booking/BookingStepper";
import { useBookingFlowState } from "@/components/booking/useBookingFlowState";

type BookingFlowProps = {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  timeSlots: readonly string[];
};

export function BookingFlow({
  t,
  shopSlug,
  services,
  timeSlots,
}: BookingFlowProps) {
  const reducedMotion = useReducedMotion();
  const flow = useBookingFlowState(t, shopSlug, services);

  const stepTransition = useMemo(
    () => ({
      duration: reducedMotion ? 0 : 0.18,
      ease: BOOKING_STEP_EASE,
    }),
    [reducedMotion],
  );

  const wizardStep: BookingWizardStep =
    flow.step === "done" ? "confirm" : flow.step;

  if (flow.step === "done" && flow.bookingResult) {
    return (
      <BookingFlowDonePanel
        t={t}
        shopLabel={flow.shopLabel}
        service={flow.service}
        timeSlot={flow.timeSlot}
        bookingId={flow.bookingResult.bookingId}
        onAddToCalendar={flow.handleAddToCalendar}
        onBookAnother={flow.resetAfterDone}
      />
    );
  }

  return (
    <div className="mt-8 w-full">
      <BookingStepper activeStep={wizardStep} t={t} />
      <AnimatePresence mode="wait" custom={flow.stepDir}>
        {flow.step === "service" ? (
          <BookingFlowServicePanel
            t={t}
            services={services}
            serviceId={flow.serviceId}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            onSelectService={flow.setServiceId}
            onNext={flow.goServiceNext}
          />
        ) : null}
        {flow.step === "time" ? (
          <BookingFlowTimePanel
            t={t}
            timeSlots={timeSlots}
            timeSlot={flow.timeSlot}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            onSelectSlot={flow.setTimeSlot}
            onBack={flow.backToService}
            onNext={flow.goTimeNext}
          />
        ) : null}
        {flow.step === "confirm" && flow.service && flow.timeSlot ? (
          <BookingFlowConfirmPanel
            t={t}
            shopLabel={flow.shopLabel}
            service={flow.service}
            timeSlot={flow.timeSlot}
            clientName={flow.clientName}
            clientPhone={flow.clientPhone}
            error={flow.error}
            submitting={flow.submitting}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            confirmInputsInvalid={flow.confirmInputsInvalid}
            onClientNameChange={flow.setClientName}
            onClientPhoneChange={flow.setClientPhone}
            onBack={flow.backToTime}
            onConfirm={() => void flow.onConfirm()}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
