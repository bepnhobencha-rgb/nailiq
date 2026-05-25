"use client";

import { AnimatePresence, useReducedMotion } from "@/shared/lib/motionClient";
import { useMemo, useState, useEffect } from "react";
import { getClientLoyaltyCardByPhone } from "@/shared/loyalty/loyaltyActions";
import type { LoyaltyCard, LoyaltyProgram } from "@/shared/loyalty/types";
import type { BookingComboItem, BookingServiceItem } from "@/shared/booking/catalog";
import type { ServiceCategorySummary } from "@/shared/booking/loadServiceCategories";
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
import { BookingFlowOtpPanel } from "@/components/booking/BookingFlowOtpPanel";
import { BookingFlowServicePanel } from "@/components/booking/BookingFlowServicePanel";
import { BookingFlowStaffPanel } from "@/components/booking/BookingFlowStaffPanel";
import { BookingFlowTimePanel } from "@/components/booking/BookingFlowTimePanel";
import { BookingFlowVerifyPanel } from "@/components/booking/BookingFlowVerifyPanel";
import {
  BookingStepper,
  type BookingWizardStep,
} from "@/components/booking/BookingStepper";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import { formatBookingPriceReceipt } from "@/shared/booking/formatBookingPrice";
import { salonTimezoneAbbreviation } from "@/shared/lib/salonTime";
import { useBookingFlowState } from "@/components/booking/useBookingFlowState";

type BookingFlowProps = {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  combos: readonly BookingComboItem[];
  staff: readonly BookingStaffItem[];
  salon: BookingSalonMeta;
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  categories: readonly ServiceCategorySummary[];
};

