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
import { BookingFlowDepositPanel } from "@/components/booking/BookingFlowDepositPanel";
import { BookingFlowPhonePanel } from "@/components/booking/BookingFlowPhonePanel";
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
import { resolveVertical } from "@/shared/verticals/registry";
import { healthAckRequired, healthAckText } from "@/shared/lib/healthAck";
import { salonTimezoneAbbreviation } from "@/shared/lib/salonTime";
import {
  useBookingFlowState,
  type ReturningCustomer,
} from "@/components/booking/useBookingFlowState";
import type { WebVoiceBookingHandoff } from "@/shared/booking/webVoiceBookingHandoff";

type BookingFlowProps = {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  addOns: readonly BookingServiceItem[];
  combos: readonly BookingComboItem[];
  staff: readonly BookingStaffItem[];
  salon: BookingSalonMeta;
  capabilityRows: { staff_id: string; service_id: string }[] | null;
  categories: readonly ServiceCategorySummary[];
  language?: "en" | "vi";
  /** Phone-first entry — captured at the type-switcher gate. When set,
   *  the flow skips its own phone step and pre-fills name/email. */
  initialPhone?: string;
  initialReturningCustomer?: ReturningCustomer | null;
  /** Name captured at the gate (returning name or new-customer typed). */
  initialName?: string;
  /** Email from gate OTP (email channel) — pre-fills the booking email
   *  field so customers don't retype the same address for confirmation. */
  initialEmail?: string;
  /** SMS consent captured at the gate (after the phone). Pre-satisfies the
   *  confirm-step consent so it isn't asked twice. */
  initialSmsConsent?: boolean;
  /** Marketing consent opt-in captured at the gate. Saved to client_profiles
   *  after booking so Minh agents can contact the customer. */
  initialMarketingConsent?: boolean;
  /** OTP session verified at the phone gate (Option B gate-first OTP).
   *  When set, the flow skips its own OTP step — phone already verified. */
  initialOtpSessionId?: string | null;
  /** A browser Voice intent is only a prefill. BookingFlow still owns every
   * verification/consent gate and the sole explicit create CTA. */
  webVoiceHandoff?: WebVoiceBookingHandoff | null;
  onWebVoiceHandoffConsumed?: () => void;
};

