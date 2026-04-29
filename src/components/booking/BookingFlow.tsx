"use client";

import { AnimatePresence, useReducedMotion } from "@/shared/lib/motionClient";
import { useMemo } from "react";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BOOKING_STEP_EASE } from "@/components/booking/bookingMotion";
import { BookingFlowConfirmPanel } from "@/components/booking/BookingFlowConfirmPanel";
import { BookingFlowDatePanel } from "@/components/booking/BookingFlowDatePanel";
import { BookingFlowDonePanel } from "@/components/booking/BookingFlowDonePanel";
import { BookingFlowInfoPanel } from "@/components/booking/BookingFlowInfoPanel";
import { BookingFlowServicePanel } from "@/components/booking/BookingFlowServicePanel";
import { BookingFlowStaffPanel } from "@/components/booking/BookingFlowStaffPanel";
import { BookingFlowTimePanel } from "@/components/booking/BookingFlowTimePanel";
import {
  BookingStepper,
  type BookingWizardStep,
} from "@/components/booking/BookingStepper";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import { formatGuestPriceUsdReceipt } from "@/shared/booking/formatBookingPrice";
import { useBookingFlowState } from "@/components/booking/useBookingFlowState";

type BookingFlowProps = {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  staff: readonly BookingStaffItem[];
  salon: BookingSalonMeta;
};

export function BookingFlow({
  t,
  shopSlug,
  services,
  staff,
  salon,
}: BookingFlowProps) {
  const reducedMotion = useReducedMotion();
  const flow = useBookingFlowState(t, shopSlug, services, staff, salon);

  const closedDateYmdSet = useMemo(
    () => parseBookingClosedDateSet(salon.booking_closed_dates),
    [salon.booking_closed_dates],
  );

  const scarcityHint = useMemo(() => {
    if (flow.step !== "time" || flow.slotsLoading || flow.timeSlots.length === 0) {
      return null;
    }
    const n = flow.timeSlots.length;
    if (n > 4) return null;
    return t.scarcityFewSlots.replace("{n}", String(n));
  }, [flow.step, flow.slotsLoading, flow.timeSlots.length, t.scarcityFewSlots]);

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
        staffName={flow.bookingResult.staffName}
        addonServiceName={flow.bookingResult.addonServiceName}
        displayStartUtc={flow.bookingResult.startTimeUtc}
        bookingId={flow.bookingResult.bookingId}
        salonPhone={salon.salonPhone}
        totalPaidFormatted={formatGuestPriceUsdReceipt(
          flow.bookingResult.price_cents,
        )}
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
        {flow.step === "staff" ? (
          <BookingFlowStaffPanel
            t={t}
            staff={staff}
            staffId={flow.staffId}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            onSelectStaffId={(id) => flow.setStaffId(id)}
            onNext={flow.goStaffNext}
          />
        ) : null}
        {flow.step === "date" ? (
          <BookingFlowDatePanel
            t={t}
            salonId={salon.id}
            openingHoursRaw={salon.opening_hours}
            closedDateYmdSet={closedDateYmdSet}
            staff={staff}
            staffId={flow.staffId ?? BOOKING_ANY_STAFF_ID}
            serviceTotalMinutes={flow.service?.totalMinutes ?? 0}
            selectedDate={flow.selectedDate}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            onSelectDate={(d) => flow.setSelectedDate(d)}
            onBack={flow.backToStaff}
            onNext={flow.goDateNext}
          />
        ) : null}
        {flow.step === "time" ? (
          <BookingFlowTimePanel
            t={t}
            timeSlots={flow.timeSlots}
            timeSlot={flow.timeSlot}
            slotsLoading={flow.slotsLoading}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            clientName={flow.clientName}
            clientPhone={flow.clientPhone}
            waitlistSubmitting={flow.waitlistSubmitting}
            waitlistSlotJoined={flow.waitlistSlotJoined}
            waitlistContactInvalid={flow.guestContactInvalid}
            scarcityHint={scarcityHint}
            error={flow.error}
            onClientNameChange={flow.setClientName}
            onClientPhoneChange={flow.setClientPhone}
            onWaitlistSubmit={() => void flow.submitWaitlistSlotUnavailable()}
            onSelectSlot={flow.setTimeSlot}
            onBack={flow.backToDate}
            onNext={flow.goTimeNext}
          />
        ) : null}
        {flow.step === "info" ? (
          <BookingFlowInfoPanel
            t={t}
            clientName={flow.clientName}
            clientPhone={flow.clientPhone}
            clientNotes={flow.clientNotes}
            infoNextDisabled={flow.guestContactInvalid}
            error={flow.error}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            onClientNameChange={flow.setClientName}
            onClientPhoneChange={flow.setClientPhone}
            onClientNotesChange={flow.setClientNotes}
            onBack={flow.backToTime}
            onNext={flow.goInfoNext}
          />
        ) : null}
        {flow.step === "confirm" &&
        flow.service &&
        flow.timeSlot &&
        flow.confirmTimeLabel ? (
          <BookingFlowConfirmPanel
            t={t}
            shopLabel={flow.shopLabel}
            service={flow.service}
            confirmTimeLabel={flow.confirmTimeLabel}
            staffSummaryLabel={flow.staffSummaryLabel}
            clientName={flow.clientName}
            clientPhone={flow.clientPhone}
            clientNotes={flow.clientNotes}
            upsellCandidates={flow.upsellCandidates}
            selectedAddonId={flow.selectedAddonId}
            error={flow.error}
            submitting={flow.submitting}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            onSelectAddonId={flow.setSelectedAddonId}
            onBack={flow.backToInfo}
            onConfirm={() => void flow.onConfirm()}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