export function BookingFlow({
  t,
  shopSlug,
  services,
  combos,
  staff,
  salon,
  capabilityRows,
  categories,
}: BookingFlowProps) {
  const reducedMotion = useReducedMotion();
  const flow = useBookingFlowState(
    t,
    shopSlug,
    services,
    combos,
    staff,
    salon,
    capabilityRows,
    salon.phoneOtpEnabled,
  );

  const [loyaltyCard, setLoyaltyCard] = useState<LoyaltyCard | null>(null);
  const [loyaltyProgram, setLoyaltyProgram] = useState<LoyaltyProgram | null>(null);

  useEffect(() => {
    if (flow.step !== "done" || !flow.clientPhone.trim()) return;
    void getClientLoyaltyCardByPhone(salon.id, flow.clientPhone.trim()).then(
      ({ card, program }) => {
        setLoyaltyCard(card);
        setLoyaltyProgram(program);
      },
    );
  }, [flow.step, flow.clientPhone, salon.id]);

  const closedDateYmdSet = useMemo(
    () => parseBookingClosedDateSet(salon.booking_closed_dates),
    [salon.booking_closed_dates],
  );

  // Slot-grid label uses "now" as the DST anchor — fine for a list of
  // upcoming slots that won't cross a DST boundary mid-render. The
  // confirmation panel re-anchors against the booking's actual start.
  const slotsTimezoneAbbr = useMemo(
    () => salonTimezoneAbbreviation(salon.timezone),
    [salon.timezone],
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
    flow.step === "done" ? "confirm"
    : flow.step === "otp" || flow.step === "verify" ? "info"
    : flow.step;

  if (flow.step === "done" && flow.bookingResult) {
    return (
      <BookingFlowDonePanel
        t={t}
        shopLabel={flow.shopLabel}
        service={flow.service}
        staffName={flow.bookingResult.staffName}
        addonServiceName={flow.bookingResult.addonServiceName}
        addonPriceCents={flow.bookingResult.addonPriceCents}
        displayStartUtc={flow.bookingResult.startTimeUtc}
        displayEndUtc={flow.bookingResult.endTimeUtc}
        bookingId={flow.bookingResult.bookingId}
        salonPhone={salon.salonPhone}
        salonTimezone={salon.timezone}
        totalPaidFormatted={formatBookingPriceReceipt(
          flow.bookingResult.price_cents,
          salon.currencyCode,
        )}
        currency={salon.currencyCode}
        onAddToCalendar={flow.handleAddToCalendar}
        onBookAnother={flow.resetAfterDone}
        loyaltyCard={loyaltyCard}
        loyaltyProgram={loyaltyProgram}
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
            combos={combos}
            serviceId={flow.serviceId}
            error={flow.serviceError}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            categories={categories}
            onSelectService={flow.setServiceId}
            onSelectCombo={flow.setSelectedCombo}
            selectedComboId={flow.selectedComboId}
            onNext={flow.goServiceNext}
          />
        ) : null}
        {flow.step === "staff" ? (
          <BookingFlowStaffPanel
            t={t}
            staff={flow.capableStaff}
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
            staff={flow.capableStaff}
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
            popularSlotLabels={flow.popularSlotLabels}
            timezoneAbbr={slotsTimezoneAbbr}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            clientName={flow.clientName}
            clientPhone={flow.clientPhone}
            clientEmail={flow.clientEmail}
            waitlistSubmitting={flow.waitlistSubmitting}
            waitlistSlotJoined={flow.waitlistSlotJoined}
            waitlistContactInvalid={flow.guestContactInvalid}
            scarcityHint={scarcityHint}
            error={flow.error}
            onClientNameChange={flow.setClientName}
            onClientPhoneChange={flow.setClientPhone}
            onClientEmailChange={flow.setClientEmail}
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
            clientEmail={flow.clientEmail}
            clientNotes={flow.clientNotes}
            clientWebsite={flow.clientWebsite}
            salonId={salon.id}
            referenceImagePath={flow.referenceImagePath}
            referenceImagePreview={flow.referenceImagePreview}
            error={flow.error}
            nameError={flow.infoNameError}
            phoneError={flow.infoPhoneError}
            emailError={flow.infoEmailError}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            onClientNameChange={flow.setClientName}
            onClientPhoneChange={flow.setClientPhone}
            onClientEmailChange={flow.setClientEmail}
            onClientNotesChange={flow.setClientNotes}
            onClientWebsiteChange={flow.setClientWebsite}
            onReferenceImageChange={flow.setReferenceImage}
            onClientNameBlur={flow.handleInfoNameBlur}
            onClientPhoneBlur={flow.handleInfoPhoneBlur}
            onClientEmailBlur={flow.handleInfoEmailBlur}
            onBack={flow.backToTime}
            onNext={flow.goInfoNext}
          />
        ) : null}
        {flow.step === "verify" ? (
          <BookingFlowVerifyPanel
            t={t}
            salonId={salon.id}
            clientPhone={flow.clientPhone}
            serviceIds={flow.service ? [flow.service.id] : []}
            subtotalCents={flow.service?.priceCents ?? 0}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            onDecided={flow.goVerifyDecided}
          />
        ) : null}
        {flow.step === "otp" ? (
          <BookingFlowOtpPanel
            t={t}
            shopSlug={shopSlug}
            clientPhone={flow.clientPhone}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            isOptional={flow.verificationAction === "otp_optional"}
            onVerified={flow.goOtpNext}
            onSkip={flow.verificationAction === "otp_optional" ? flow.goSkipOtp : undefined}
            onBack={flow.backFromOtpToInfo}
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
            confirmTimeLabel={
              slotsTimezoneAbbr
                ? `${flow.confirmTimeLabel} ${slotsTimezoneAbbr}`
                : flow.confirmTimeLabel
            }
            staffSummaryLabel={flow.staffSummaryLabel}
            clientName={flow.clientName}
            clientPhone={flow.clientPhone}
            clientNotes={flow.clientNotes}
            upsellCandidates={flow.upsellCandidates}
            upsellGapMinutes={flow.upsellGapMinutes}
            selectedAddonId={flow.selectedAddonId}
            error={flow.error}
            submitting={flow.submitting}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            currency={salon.currencyCode}
            salonId={salon.id}
            appliedVoucher={flow.appliedVoucher}
            onSelectAddonId={flow.setSelectedAddonId}
            onBack={flow.backToInfo}
            onConfirm={() => void flow.onConfirm()}
            onApplyVoucher={flow.handleApplyVoucher}
            onRemoveVoucher={flow.handleRemoveVoucher}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