export function BookingFlow({
  t,
  shopSlug,
  services,
  addOns,
  combos,
  staff,
  salon,
  capabilityRows,
  categories,
  language = "en",
  initialPhone = "",
  initialReturningCustomer = null,
  initialName = "",
  initialEmail = "",
  initialSmsConsent = false,
  initialMarketingConsent = false,
  initialOtpSessionId = null,
  webVoiceHandoff = null,
  onWebVoiceHandoffConsumed,
}: BookingFlowProps) {
  const reducedMotion = useReducedMotion();
  const vertical = resolveVertical(salon.vertical);
  const techRoleLabel = vertical.staffRoleLabel[language];
  // Mandatory health-acknowledgment text (null = not required for this salon).
  const healthAckTextStr = healthAckRequired(salon.healthAckRequired, salon.vertical)
    ? healthAckText(language, salon.name, salon.vertical)
    : null;
  const flow = useBookingFlowState(
    t,
    shopSlug,
    services,
    combos,
    staff,
    salon,
    capabilityRows,
    salon.phoneOtpEnabled,
    addOns,
    initialPhone,
    initialReturningCustomer,
    initialName,
    initialEmail,
    language,
    initialSmsConsent,
    initialMarketingConsent,
    initialOtpSessionId,
  );
  const applyWebVoiceBookingHandoff = flow.applyWebVoiceBookingHandoff;

  const [loyaltyCard, setLoyaltyCard] = useState<LoyaltyCard | null>(null);
  const [loyaltyProgram, setLoyaltyProgram] = useState<LoyaltyProgram | null>(null);

  useEffect(() => {
    if (!webVoiceHandoff) return;
    applyWebVoiceBookingHandoff(webVoiceHandoff);
    onWebVoiceHandoffConsumed?.();
  }, [applyWebVoiceBookingHandoff, onWebVoiceHandoffConsumed, webVoiceHandoff]);

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
    // Live-availability teaser (#7): count only the OPEN slots (the grid also
    // carries unavailable ones) and surface the soonest open time to create
    // urgency — "Only 3 left — soonest 3:30 PM" converts better than a bare count.
    const open = flow.timeSlots.filter((s) => s.available);
    const n = open.length;
    if (n === 0 || n > 4) return null;
    const soonest = open[0]?.label;
    if (soonest && t.scarcityFewSlotsSoonest) {
      return t.scarcityFewSlotsSoonest
        .replace("{n}", String(n))
        .replace("{time}", soonest);
    }
    return t.scarcityFewSlots.replace("{n}", String(n));
  }, [
    flow.step,
    flow.slotsLoading,
    flow.timeSlots,
    t.scarcityFewSlots,
    t.scarcityFewSlotsSoonest,
  ]);

  const stepTransition = useMemo(
    () => ({
      duration: reducedMotion ? 0 : 0.18,
      ease: BOOKING_STEP_EASE,
    }),
    [reducedMotion],
  );

  const wizardStep: BookingWizardStep =
    flow.step === "done" ? "confirm"
    : flow.step === "otp" || flow.step === "verify" || flow.step === "deposit" ? "info"
    : flow.step;

  if (flow.step === "done" && flow.bookingResult) {
    return (
      <BookingFlowDonePanel
        t={t}
        shopLabel={flow.shopLabel}
        smsConsent={flow.smsConsent}
        service={flow.service}
        staffName={flow.bookingResult.staffName}
        displayStartUtc={flow.bookingResult.startTimeUtc}
        displayEndUtc={flow.bookingResult.endTimeUtc}
        bookingId={flow.bookingResult.bookingId}
        cardManagementToken={flow.bookingResult.cardManagementToken}
        salonPhone={salon.salonPhone}
        salonTimezone={salon.timezone}
        pricing={flow.bookingResult.pricing}
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
      <BookingStepper
        activeStep={wizardStep}
        t={t}
        showStaff={salon.staffSelectionEnabled !== false}
      />
      <AnimatePresence mode="wait" custom={flow.stepDir}>
        {flow.step === "phone" ? (
          <BookingFlowPhonePanel
            t={t}
            language={language}
            clientPhone={flow.clientPhone}
            returningCustomer={flow.returningCustomer}
            lookupLoading={flow.lookupLoading}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            onClientPhoneChange={flow.setClientPhone}
            onContinue={flow.onContinueFromPhone}
            onRebook={flow.onRebook}
          />
        ) : null}
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
            language={language}
            currencyCode={salon.currencyCode}
            onSelectService={flow.setServiceId}
            onSelectCombo={flow.setSelectedCombo}
            selectedComboId={flow.selectedComboId}
            tryonDesignName={flow.tryonDesignName}
            tryonBookingQuote={flow.tryonBookingQuote}
            onBack={flow.backToPhone}
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
            techRoleLabel={techRoleLabel}
          />
        ) : null}
        {flow.step === "date" ? (
          <BookingFlowDatePanel
            t={t}
            salonId={salon.id}
            salonTimezone={salon.timezone}
            openingHoursRaw={salon.opening_hours}
            closedDateYmdSet={closedDateYmdSet}
            staff={flow.capableStaff}
            staffId={flow.staffId ?? BOOKING_ANY_STAFF_ID}
            serviceTotalMinutes={
              (flow.service?.totalMinutes ?? 0) + flow.selectedAddonsSlotMin
            }
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
            timePeriodsEnabled={salon.bookingTimePeriodsEnabled}
            timezoneAbbr={slotsTimezoneAbbr}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            clientName={flow.clientName}
            clientPhone={flow.clientPhone}
            clientEmail={flow.clientEmail}
            waitlistSubmitting={flow.waitlistSubmitting}
            waitlistSlotJoined={flow.waitlistSlotJoined}
            waitlistPreferredTime={flow.waitlistPreferredTime}
            onWaitlistPreferredTimeChange={flow.setWaitlistPreferredTime}
            waitlistTimeOptions={flow.waitlistTimeOptions}
            waitlistContactInvalid={flow.waitlistContactInvalid}
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
            notesHint={vertical.intakeHint?.[language] ?? t.clientNotesOptionalHint}
            clientName={flow.clientName}
            clientEmail={flow.clientEmail}
            clientNotes={flow.clientNotes}
            clientWebsite={flow.clientWebsite}
            salonId={salon.id}
            referenceImageEnabled={salon.referenceImageEnabled}
            referenceImagePath={flow.referenceImagePath}
            referenceImagePreview={flow.referenceImagePreview}
            error={flow.error}
            nameError={flow.infoNameError}
            emailError={flow.infoEmailError}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            onClientNameChange={flow.setClientName}
            onClientEmailChange={flow.setClientEmail}
            onClientNotesChange={flow.setClientNotes}
            onClientWebsiteChange={flow.setClientWebsite}
            onReferenceImageChange={flow.setReferenceImage}
            onClientNameBlur={flow.handleInfoNameBlur}
            onClientEmailBlur={flow.handleInfoEmailBlur}
            onBack={flow.backToTime}
            onNext={flow.goInfoNext}
            returningCustomer={flow.returningCustomer}
            lookupLoading={flow.lookupLoading}
            currentStaffId={
              flow.staffId && flow.staffId !== BOOKING_ANY_STAFF_ID
                ? flow.staffId
                : null
            }
            onAcceptPreferredStaff={flow.onAcceptPreferredStaff}
            onDismissPreferredStaff={flow.onDismissPreferredStaff}
            preferredStaffDismissed={flow.preferredStaffDismissed}
          />
        ) : null}
        {flow.step === "verify" ? (
          <BookingFlowVerifyPanel
            t={t}
            salonId={salon.id}
            clientPhone={flow.clientPhone}
            clientEmail={flow.clientEmail}
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
            clientEmail={flow.clientEmail}
            emailChannelEnabled={salon.emailLinksEnabled !== false}
            salonPhone={salon.salonPhone}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            isOptional={flow.verificationAction === "otp_optional"}
            onVerified={flow.goOtpNext}
            onSkip={flow.verificationAction === "otp_optional" ? flow.goSkipOtp : undefined}
            onBack={flow.backFromOtpToInfo}
          />
        ) : null}
        {flow.step === "deposit" && flow.pricingQuote ? (
          <BookingFlowDepositPanel
            salonId={salon.id}
            pricingQuote={flow.pricingQuote}
            bookingRequestId={flow.bookingRequestId}
            clientPhone={flow.clientPhone}
            clientEmail={flow.clientEmail.trim() || null}
            otpSessionId={flow.otpSessionId}
            onPaid={flow.goDepositPaid}
            onSkip={flow.goDepositSkip}
            onBack={flow.backFromOtpToInfo}
          />
        ) : flow.step === "deposit" ? (
          <p className="py-8 text-center text-sm text-[var(--booking-text-muted)]">
            Preparing secure deposit…
          </p>
        ) : null}
        {flow.step === "confirm" &&
        flow.service &&
        flow.timeSlot &&
        flow.confirmTimeLabel ? (
          <BookingFlowConfirmPanel
            t={t}
            shopLabel={flow.shopLabel}
            shopSlug={shopSlug}
            healthAckText={healthAckTextStr}
            service={flow.service}
            confirmTimeLabel={
              slotsTimezoneAbbr
                ? `${flow.confirmTimeLabel} ${slotsTimezoneAbbr}`
                : flow.confirmTimeLabel
            }
            staffSummaryLabel={flow.staffSummaryLabel}
            clientName={flow.clientName}
            clientPhone={flow.clientPhone}
            clientEmail={flow.clientEmail}
            clientNotes={flow.clientNotes}
            upsellCandidates={flow.upsellCandidates}
            upsellGapMinutes={flow.upsellGapMinutes}
            selectedAddonIds={flow.selectedAddonIds}
            selectedAddonsTotalMin={flow.selectedAddonsTotalMin}
            error={flow.error}
            submitting={flow.submitting}
            stepDir={flow.stepDir}
            reducedMotion={Boolean(reducedMotion)}
            stepTransition={stepTransition}
            currency={salon.currencyCode}
            pricingQuote={flow.pricingQuote}
            pricingQuoteLoading={flow.pricingQuoteLoading}
            pricingQuoteError={flow.pricingQuoteError}
            pricingReconfirmRequired={flow.pricingReconfirmRequired}
            appliedVoucher={flow.appliedVoucher}
            onToggleAddon={flow.toggleAddon}
            onAddonRepickTime={flow.addAddonAndRepickTime}
            onClearAddons={() => flow.setSelectedAddonIds([])}
            onBack={flow.backToInfo}
            onConfirm={(extra) => void flow.onConfirm(extra)}
            cardRequirement={flow.cardRequirement}
            cardRequirementLoading={flow.cardRequirementLoading}
            savedCard={flow.savedCard}
            smsConsent={flow.smsConsent}
            setSmsConsent={flow.setSmsConsent}
            onApplyVoucher={flow.handleApplyVoucher}
            onRemoveVoucher={flow.handleRemoveVoucher}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
}
