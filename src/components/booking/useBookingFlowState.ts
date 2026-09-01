"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getServiceById,
  type BookingComboItem,
  type BookingServiceItem,
} from "@/shared/booking/catalog";
import {
  BookingConflictError,
  BookingPricingChangedError,
  quotePublicBooking,
  submitPublicBooking,
  type BookingParams,
} from "@/shared/booking/submitPublicBooking";
import {
  buildPublicBookingPricingQuoteKey,
  type PublicBookingPricingQuote,
} from "@/shared/booking/publicBookingPricing";
import {
  createPublicWaitlistRequestId,
  submitPublicWaitlistEntry,
} from "@/shared/booking/submitPublicWaitlist";
import {
  resolveNoShowCardRequirement,
  type NoShowCardRequirement,
} from "@/shared/noshow/resolveNoShowCardRequirement";
import {
  resolveSavedNoShowCard,
  type SavedNoShowCard,
} from "@/shared/noshow/resolveSavedNoShowCard";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import {
  bookingDateYmdFromLocalDate,
  formatBookingSlotDisplay,
} from "@/shared/booking/bookingConfirmLabels";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import {
  getAvailableTimeSlots,
  minutesToLabel,
  type TimeSlot,
} from "@/shared/booking/getAvailableTimeSlots";
import { computeBookingTiming } from "@/shared/booking/bookingTiming";
import type {
  BookingSalonMeta,
  BookingResourceItem,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import { formatNailiqBookingRef } from "@/shared/lib/formatNailiqBookingRef";
import { formatPhoneInputProgressive } from "@/shared/lib/phoneFormat";
import { generateBookingCalendarIcs } from "@/components/booking/bookingCalendar";
import { formatSalonDisplayName } from "@/shared/lib/salonDisplay";
import { fireBookingConfetti } from "@/components/booking/bookingConfetti";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { parseTimeSlotToMinutes } from "@/shared/booking/parseBookingTimeSlot";
import { fetchBookingOccupancyForRange } from "@/shared/booking/fetchBookingOccupancy";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { pickBestStaffAmongFree } from "@/shared/booking/pickBestStaffAmongFree";
import { computeStaffFloatGapMinutes } from "@/shared/booking/computeStaffFloatGapMinutes";
import {
  buildCapabilityMap,
  filterStaffCapableForService,
} from "@/shared/booking/staffCapability";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { getPublicStaffDisplayName } from "@/shared/booking/publicStaffDisplay";
import {
  resolveNailTryOnBookingRecommendation,
  type NailTryOnBookingIntent,
  type NailTryOnBookingQuote,
} from "@/shared/nailTryOn/bookingRecommendation";

import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import * as ErrorReporter from "@/shared/observability/errorReporter";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";
import type { WebVoiceBookingHandoff } from "@/shared/booking/webVoiceBookingHandoff";
import type { PaidPublicDeposit } from "@/shared/payments/publicDepositTypes";
import {
  salonDayRangeUtc,
  salonWallTimeToUtcIso,
} from "@/shared/lib/salonTime";
import { salonTodayCalendarDate } from "@/shared/booking/salonCalendarDate";
import {
  acknowledgePublicBookingRequestId,
  stablePublicBookingRequestId,
  type PublicBookingRequestMaterial,
} from "@/shared/booking/publicBookingRequestId";
import { createPublicClient } from "@/shared/lib/supabase/publicClient";
import { v1AllowsNoShowCardOnFile } from "@/shared/release/v1IntegrationScope";

const CUSTOMER_PAYMENT_GATEWAY_ENABLED = v1AllowsNoShowCardOnFile();

export type ReturningCustomer = {
  found: true;
  isVip: boolean;
  // ── PII (identity + history) ────────────────────────────────────────────
  // Populated ONLY after the customer proves phone ownership (OTP). The public
  // pre-auth lookup at /api/customer/[phone] returns just { found, isVip } —
  // otherwise anyone could type a phone and read the owner's real name, visit
  // count and usual technician (PII enumeration, QA S1). Kept optional so a
  // post-verification fetch can light these up later without re-touching every
  // consumer.
  name?: string;
  email?: string | null;
  visitCount?: number;
  preferredStaffId?: string | null;
  preferredStaffName?: string | null;
  lastBooking?: {
    serviceId: string;
    serviceName: string;
    staffId: string | null;
    staffName: string | null;
    dayOfWeek: number;
    timeLabel: string;
    lastVisitDate: string;
  } | null;
};

export type BookingFlowStep =
  | "phone"
  | "service"
  | "staff"
  | "date"
  | "time"
  | "info"
  | "verify"
  | "otp"
  | "deposit"
  | "confirm"
  | "done";

export type VerificationAction =
  | "none"
  | "otp_optional"
  | "otp_required"
  | "deposit_required"
  | "deposit_or_otp";

function normalizeNoon(d: Date): Date {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  return x;
}

function normalizeVoiceSlotLabel(value: string): string {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(value.trim());
  if (!match) return value.trim();
  return `${Number(match[1])}:${match[2] ?? "00"} ${match[3]!.toUpperCase()}`;
}

function localNoonFromYmd(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return date.getFullYear() === Number(match[1]) &&
    date.getMonth() === Number(match[2]) - 1 &&
    date.getDate() === Number(match[3])
    ? date
    : null;
}

export function useBookingFlowState(
  t: BookingMessages,
  shopSlug: string,
  services: readonly BookingServiceItem[],
  combos: readonly BookingComboItem[],
  staff: readonly BookingStaffItem[],
  salon: BookingSalonMeta,
  capabilityRows: { staff_id: string; service_id: string }[] | null,
  phoneOtpEnabled: boolean,
  addOns: readonly BookingServiceItem[] = [],
  /** Phone-first entry: when the customer entered their phone at the
   *  type-switcher gate, the individual flow starts at "service"
   *  (skipping its own phone step) with these pre-filled. Empty = the
   *  legacy phone-first-step behaviour is unchanged. */
  initialPhone: string = "",
  initialReturningCustomer: ReturningCustomer | null = null,
  /** Name captured at the gate — returning customer's name, or the
   *  name a new customer typed there. Pre-fills the info step. */
  initialName: string = "",
  /** Email from gate OTP (email channel) or returning-customer profile.
   *  Pre-fills the booking email field so new customers who used their
   *  email to receive the OTP code don't have to type it again. */
  initialEmail: string = "",
  /** Booking surface language — forwarded to the booking so the
   *  confirmation SMS is sent in the language the customer chose. */
  language: "en" | "vi" = "vi",
  /** SMS consent captured at the phone gate — pre-satisfies confirm. */
  initialSmsConsent: boolean = false,
  /** Marketing consent opt-in from the gate checkbox. Saved to client_profiles
   *  after booking so Minh agents can contact the customer. */
  initialMarketingConsent: boolean = false,
  /** OTP session verified at the phone gate (Option B). When set, the flow
   *  skips its own OTP step — the gate already verified the phone. */
  initialOtpSessionId: string | null = null,
  /** Active physical resources. Optional at the tail for legacy callers. */
  resources: readonly BookingResourceItem[] = [],
) {
  const capability = useMemo(
    () => buildCapabilityMap(capabilityRows),
    [capabilityRows],
  );
  const shopLabel = useMemo(
    () => formatSalonDisplayName({ name: salon.name, slug: shopSlug }),
    [salon.name, shopSlug],
  );

  const closedDateYmdSet = useMemo(
    () => parseBookingClosedDateSet(salon.booking_closed_dates),
    [salon.booking_closed_dates],
  );

  /**
   * Phase 5 — Smart Gap-Free Scheduling.
   * Shortest bookable service duration across all salon services.
   * Used to detect dead gaps in slot scoring.
   */
  const shortestServiceMinutes = useMemo(() => {
    const durations = services
      .map((s) => s.totalMinutes)
      .filter((d) => d > 0);
    return durations.length > 0 ? Math.min(...durations) : 0;
  }, [services]);

  // Phone-first: skip the phone step when the gate already captured it.
  // The phone step still exists in the machine, so "back" from service
  // shows the (pre-filled) phone — no navigation refactor needed.
  const [step, setStep] = useState<BookingFlowStep>(
    initialPhone.trim() ? "service" : "phone",
  );
  const [stepDir, setStepDir] = useState<1 | -1>(1);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date>(() =>
    normalizeNoon(salonTodayCalendarDate(salon.timezone)),
  );
  const [timeSlot, setTimeSlot] = useState<string | null>(null);
  const timeSlotRef = useRef<string | null>(null);
  const [timeSlots, setTimeSlots] = useState<TimeSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [availabilityRevision, setAvailabilityRevision] = useState(0);
  const [availabilityRealtimeStatus, setAvailabilityRealtimeStatus] = useState<
    "idle" | "connecting" | "subscribed" | "degraded"
  >("idle");
  const pendingWebVoiceTimeSlotRef = useRef<string | null>(null);
  const [popularSlotLabels, setPopularSlotLabels] = useState<string[]>([]);
  const [selectedCombo, setSelectedComboState] = useState<BookingComboItem | null>(null);
  const [tryonDesignName, setTryonDesignName] = useState<string | null>(null);
  const [tryonBookingQuote, setTryonBookingQuote] = useState<NailTryOnBookingQuote | null>(null);
  const [tryonRecommendation, setTryonRecommendation] = useState<{
    serviceId: string | null;
    addonServiceId: string | null;
  } | null>(null);
  const tryonIntentLoadedRef = useRef(false);

  const [clientName, setClientName] = useState(
    initialName.trim() || (initialReturningCustomer?.name ?? ""),
  );
  const [clientPhone, setClientPhone] = useState(initialPhone ?? "");
  /** B-10: optional. Pre-filled from returning-customer profile OR the email
   *  the customer used to receive the gate OTP code (so they don't retype it). */
  const [clientEmail, setClientEmail] = useState(
    initialReturningCustomer?.email ?? initialEmail ?? "",
  );
  const [clientNotes, setClientNotes] = useState("");
  /** Waitlist "Preferred time" — optional. Empty string = "any time" → the
   *  submit sends preferredSlotLabel: null (unchanged legacy behavior). */
  const [waitlistPreferredTime, setWaitlistPreferredTime] = useState<string>("");
  /** Task #09-11 — honeypot field, never shown to humans (CSS-hidden +
   *  `tabIndex=-1` + `aria-hidden`). Bots autofilling every `<input>`
   *  in the form will put something here; `submitPublicBooking`
   *  silently returns a fake success when that happens so no row is
   *  written and the bot doesn't learn it was caught. */
  const [clientWebsite, setClientWebsite] = useState("");
  // Multiple add-ons can be booked into one appointment, gated by free-gap time.
  const [selectedAddonIds, setSelectedAddonIds] = useState<string[]>([]);
  // Hybrid re-pick: an add-on the customer WANTS but that didn't fit the
  // previous slot. Tracked separately from `selectedAddonIds` (which the
  // time/slot reset effect wipes) so it survives a re-pick; it drives slot
  // sizing and is auto-applied once a fitting slot is chosen.
  const [pendingAddonId, setPendingAddonId] = useState<string | null>(null);
  const [upsellCandidates, setUpsellCandidates] = useState<
    BookingServiceItem[]
  >([]);
  /** Staff free-gap minutes after the main service; surfaced in the upsell heading copy. */
  const [upsellGapMinutes, setUpsellGapMinutes] = useState<number>(0);
  const [serviceError, setServiceError] = useState<string | null>(null);

  useEffect(() => {
    if (tryonIntentLoadedRef.current) return;
    const sessionId = new URLSearchParams(window.location.search).get("tryon");
    if (!sessionId) return;
    const controller = new AbortController();
    void fetch(
      `/api/nail-tryon/booking-intent?sessionId=${encodeURIComponent(sessionId)}`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<NailTryOnBookingIntent>;
      })
      .then((intent) => {
        if (!intent) return;
        tryonIntentLoadedRef.current = true;
        const recommendation = resolveNailTryOnBookingRecommendation(
          intent,
          services,
          addOns,
        );
        const recommendedService = recommendation.service;
        const recommendedAddon = recommendation.addOn;

        if (recommendedService) {
          setServiceId(recommendedService.id);
          setSelectedComboState(null);
          setServiceError(null);
        }
        setTryonRecommendation({
          serviceId: recommendedService?.id ?? null,
          addonServiceId: recommendedAddon?.id ?? null,
        });
        if (recommendation.designName && (recommendedService || recommendedAddon)) {
          setTryonDesignName(recommendation.designName);
        }
        setTryonBookingQuote(recommendation.quote);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("[booking] nail try-on recommendation failed", error);
        }
      });

    return () => controller.abort();
  }, [services, addOns]);

  // When Option B gate-OTP is used, pre-seed the session so the flow's own
  // OTP step is skipped (line ~1118: `otpSessionId && otpVerifiedPhone === clientPhone`).
  const [otpSessionId, setOtpSessionId] = useState<string | null>(initialOtpSessionId);
  // The phone a live OTP session was verified for. Lets us SKIP re-showing the
  // OTP step (and re-sending an SMS) when the customer revisits verify/back from
  // confirm with the same phone already verified. Phone is captured at the gate
  // and immutable downstream, so a session stays valid for the whole flow.
  const [otpVerifiedPhone, setOtpVerifiedPhone] = useState<string | null>(
    initialOtpSessionId ? (initialPhone || null) : null,
  );
  const [paidDeposit, setPaidDeposit] = useState<PaidPublicDeposit | null>(null);
  const [verificationAction, setVerificationAction] = useState<VerificationAction>("none");
  const [verificationLoading, setVerificationLoading] = useState(false);

  type AppliedVoucher = {
    voucher_id: string;
    code: string;
    discount_cents: number;
    final_price_cents: number;
  };
  const [appliedVoucher, setAppliedVoucher] = useState<AppliedVoucher | null>(null);
  const [bookingRequestId, setBookingRequestId] = useState(() => crypto.randomUUID());
  const bookingSubmitIdempotencyKeyRef = useRef(bookingRequestId);
  const bookingSubmitAttemptedRef = useRef(false);
  const [resolvedBookingRequest, setResolvedBookingRequest] = useState<{
    materialKey: string;
    material: PublicBookingRequestMaterial;
    requestId: string;
  } | null>(null);
  const [fetchedPricingQuote, setFetchedPricingQuote] = useState<{
    key: string;
    quote: PublicBookingPricingQuote;
  } | null>(null);
  const [pricingQuoteLoading, setPricingQuoteLoading] = useState(false);
  const [pricingQuoteError, setPricingQuoteError] = useState<string | null>(null);
  const [pricingReconfirmRequired, setPricingReconfirmRequired] = useState(false);
  const [referenceImagePath, setReferenceImagePath] = useState<string | null>(null);
  const [referenceImagePreview, setReferenceImagePreview] = useState<string | null>(null);

  // Returning customer lookup state
  const [returningCustomer, setReturningCustomer] = useState<ReturningCustomer | null>(
    initialReturningCustomer ?? null,
  );
  // Which lookup has finished, tagged with the request it belongs to.
  // `lookupLoading` is derived from it against the phone on screen, so the
  // effect below never has to raise or lower a flag synchronously.
  const [settledLookupKey, setSettledLookupKey] = useState<string | null>(null);
  const [preferredStaffDismissed, setPreferredStaffDismissed] = useState(false);
  const lookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [waitlistSubmitting, setWaitlistSubmitting] = useState(false);
  // Option A no-show card gate — resolved when the customer reaches the confirm
  // step (before any booking exists) so the card form can render in-step.
  // Raw fetch results, each tagged with the request identity it belongs to.
  // What the confirm step reads is derived from those below, so neither effect
  // has to clear state synchronously when its inputs stop applying.
  const [fetchedCardRequirement, setFetchedCardRequirement] = useState<{
    key: string;
    requirement: NoShowCardRequirement | null;
  } | null>(null);
  // Đợt 2 — returning OTP-verified customer's saved card (one-tap reuse). Null =
  // not looked up / none; only populated when a card is required AND OTP-verified.
  const [fetchedSavedCard, setFetchedSavedCard] = useState<{
    key: string;
    card: SavedNoShowCard | null;
  } | null>(null);
  // SMS consent — captured at the phone gate; pre-satisfies confirm so it isn't
  // asked twice. Confirm still requires it (gates the button) as a safety net.
  const [smsConsent, setSmsConsent] = useState(initialSmsConsent);
  const [marketingConsent, setMarketingConsent] = useState(initialMarketingConsent);
  const [waitlistSlotJoined, setWaitlistSlotJoined] = useState(false);
  const waitlistRequestRef = useRef({
    intentKey: "",
    requestId: createPublicWaitlistRequestId(),
  });
  const [error, setError] = useState<string | null>(null);
  const [infoNameError, setInfoNameError] = useState<string | null>(null);
  const [infoPhoneError, setInfoPhoneError] = useState<string | null>(null);
  const [infoEmailError, setInfoEmailError] = useState<string | null>(null);
  const [bookingResult, setBookingResult] = useState<{
    bookingId: string;
    startTimeUtc: string;
    endTimeUtc: string;
    staffName: string;
    addonServiceName: string | null;
    addonPriceCents: number | null;
    addons: { serviceId: string; name: string; priceCents: number | null }[];
    price_cents: number;
    pricing: PublicBookingPricingQuote;
    cardManagementToken: string | null;
    cardManagementPending: boolean;
  } | null>(null);

  // Minutes an add-on ADDS to the appointment: concurrent add-ons run alongside
  // the main service (+0), only sequential ones extend the block.
  const addonAddedMinutes = useCallback(
    (a: BookingServiceItem | undefined) =>
      !a || a.addonConcurrent ? 0 : a.totalMinutes,
    [],
  );

  // Total EXTRA minutes from the currently-selected add-ons (concurrent = 0).
  const selectedAddonsTotalMin = useMemo(
    () =>
      selectedAddonIds.reduce(
        (sum, id) =>
          sum + addonAddedMinutes(upsellCandidates.find((s) => s.id === id)),
        0,
      ),
    [selectedAddonIds, upsellCandidates, addonAddedMinutes],
  );

  // Same total, but resolved against the FULL add-on list (`addOns`) instead
  // of `upsellCandidates` — the latter is cleared whenever no slot is picked
  // (e.g. right after a re-pick), which would wrongly drop the add-on minutes
  // from the time-step slot sizing. Used only for slot sizing.
  const selectedAddonsSlotMin = useMemo(
    () =>
      selectedAddonIds.reduce(
        (sum, id) => sum + addonAddedMinutes(addOns.find((s) => s.id === id)),
        0,
      ),
    [selectedAddonIds, addOns, addonAddedMinutes],
  );

  // Toggle an add-on on/off. Concurrent add-ons are always allowed (no time
  // cost); sequential ones are blocked when they'd overflow the staff's free
  // gap (so the appointment never runs into the next booking).
  const toggleAddon = useCallback(
    (id: string) => {
      setSelectedAddonIds((prev) => {
        if (prev.includes(id)) return prev.filter((x) => x !== id);
        const cand = upsellCandidates.find((s) => s.id === id);
        if (!cand) return prev;
        const used = prev.reduce(
          (sum, pid) =>
            sum + addonAddedMinutes(upsellCandidates.find((s) => s.id === pid)),
          0,
        );
        if (used + addonAddedMinutes(cand) > upsellGapMinutes) return prev; // won't fit
        return [...prev, id];
      });
    },
    [upsellCandidates, upsellGapMinutes, addonAddedMinutes],
  );

  /**
   * Hybrid upsell escape hatch: a time-consuming add-on that doesn't fit the
   * current slot's free gap is force-selected, then the customer is sent back
   * to the time step. Because slot sizing now includes selected add-ons, the
   * grid re-offers only times that fit service + add-on — no dead-end, and the
   * appointment stays correct. Clears the stale time pick so they choose fresh.
   */
  const addAddonAndRepickTime = useCallback(
    (id: string) => {
      // Mark as PENDING (not selected) so the time/slot reset effect can't
      // wipe it; slot sizing picks it up and it's auto-applied once a fitting
      // slot is chosen.
      setPendingAddonId(id);
      setTimeSlot(null);
      setStepDir(-1);
      setStep("time");
    },
    [],
  );

  const confettiFiredRef = useRef(false);

  const baseService = useMemo(
    () => (serviceId ? getServiceById(services, serviceId) : undefined),
    [serviceId, services],
  );
  // When a combo is selected, override the base service's duration and price
  // so slot blocking and pricing reflect the combo, not just the first component.
  const service = useMemo(
    () =>
      baseService && selectedCombo
        ? {
            ...baseService,
            totalMinutes: selectedCombo.durationMinutes,
            durationMinutes: selectedCombo.durationMinutes,
            priceCents: selectedCombo.priceCents,
            priceDisplay: null,
            name: selectedCombo.name,
          }
        : baseService,
    [baseService, selectedCombo],
  );
  const resourceCapacity = useMemo(() => {
    if (!salon.resourcesEnabled || !service) {
      return { requiresResource: false, eligibleResourceIds: [] as string[] };
    }
    if (service.resourceRequirementMode === "none") {
      return { requiresResource: false, eligibleResourceIds: [] as string[] };
    }
    const requiredKinds = new Set(service.requiredResourceKinds ?? []);
    const eligible =
      service.resourceRequirementMode === "specific"
        ? resources.filter((resource) => requiredKinds.has(resource.kind))
        : resources;
    return {
      requiresResource: true,
      eligibleResourceIds: eligible.map((resource) => resource.id),
    };
  }, [resources, salon.resourcesEnabled, service]);

  const slotBookingTiming = useMemo(() => {
    if (!service) {
      return {
        blockMinutes: 0,
        serviceCompletionMinutes: 0,
        trailingBufferMinutes: 0,
      };
    }
    const selectedIds = pendingAddonId
      ? Array.from(new Set([...selectedAddonIds, pendingAddonId]))
      : selectedAddonIds;
    const selectedAddOns = selectedIds.flatMap((id) => {
      const addOn = addOns.find((item) => item.id === id);
      return addOn
        ? [
            {
              durationMinutes: addOn.durationMinutes,
              bufferMinutes: addOn.bufferMinutes,
              concurrent: addOn.addonConcurrent,
            },
          ]
        : [];
    });
    return computeBookingTiming(
      selectedCombo
        ? {
            durationMinutes: selectedCombo.durationMinutes,
            bufferMinutes: 0,
          }
        : {
            durationMinutes: service.durationMinutes,
            bufferMinutes: service.bufferMinutes,
          },
      selectedAddOns,
    );
  }, [
    service,
    selectedCombo,
    selectedAddonIds,
    pendingAddonId,
    addOns,
  ]);
  const slotAddOnCount =
    selectedAddonIds.length +
    (pendingAddonId && !selectedAddonIds.includes(pendingAddonId) ? 1 : 0);
  const slotTrailingBufferMinutes =
    selectedCombo || slotAddOnCount > 1
      ? 0
      : slotBookingTiming.trailingBufferMinutes;

  /** Staff filtered to those capable of the currently selected service.
   *  When no service is picked yet we show the full list (step 1 hasn't gated anything). */
  const capableStaff = useMemo(
    () => filterStaffCapableForService(staff, capability, serviceId),
    [staff, capability, serviceId],
  );

  /** If the user changed service after picking a specific staff who can no
   *  longer perform it, fall back to "any" so step 2 stays valid. */
  useEffect(() => {
    if (
      staffId &&
      staffId !== BOOKING_ANY_STAFF_ID &&
      !capableStaff.some((s) => s.id === staffId)
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guard: drop stale staff selection when capability changes
      setStaffId(BOOKING_ANY_STAFF_ID);
    }
  }, [capableStaff, staffId]);

  const guestContactInvalid = useMemo(() => {
    const nameT = clientName.trim();
    if (nameT.length < 2 || nameT.length > BOOKING_GUEST_NAME_MAX) return true;
    if (!isValidCustomerName(nameT)) return true;
    if (!validateGuestPhone(clientPhone).ok) return true;
    /* Email is optional — empty is fine. Only invalid when provided + malformed. */
    const emailT = clientEmail.trim();
    if (emailT.length > 0 && !isValidEmailFormat(emailT)) return true;
    return false;
  }, [clientName, clientPhone, clientEmail]);

  // Public waitlist notifications must have a dependable email destination.
  // Keep the normal booking flow unchanged (email remains optional there).
  const waitlistContactInvalid = useMemo(() => {
    if (guestContactInvalid) return true;
    return !isValidEmailFormat(clientEmail);
  }, [guestContactInvalid, clientEmail]);

  const setBookingClientName = useCallback((v: string) => {
    setClientName(v);
    setInfoNameError(null);
  }, []);

  const setBookingClientPhone = useCallback((v: string) => {
    // P2.6 — live-format NANP-style numbers as the guest types so the
    // value reads "(604) 778-2345" while they're typing instead of
    // jumping at blur. International (`+...`) entries are left to the
    // user's own format.
    setClientPhone(formatPhoneInputProgressive(v));
    setInfoPhoneError(null);
  }, []);

  const setBookingClientEmail = useCallback((v: string) => {
    setClientEmail(v);
    setInfoEmailError(null);
  }, []);

  const handleAcceptPreferredStaff = useCallback((id: string) => {
    setStaffId(id);
    setPreferredStaffDismissed(false);
  }, []); // stable setter

  const handleDismissPreferredStaff = useCallback(() => {
    setPreferredStaffDismissed(true);
  }, []);

  const handleInfoNameBlur = useCallback(() => {
    const trimmed = clientName.trim();
    setClientName(trimmed);
    if (trimmed.length === 0) {
      setInfoNameError(t.bookingErrors.nameRequired);
    } else if (trimmed.length === 1) {
      setInfoNameError(t.bookingErrors.nameTooShort);
    } else if (trimmed.length > BOOKING_GUEST_NAME_MAX) {
      setInfoNameError(t.bookingErrors.nameTooLong);
    } else if (!isValidCustomerName(trimmed)) {
      setInfoNameError(t.bookingErrors.invalidNameChars);
    } else {
      setInfoNameError(null);
    }
  }, [
    clientName,
    t.bookingErrors.nameRequired,
    t.bookingErrors.nameTooShort,
    t.bookingErrors.nameTooLong,
    t.bookingErrors.invalidNameChars,
  ]);

  const handleInfoPhoneBlur = useCallback(() => {
    const pTrim = clientPhone.trim();
    setClientPhone(pTrim);
    if (pTrim.length === 0) {
      setInfoPhoneError(null);
      return;
    }
    setInfoPhoneError(
      validateGuestPhone(pTrim).ok ? null : t.bookingErrors.invalidPhone,
    );
  }, [clientPhone, t.bookingErrors.invalidPhone]);

  const handleInfoEmailBlur = useCallback(() => {
    const eTrim = clientEmail.trim();
    setClientEmail(eTrim);
    if (eTrim.length === 0) {
      setInfoEmailError(null);
      return;
    }
    setInfoEmailError(
      isValidEmailFormat(eTrim) ? null : t.bookingErrors.invalidEmail,
    );
  }, [clientEmail, t.bookingErrors.invalidEmail]);

  useEffect(() => {
    if (step !== "done") {
      confettiFiredRef.current = false;
      return;
    }
    if (confettiFiredRef.current) return;
    confettiFiredRef.current = true;
    void fireBookingConfetti();
  }, [step]);

  // Gate-verified: the full profile was already fetched via the
  // profile-verified API and supplied through initialReturningCustomer. Skip
  // the anonymous lookup, which only returns { found, isVip } and would
  // overwrite the rich profile. No key → nothing to look up, nothing loading.
  const lookupPhone = validateGuestPhone(clientPhone.trim());
  const lookupKey =
    !initialOtpSessionId && lookupPhone.ok
      ? JSON.stringify([salon.id, lookupPhone.digits])
      : null;
  const lookupLoading = lookupKey !== null && settledLookupKey !== lookupKey;

  // Debounced phone lookup — auto-fills name/email for returning customers
  useEffect(() => {
    // Cancel any pending lookup
    if (lookupTimerRef.current) {
      clearTimeout(lookupTimerRef.current);
      lookupTimerRef.current = null;
    }

    if (!lookupKey || !lookupPhone.ok) {
      if (!initialOtpSessionId) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- reactive reset when phone becomes invalid
        setReturningCustomer(null);
      }
      return;
    }

    // Phone valid — debounce 400ms then fetch
    const requestKey = lookupKey;
    const requestDigits = lookupPhone.digits;
    let alive = true;
    lookupTimerRef.current = setTimeout(() => {
      void fetch(
        `/api/customer/${encodeURIComponent(requestDigits)}?salon_id=${encodeURIComponent(salon.id)}`
      )
        .then((r) => r.json() as Promise<ReturningCustomer | { found: false }>)
        .then((data) => {
          // Without this, a slow answer for a number the customer has already
          // typed past would land on the profile shown for the new one.
          if (!alive) return;
          if (data.found) {
            setReturningCustomer(data as ReturningCustomer);
            setPreferredStaffDismissed(false); // reset dismiss when new profile loaded
            // Name/email are NOT returned by the public lookup (privacy fix S1);
            // guard anyway so a future post-OTP fetch can auto-fill when empty.
            const name = (data as ReturningCustomer).name;
            if (name) setClientName((prev) => (!prev.trim() ? name : prev));
            const email = (data as ReturningCustomer).email;
            if (email) setClientEmail((prev) => (!prev.trim() ? email : prev));
          } else {
            setReturningCustomer(null);
          }
        })
        .catch(() => {
          if (alive) setReturningCustomer(null);
        })
        .finally(() => {
          if (alive) setSettledLookupKey(requestKey);
        });
    }, 400);

    return () => {
      alive = false;
      if (lookupTimerRef.current) {
        clearTimeout(lookupTimerRef.current);
      }
    };
  }, [clientPhone, salon.id]); // eslint-disable-line react-hooks/exhaustive-deps -- setClientName/setClientEmail are stable setters

  const applyWebVoiceBookingHandoff = useCallback((handoff: WebVoiceBookingHandoff) => {
    const date = localNoonFromYmd(handoff.bookingDateYmd);
    if (!date) {
      setError(t.bookingErrors.slotJustTaken);
      return;
    }
    pendingWebVoiceTimeSlotRef.current = normalizeVoiceSlotLabel(handoff.timeSlot);
    setServiceId(handoff.serviceId);
    setSelectedComboState(null);
    setStaffId(handoff.staffId || BOOKING_ANY_STAFF_ID);
    setSelectedDate(date);
    setTimeSlot(null);
    setClientName(handoff.clientName.trim());
    setClientPhone(handoff.clientPhone.trim());
    setError(null);
    setVerificationAction("none");
    setStepDir(1);
    setStep("time");
  }, [t.bookingErrors.slotJustTaken]);

  useEffect(() => {
    timeSlotRef.current = timeSlot;
  }, [timeSlot]);

  useEffect(() => {
    if (step !== "time") return;

    let cancelled = false;
    const supabase = createPublicClient();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- expose connection readiness and degraded state to the booking UI/test contract
    setAvailabilityRealtimeStatus("connecting");

    const onAvailabilityChange = () => {
      if (!cancelled) setAvailabilityRevision((revision) => revision + 1);
    };
    const filter = `salon_id=eq.${salon.id}`;
    const channel = supabase
      .channel(`public-booking-availability-${salon.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "salon_availability_revisions",
          filter,
        },
        onAvailabilityChange,
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "salon_availability_revisions",
          filter,
        },
        onAvailabilityChange,
      )
      .subscribe((status) => {
        if (cancelled) return;
        if (status === "SUBSCRIBED") {
          setAvailabilityRealtimeStatus("subscribed");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          setAvailabilityRealtimeStatus("degraded");
        }
      });

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [step, salon.id]);

  useEffect(() => {
    if (step !== "time" || !serviceId || !service) return;

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- start spinner before async fetch
    setSlotsLoading(true);

    void getAvailableTimeSlots({
      salonId: salon.id,
      openingHoursRaw: salon.opening_hours,
      selectedDate,
      staffId: staffId ?? BOOKING_ANY_STAFF_ID,
      staffList: capableStaff,
      // Size slots for the WHOLE appointment — service + any already-chosen
      // add-ons. On the first pass no add-ons are picked yet (→ 0), so the
      // behaviour is unchanged; on a re-pick (after adding a time-consuming
      // add-on at confirm) the grid only offers times that fit everything.
      serviceDurationMinutes: slotBookingTiming.blockMinutes,
      trailingBufferMinutes: slotTrailingBufferMinutes,
      closedDateYmdSet,
      shortestServiceMinutes,
      leadMinutes: salon.bookingLeadMinutes,
      timezone: salon.timezone,
      requiresResource: resourceCapacity.requiresResource,
      eligibleResourceIds: resourceCapacity.eligibleResourceIds,
    }).then((slots) => {
      if (cancelled) return;
      setTimeSlots(slots);
      const selectedSlot = timeSlotRef.current;
      if (
        availabilityRevision > 0 &&
        selectedSlot &&
        !slots.some((slot) => slot.available && slot.label === selectedSlot)
      ) {
        timeSlotRef.current = null;
        setTimeSlot(null);
        setError(t.bookingErrors.slotJustTaken);
      }
      setSlotsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [
    step,
    salon.id,
    salon.opening_hours,
    closedDateYmdSet,
    selectedDate,
    staffId,
    capableStaff,
    serviceId,
    service,
    shortestServiceMinutes,
    salon.bookingLeadMinutes,
    salon.timezone,
    slotBookingTiming,
    slotTrailingBufferMinutes,
    availabilityRevision,
    resourceCapacity,
    t.bookingErrors.slotJustTaken,
  ]);

  useEffect(() => {
    if (step !== "time" || !serviceId) return;
    let cancelled = false;
    void fetch(
      `/api/booking/slot-ranking?salon_id=${encodeURIComponent(salon.id)}&service_id=${encodeURIComponent(serviceId)}`,
    )
      .then((r) => r.json() as Promise<{ popularLabels?: string[] }>)
      .then((json) => {
        if (!cancelled) setPopularSlotLabels(json.popularLabels ?? []);
      })
      .catch(() => {
        /* non-critical — silently ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [step, salon.id, serviceId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reactive reset when key inputs change
    setWaitlistSlotJoined(false);
  }, [selectedDate, staffId, serviceId, salon.id]);

  /**
   * Hourly time labels for the selected day's open window — drives the
   * optional waitlist "Preferred time" select. Empty when the salon is
   * closed that day (or no hours configured) → the select is hidden.
   * Marks step every 60 min from the first whole hour at/after open, and
   * stop strictly before close (so we never offer a slot at closing time).
   */
  const waitlistTimeOptions = useMemo<string[]>(() => {
    const week = parseOpeningHours(salon.opening_hours);
    if (!week) return [];
    const dayKey = (["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const)[
      selectedDate.getDay()
    ];
    const day = week[dayKey];
    if (!day || day.closed) return [];
    const [openH, openM] = day.open.split(":").map((n) => parseInt(n, 10));
    const [closeH, closeM] = day.close.split(":").map((n) => parseInt(n, 10));
    if (
      Number.isNaN(openH) ||
      Number.isNaN(openM) ||
      Number.isNaN(closeH) ||
      Number.isNaN(closeM)
    ) {
      return [];
    }
    const openMin = openH * 60 + openM;
    const closeMin = closeH * 60 + closeM;
    const out: string[] = [];
    for (
      let mark = Math.ceil(openMin / 60) * 60;
      mark < closeMin;
      mark += 60
    ) {
      out.push(minutesToLabel(mark));
    }
    return out;
  }, [salon.opening_hours, selectedDate]);

  useEffect(() => {
    if (!timeSlot) return;
    if (timeSlots.length === 0) return;
    const match = timeSlots.find((s) => s.label === timeSlot);
    // Drop the pick if it's gone from the list OR if it's now disabled
    // (booked by another customer between fetches).
    if (!match || !match.available) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guard: drop pick that's no longer selectable
      setTimeSlot(null);
    }
  }, [timeSlots, timeSlot]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reactive reset of upsell selection on key changes
    setSelectedAddonIds([]);
  }, [serviceId, timeSlot, staffId, selectedDate]);

  useEffect(() => {
    if (
      tryonRecommendation?.addonServiceId &&
      tryonRecommendation.serviceId === serviceId
    ) {
      // Runs after the generic service-change reset above, so the verified
      // Try-On add-on survives the initial service preselection. A later user
      // toggle is not overwritten because these dependencies stay unchanged.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedAddonIds([tryonRecommendation.addonServiceId]);
    }
  }, [serviceId, tryonRecommendation]);

  // A pending add-on is service-specific — drop it if the service changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset pending on service change
    setPendingAddonId(null);
  }, [serviceId]);

  // Hybrid: once the customer lands on a slot whose gap fits the pending
  // add-on, promote it into the real selection (and clear pending) so the
  // confirm shows it bundled in.
  useEffect(() => {
    if (!pendingAddonId) return;
    const cand = addOns.find((s) => s.id === pendingAddonId);
    if (!cand) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear invalid pending
      setPendingAddonId(null);
      return;
    }
    const used = selectedAddonIds.reduce(
      (sum, id) =>
        sum + addonAddedMinutes(upsellCandidates.find((s) => s.id === id)),
      0,
    );
    if (used + addonAddedMinutes(cand) <= upsellGapMinutes) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- promote pending → selected once it fits
      setSelectedAddonIds((prev) =>
        prev.includes(pendingAddonId) ? prev : [...prev, pendingAddonId],
      );
      setPendingAddonId(null);
    }
  }, [
    pendingAddonId,
    upsellGapMinutes,
    selectedAddonIds,
    upsellCandidates,
    addOns,
    addonAddedMinutes,
  ]);

  useEffect(() => {
    if (
      step !== "confirm" ||
      !serviceId ||
      !service ||
      !timeSlot ||
      !staffId
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale upsell state when confirm preconditions break
      setUpsellCandidates([]);
      setUpsellGapMinutes(0);
      return;
    }

    const week = parseOpeningHours(salon.opening_hours);
    if (!week) {
      setUpsellCandidates([]);
      setUpsellGapMinutes(0);
      return;
    }

    let cancelled = false;

    void (async () => {
      const ymd = bookingDateYmdFromLocalDate(selectedDate);
      const dayRange = salonDayRangeUtc(ymd, salon.timezone);
      const occ = await fetchBookingOccupancyForRange(
        salon.id,
        dayRange.startUtc,
        dayRange.endUtc,
      );
      if (cancelled) return;

      let slotStartMs: number;
      try {
        slotStartMs = Date.parse(salonWallTimeToUtcIso(
          ymd,
          parseTimeSlotToMinutes(timeSlot),
          salon.timezone,
        ));
      } catch {
        setUpsellCandidates([]);
        setUpsellGapMinutes(0);
        return;
      }

      const mainEndMs = slotStartMs + service.totalMinutes * 60_000;

      function isStaffFreeForRange(
        staffUuid: string,
        a: number,
        b: number,
      ): boolean {
        for (const o of occ) {
          if (o.staffId !== staffUuid) continue;
          if (intervalsOverlapMs(a, b, o.startMs, o.endMs)) return false;
        }
        return true;
      }

      const dayStartMs = Date.parse(dayRange.startUtc);
      const dayEndMs = Date.parse(dayRange.endUtc);
      const orderedStaff = staff.map((s) => ({
        id: s.id,
        name: s.name,
      }));

      let staffForGap: string;
      if (staffId === BOOKING_ANY_STAFF_ID) {
        const freeIds = staff
          .map((s) => s.id)
          .filter((id) => isStaffFreeForRange(id, slotStartMs, mainEndMs));
        if (freeIds.length === 0) {
          setUpsellCandidates([]);
          setUpsellGapMinutes(0);
          return;
        }
        staffForGap = pickBestStaffAmongFree(
          freeIds,
          orderedStaff,
          occ,
          dayStartMs,
          dayEndMs,
          slotStartMs,
        );
      } else {
        if (!isStaffFreeForRange(staffId, slotStartMs, mainEndMs)) {
          setUpsellCandidates([]);
          setUpsellGapMinutes(0);
          return;
        }
        staffForGap = staffId;
      }

      const gapMin = computeStaffFloatGapMinutes({
        occIntervals: occ,
        staffId: staffForGap,
        slotEndMs: mainEndMs,
        dateYmd: ymd,
        timezone: salon.timezone,
        week,
      });

      // Upsell ONLY add-ons (complementary enhancements), never other main
      // services. Surface ALL add-ons: concurrent ones add $0 time so they
      // ALWAYS fit (e.g. LED mask "+0′"); time-consuming (sequential) ones
      // that don't fit the free gap are kept but rendered disabled/dimmed by
      // the confirm panel (it checks each add-on's fit). This avoids wrongly
      // hiding a concurrent add-on just because its raw duration > gap.
      const candidates = [...addOns];
      if (!cancelled) {
        setUpsellCandidates(candidates);
        setUpsellGapMinutes(Math.max(0, Math.round(gapMin)));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    step,
    serviceId,
    service,
    timeSlot,
    staffId,
    selectedDate,
    salon.id,
    salon.opening_hours,
    salon.timezone,
    staff,
    services,
    addOns,
  ]);

  const staffSummaryLabel = useMemo(() => {
    if (!staffId || staffId === BOOKING_ANY_STAFF_ID) return t.anyStaffSummary;
    const row = staff.find((s) => s.id === staffId);
    if (!row) return "—";
    return getPublicStaffDisplayName(row.name);
  }, [staffId, staff, t.anyStaffSummary]);

  const confirmTimeLabel = useMemo(() => {
    if (!timeSlot) return "";
    return formatBookingSlotDisplay(selectedDate, timeSlot);
  }, [selectedDate, timeSlot]);

  /** Advance from phone step to service step. */
  const handleContinueFromPhone = useCallback(() => {
    setStep("service");
  }, []);

  /**
   * Pre-fills service/staff/date from the customer's last booking and jumps
   * straight to the time step so they only need to pick a slot.
   */
  const handleRebook = useCallback(
    (lb: NonNullable<ReturningCustomer["lastBooking"]>) => {
      // Pre-fill service
      setServiceId(lb.serviceId);
      setSelectedComboState(null);
      setServiceError(null);

      // Pre-fill staff (null means any available staff)
      setStaffId(lb.staffId ?? BOOKING_ANY_STAFF_ID);

      // Pre-fill date: next occurrence of lb.dayOfWeek from tomorrow
      const today = salonTodayCalendarDate(salon.timezone);
      const todayDay = today.getDay(); // 0=Sun
      let daysAhead = lb.dayOfWeek - todayDay;
      if (daysAhead <= 0) daysAhead += 7; // always at least 1 day ahead
      const nextDate = new Date(today);
      nextDate.setDate(today.getDate() + daysAhead);
      nextDate.setHours(0, 0, 0, 0);
      setSelectedDate(nextDate);
      setTimeSlot(null);

      // Jump to time step — user picks the specific slot (usual time will be visible)
      setStepDir(1);
      setStep("time");
    },
    [salon.timezone],
  );

  const goServiceNext = useCallback(() => {
    if (!serviceId) {
      setServiceError(t.bookingErrors.serviceRequired);
      return;
    }
    setServiceError(null);
    setStepDir(1);
    // When the salon hides staff selection, skip the staff step entirely and
    // auto-assign any available provider.
    if (salon.staffSelectionEnabled === false) {
      setStaffId(BOOKING_ANY_STAFF_ID);
      setStep("date");
    } else {
      setStep("staff");
    }
  }, [serviceId, t.bookingErrors.serviceRequired, salon.staffSelectionEnabled]);

  const setServiceIdAndClearError = useCallback((id: string) => {
    setServiceId(id);
    setSelectedComboState(null);
    setServiceError(null);
  }, []);

  const setSelectedCombo = useCallback((combo: BookingComboItem) => {
    // Use first service as the FK anchor; duration/price come from the combo
    const primaryServiceId = combo.serviceIds[0] ?? null;
    if (primaryServiceId) setServiceId(primaryServiceId);
    setSelectedComboState(combo);
    setServiceError(null);
  }, []);

  const goStaffNext = useCallback(() => {
    if (!staffId) return;
    setStepDir(1);
    setStep("date");
  }, [staffId]);

  const goDateNext = useCallback(() => {
    setStepDir(1);
    // Don't reset timeSlot here — the user may be returning via Back/Next
    // without changing the date. selectDateIfChanged clears it on real
    // date changes; the useEffect below also drops it if the new day's
    // slots no longer contain it.
    setStep("time");
  }, []);

  /** Wrap setSelectedDate so we only drop the picked time on a real change. */
  const selectDateIfChanged = useCallback(
    (next: Date) => {
      setSelectedDate((prev) => {
        const sameDay =
          prev.getFullYear() === next.getFullYear() &&
          prev.getMonth() === next.getMonth() &&
          prev.getDate() === next.getDate();
        if (sameDay) return prev;
        setTimeSlot(null);
        return next;
      });
    },
    [],
  );

  const goTimeNext = useCallback(() => {
    if (!timeSlot) return;
    setStepDir(1);
    setError(null);
    setInfoNameError(null);
    setInfoPhoneError(null);
    setStep("info");
  }, [timeSlot]);

  // Voice auto-fill: set slot + advance to info in one batch (bypasses guard safely)
  const goTimeNextDirect = useCallback((slot: string) => {
    setTimeSlot(slot);
    setStepDir(1);
    setError(null);
    setInfoNameError(null);
    setInfoPhoneError(null);
    setStep("info");
  }, []);

  const goInfoNext = useCallback(() => {
    const nameTrim = clientName.trim();
    const phoneTrim = clientPhone.trim();
    const emailTrim = clientEmail.trim();

    const nameErr =
      nameTrim.length === 0
        ? t.bookingErrors.nameRequired
        : nameTrim.length === 1
          ? t.bookingErrors.nameTooShort
          : nameTrim.length > BOOKING_GUEST_NAME_MAX
            ? t.bookingErrors.nameTooLong
            : !isValidCustomerName(nameTrim)
              ? t.bookingErrors.invalidNameChars
              : null;

    let phoneErr: string | null = null;
    if (phoneTrim.length === 0) {
      phoneErr = t.bookingErrors.phoneRequired;
    } else if (!validateGuestPhone(phoneTrim).ok) {
      phoneErr = t.bookingErrors.invalidPhone;
    }

    /* Email is optional. Only block on provided-but-invalid. */
    const emailErr =
      emailTrim.length > 0 && !isValidEmailFormat(emailTrim)
        ? t.bookingErrors.invalidEmail
        : null;

    setInfoNameError(nameErr);
    setInfoPhoneError(phoneErr);
    setInfoEmailError(emailErr);

    if (nameErr !== null || phoneErr !== null || emailErr !== null) {
      setError(null);
      return;
    }

    setError(null);
    setStepDir(1);
    // Always go through "verify" — it auto-routes to otp/confirm based on risk.
    // Do NOT clear otpSessionId here: the phone can't change after the gate, so a
    // session already verified for this phone stays valid. Clearing it made every
    // info→verify pass (e.g. back-from-OTP then forward) re-trigger a fresh OTP +
    // duplicate SMS. goVerifyDecided now skips OTP when the phone is already verified.
    setVerificationAction("none");
    setStep("verify");
  }, [
    clientName,
    clientPhone,
    clientEmail,
    phoneOtpEnabled, // eslint-disable-line react-hooks/exhaustive-deps -- kept for API compat, verify step handles routing
    t.bookingErrors.invalidEmail,
    t.bookingErrors.nameRequired,
    t.bookingErrors.nameTooShort,
    t.bookingErrors.nameTooLong,
    t.bookingErrors.invalidNameChars,
    t.bookingErrors.invalidPhone,
    t.bookingErrors.phoneRequired,
  ]);

  // Called by BookingFlowVerifyPanel when decision is fetched
  const goVerifyDecided = useCallback(
    (action: VerificationAction) => {
      setVerificationAction(action);
      setStepDir(1);
      if (action === "none") {
        setStep("confirm");
      } else if (action === "otp_optional" || action === "otp_required") {
        // Already verified this exact phone in this session → don't re-prompt OTP
        // or re-send an SMS; go straight to confirm. The submit re-validates the
        // session server-side, so a stale/expired session still fails safe there.
        if (otpSessionId && otpVerifiedPhone === clientPhone) {
          setStep("confirm");
        } else {
          setStep("otp");
        }
      } else {
        // deposit_required / deposit_or_otp → collect a deposit on the salon's
        // connected Stripe. The deposit panel self-skips to confirm if the salon
        // isn't connected or no deposit is actually owed (booking stays unblocked).
        setStep("deposit");
      }
    },
    [otpSessionId, otpVerifiedPhone, clientPhone],
  );

  // Customer skipped optional OTP — proceed to confirm unverified
  const goSkipOtp = useCallback(() => {
    setOtpSessionId(null);
    setOtpVerifiedPhone(null);
    setStepDir(1);
    setStep("confirm");
  }, []);

  // Deposit paid on the salon's connected Stripe → carry ids to submit + confirm.
  const goDepositPaid = useCallback((deposit: PaidPublicDeposit) => {
    setPaidDeposit(deposit);
    setStepDir(1);
    setStep("confirm");
  }, []);

  // No deposit owed / salon not connected → proceed normally.
  const goDepositSkip = useCallback(() => {
    setStepDir(1);
    setStep("confirm");
  }, []);

  const goOtpNext = useCallback((sessionId: string) => {
    setOtpSessionId(sessionId);
    setOtpVerifiedPhone(clientPhone);
    setStepDir(1);
    setStep("confirm");
  }, [clientPhone]);

  // OTP panel "Back" → returns to verify step (which auto-navigated to otp)
  const backFromOtpToInfo = useCallback(() => {
    setStepDir(-1);
    setStep("info");
    setVerificationAction("none");
    setError(null);
    setInfoNameError(null);
    setInfoPhoneError(null);
  }, []);

  const resetAfterDone = useCallback(() => {
    // A key represents one customer-confirmed create intent. Rotate only after
    // the success screen is explicitly reset, so retries/re-renders remain safe.
    setStepDir(1);
    setStep("phone");
    setBookingResult(null);
    setClientName("");
    setClientPhone("");
    setClientEmail("");
    setClientNotes("");
    setClientWebsite("");
    setSelectedAddonIds([]);
    setOtpSessionId(null);
    setOtpVerifiedPhone(null);
    setVerificationAction("none");
    setVerificationLoading(false);
    setServiceId(null);
    setStaffId(BOOKING_ANY_STAFF_ID);
    setSelectedDate(normalizeNoon(new Date()));
    setTimeSlot(null);
    setTimeSlots([]);
    setError(null);
    setWaitlistSlotJoined(false);
    setWaitlistPreferredTime("");
    setInfoNameError(null);
    setInfoPhoneError(null);
    setInfoEmailError(null);
    setFetchedPricingQuote(null);
    setPricingQuoteError(null);
    setPricingReconfirmRequired(false);
    setAppliedVoucher(null);
    setResolvedBookingRequest(null);
    bookingSubmitAttemptedRef.current = false;
    const nextBookingRequestId = crypto.randomUUID();
    bookingSubmitIdempotencyKeyRef.current = nextBookingRequestId;
    setBookingRequestId(nextBookingRequestId);
  }, []);

  const handleAddToCalendar = useCallback((): boolean => {
    if (!bookingResult || !service) return false;
    const start = new Date(bookingResult.startTimeUtc);
    const end = new Date(bookingResult.endTimeUtc);
    const ref = formatNailiqBookingRef(bookingResult.bookingId);
    const staffBit =
      bookingResult.staffName.trim().length > 0
        ? `\nProfessional: ${bookingResult.staffName}`
        : "";
    const addBit =
      bookingResult.addonServiceName &&
      bookingResult.addonServiceName.trim().length > 0
        ? `\nAdd-on: ${bookingResult.addonServiceName.trim()}`
        : "";
    const icsBody = generateBookingCalendarIcs({
      title: `${service.name} — ${shopLabel}`,
      description: `Booking reference: ${ref}\nSalon: ${shopLabel}${staffBit}${addBit}`,
      location: shopLabel,
      start,
      end,
      eventUid: `${bookingResult.bookingId}@booking.nailiq`,
    });
    if (!icsBody) return false;
    const blob = new Blob([icsBody], {
      type: "text/calendar;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `nailiq-booking-${bookingResult.bookingId.replace(/-/g, "").slice(0, 8)}.ics`;
      // target="_blank" so iOS Safari falls back to opening the .ics for
      // direct import when the download attribute isn't honored.
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch {
      return false;
    } finally {
      // Defer revoke so Safari has time to read the Blob.
      window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
    }
  }, [bookingResult, service, shopLabel]);

  // Resolve the no-show card requirement when the customer reaches confirm —
  // before any booking exists — so the card form can render in the confirm step.
  // The key carries every argument the request is made with, so a stale answer
  // can never be read back under a different service or phone.
  const cardRequirementPhone = validateGuestPhone(clientPhone.trim());
  const cardRequirementKey =
    CUSTOMER_PAYMENT_GATEWAY_ENABLED &&
    step === "confirm" &&
    serviceId &&
    cardRequirementPhone.ok
      ? JSON.stringify([salon.id, serviceId, cardRequirementPhone.digits])
      : null;
  const cardRequirement =
    cardRequirementKey && fetchedCardRequirement?.key === cardRequirementKey
      ? fetchedCardRequirement.requirement
      : null;
  // True while resolveNoShowCardRequirement is in-flight. Gates the confirm
  // button so the user can't race past the card check before it resolves.
  const cardRequirementLoading =
    cardRequirementKey !== null && fetchedCardRequirement?.key !== cardRequirementKey;

  useEffect(() => {
    if (!cardRequirementKey || !serviceId || !cardRequirementPhone.ok) return;
    const requestKey = cardRequirementKey;
    const clientPhoneDigits = cardRequirementPhone.digits;
    let alive = true;
    void resolveNoShowCardRequirement({
      salonId: salon.id,
      serviceId,
      clientPhone: clientPhoneDigits,
    })
      .then((r) => {
        if (alive) setFetchedCardRequirement({ key: requestKey, requirement: r });
      })
      .catch(() => {
        // Treat a failed resolve as "no card required", exactly as before —
        // and settle the key so the confirm button stops being gated.
        if (alive) setFetchedCardRequirement({ key: requestKey, requirement: null });
      });
    return () => {
      alive = false;
    };
    // cardRequirementKey already encodes salon.id, serviceId and the digits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardRequirementKey]);

  // Đợt 2 — once a card is required AND the phone is OTP-verified, check whether
  // this returning customer already has a card on file so the confirm step can
  // offer one-tap reuse. OTP-gated by construction (needs otpSessionId; the
  // server reads the phone from the session, never the client).
  const savedCardKey =
    step === "confirm" && cardRequirement?.required === true && otpSessionId
      ? JSON.stringify([salon.id, otpSessionId])
      : null;
  const savedCard =
    savedCardKey && fetchedSavedCard?.key === savedCardKey
      ? fetchedSavedCard.card
      : null;

  useEffect(() => {
    if (!savedCardKey || !otpSessionId) return;
    const requestKey = savedCardKey;
    let alive = true;
    void resolveSavedNoShowCard({ salonId: salon.id, otpSessionId })
      .then((r) => {
        if (alive) setFetchedSavedCard({ key: requestKey, card: r });
      })
      .catch(() => {
        if (alive) setFetchedSavedCard({ key: requestKey, card: null });
      });
    return () => {
      alive = false;
    };
    // savedCardKey already encodes salon.id and otpSessionId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedCardKey]);

  const buildPricingQuoteRequest = useCallback(
    (voucherCode: string | null): BookingParams | null => {
      if (!serviceId || !timeSlot || !staffId) return null;
      const phone = validateGuestPhone(clientPhone.trim());
      const name = clientName.trim();
      const email = clientEmail.trim();
      if (!phone.ok || !isValidCustomerName(name)) return null;
      if (email && !isValidEmailFormat(email)) return null;
      return {
        shopSlug,
        serviceId,
        timeSlot,
        bookingDateYmd: bookingDateYmdFromLocalDate(selectedDate),
        staffId,
        clientName: name,
        clientPhone: phone.digits,
        clientEmail: email || null,
        addonServiceIds: selectedAddonIds.filter((id) =>
          upsellCandidates.some((candidate) => candidate.id === id),
        ),
        comboOverride: selectedCombo
          ? {
              comboId: selectedCombo.id,
              durationMinutes: selectedCombo.durationMinutes,
              priceCents: selectedCombo.priceCents,
            }
          : null,
        voucherCode,
        emailCaptureDiscount: email.length > 0,
      };
    },
    [
      clientEmail,
      clientName,
      clientPhone,
      selectedAddonIds,
      selectedCombo,
      selectedDate,
      serviceId,
      shopSlug,
      staffId,
      timeSlot,
      upsellCandidates,
  ],
  );

  useEffect(() => {
    const requested = pendingWebVoiceTimeSlotRef.current;
    if (!requested || step !== "time" || slotsLoading) return;
    if (timeSlots.length === 0) return;
    pendingWebVoiceTimeSlotRef.current = null;
    const match = timeSlots.find(
      (slot) => slot.available && normalizeVoiceSlotLabel(slot.label) === requested,
    );
    if (!match) {
      setError(t.voice.slotNotFound.replace("{time}", requested));
      return;
    }
    setTimeSlot(match.label);
    setVerificationAction("none");
    setStepDir(1);
    setStep("verify");
  }, [slotsLoading, step, t.voice.slotNotFound, timeSlots]);

  const pricingQuoteRequest = buildPricingQuoteRequest(appliedVoucher?.code ?? null);
  const pricingQuoteKey =
    (step === "confirm" || step === "deposit") && pricingQuoteRequest
      ? buildPublicBookingPricingQuoteKey({
          shopSlug: pricingQuoteRequest.shopSlug,
          serviceId: pricingQuoteRequest.serviceId,
          staffId: pricingQuoteRequest.staffId,
          bookingDateYmd: pricingQuoteRequest.bookingDateYmd,
          timeSlot: pricingQuoteRequest.timeSlot,
          clientPhone: pricingQuoteRequest.clientPhone,
          clientEmail: pricingQuoteRequest.clientEmail ?? null,
          addonServiceIds: [...(pricingQuoteRequest.addonServiceIds ?? [])],
          comboId: pricingQuoteRequest.comboOverride?.comboId ?? null,
          voucherCode: pricingQuoteRequest.voucherCode ?? null,
          applyEmailDiscount: pricingQuoteRequest.emailCaptureDiscount === true,
        })
      : null;
  const fetchedQuote =
    pricingQuoteKey && fetchedPricingQuote?.key === pricingQuoteKey
      ? fetchedPricingQuote.quote
      : null;
  const bookingRequestMaterial: PublicBookingRequestMaterial | null =
    fetchedQuote && pricingQuoteRequest
      ? {
          salonId: fetchedQuote.salonId,
          serviceId: fetchedQuote.serviceId,
          staffId: fetchedQuote.resolvedStaffId,
          clientName: pricingQuoteRequest.clientName,
          clientPhone: pricingQuoteRequest.clientPhone,
          startTimeUtc: fetchedQuote.startTimeUtc,
          endTimeUtc: fetchedQuote.endTimeUtc,
          clientNotes: clientNotes.trim() || null,
          addonServiceIds: [...(pricingQuoteRequest.addonServiceIds ?? [])],
          clientEmail: pricingQuoteRequest.clientEmail?.trim().toLowerCase() || null,
          resourceId: null,
          comboId: fetchedQuote.comboId,
          voucherId: fetchedQuote.voucherId,
          applyEmailDiscount: pricingQuoteRequest.emailCaptureDiscount === true,
          expectedPricingFingerprint: fetchedQuote.pricingFingerprint,
        }
      : null;
  const bookingRequestMaterialKey = bookingRequestMaterial
    ? JSON.stringify(bookingRequestMaterial)
    : null;
  const pricingQuote =
    fetchedQuote &&
    bookingRequestMaterialKey &&
    resolvedBookingRequest?.materialKey === bookingRequestMaterialKey
      ? fetchedQuote
      : null;

  useEffect(() => {
    if (!pricingQuoteKey || !pricingQuoteRequest) return;
    const requestKey = pricingQuoteKey;
    const request = pricingQuoteRequest;
    let alive = true;
    const timer = window.setTimeout(() => {
      setPricingQuoteLoading(true);
      setPricingQuoteError(null);
      void quotePublicBooking(request)
        .then((quote) => {
          if (!alive) return;
          setFetchedPricingQuote({ key: requestKey, quote });
          setPricingReconfirmRequired(false);
        })
        .catch(() => {
          if (!alive) return;
          setPricingQuoteError("quote_unavailable");
        })
        .finally(() => {
          if (alive) setPricingQuoteLoading(false);
        });
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // pricingQuoteKey contains every request field. Using the object itself as
    // a dependency would retrigger on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricingQuoteKey]);

  useEffect(() => {
    if (!bookingRequestMaterial || !bookingRequestMaterialKey) return;
    const materialKey = bookingRequestMaterialKey;
    let alive = true;
    void stablePublicBookingRequestId(bookingRequestMaterial)
      .then((requestId) => {
        if (!alive) return;
        if (bookingSubmitIdempotencyKeyRef.current !== requestId) {
          bookingSubmitAttemptedRef.current = false;
        }
        bookingSubmitIdempotencyKeyRef.current = requestId;
        setBookingRequestId(requestId);
        setResolvedBookingRequest({
          materialKey,
          material: bookingRequestMaterial,
          requestId,
        });
      })
      .catch(() => {
        if (alive) setPricingQuoteError("quote_unavailable");
      });
    return () => {
      alive = false;
    };
    // The material key contains every normalized DB idempotency field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingRequestMaterialKey]);

  const onConfirm = useCallback(async (
    extra?: { noShowCardSourceId?: string; noShowCardVerificationToken?: string; noShowConsent?: boolean; noShowReuseSavedCard?: boolean; healthAck?: boolean },
  ) => {
    if (!serviceId || !timeSlot || !staffId) return;
    if (!pricingQuote || !resolvedBookingRequest || pricingQuoteLoading) {
      setPricingQuoteError("quote_unavailable");
      return;
    }
    setError(null);
    const name = clientName.trim();
    const phone = clientPhone.trim();
    const email = clientEmail.trim();
    const nameEmpty = name.length === 0;
    const nameTooShort = !nameEmpty && name.length === 1;
    const nameTooLong = name.length > BOOKING_GUEST_NAME_MAX;
    const nameWrongChars =
      !nameEmpty && !nameTooShort && !nameTooLong && !isValidCustomerName(name);
    const emailInvalid = email.length > 0 && !isValidEmailFormat(email);
    if (
      nameEmpty ||
      nameTooShort ||
      nameTooLong ||
      nameWrongChars ||
      !validateGuestPhone(phone).ok ||
      emailInvalid
    ) {
      setError(
        nameEmpty
          ? t.bookingErrors.nameRequired
          : nameTooShort
            ? t.bookingErrors.nameTooShort
            : nameTooLong
              ? t.bookingErrors.nameTooLong
              : nameWrongChars
                ? t.bookingErrors.invalidNameChars
                : emailInvalid
                  ? t.bookingErrors.invalidEmail
                  : phone.length === 0
                    ? t.bookingErrors.phoneRequired
                    : t.bookingErrors.invalidPhone,
      );
      return;
    }

    const notes = clientNotes.trim();
    // Keep only still-valid selections (in the current candidate list).
    const addonIds = selectedAddonIds.filter((id) =>
      upsellCandidates.some((s) => s.id === id),
    );

    setSubmitting(true);
    const idempotencyReplay = bookingSubmitAttemptedRef.current;
    bookingSubmitAttemptedRef.current = true;
    const bookingRequestIdForAttempt = bookingSubmitIdempotencyKeyRef.current;
    const bookingRequestMaterialForAttempt = resolvedBookingRequest.material;
    try {
      const result = await submitPublicBooking({
        shopSlug,
        serviceId,
        timeSlot,
        bookingDateYmd: bookingDateYmdFromLocalDate(selectedDate),
        staffId,
        clientName: name,
        clientPhone: phone,
        clientEmail: email.length > 0 ? email : null,
        clientNotes: notes,
        language,
        addonServiceIds: addonIds,
        otpSessionId: otpSessionId ?? null,
        // Task #09-11 — honeypot. Real users never see this field;
        // a non-empty value triggers a silent fake-success on the
        // server so the bot doesn't learn it was detected.
        clientWebsite,
        voucherCode: appliedVoucher?.code ?? null,
        expectedPricingQuote: pricingQuote,
        emailCaptureDiscount: email.length > 0 ? true : undefined,
        idempotencyKey: bookingRequestIdForAttempt,
        idempotencyReplay,
        referenceImagePath: referenceImagePath ?? undefined,
        comboOverride: selectedCombo
          ? { comboId: selectedCombo.id, durationMinutes: selectedCombo.durationMinutes, priceCents: selectedCombo.priceCents }
          : undefined,
        // Referral code from the landing URL (/<slug>?ref=CODE) — the wizard never
        // changes the route, so it's still on window.location at submit time.
        referralCode:
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("ref")?.trim() || undefined
            : undefined,
        verificationMethod:
          verificationAction === "none" ? "none"
          : otpSessionId ? "otp"
          : undefined,
        noShowCardSourceId: extra?.noShowCardSourceId,
        noShowCardVerificationToken: extra?.noShowCardVerificationToken,
        noShowReuseSavedCard: extra?.noShowReuseSavedCard,
        noShowConsent: extra?.noShowConsent,
        healthAck: extra?.healthAck,
        marketingConsent: marketingConsent || undefined,
        smsConsent: smsConsent || undefined,
        paidDeposit,
      });
      await acknowledgePublicBookingRequestId(
        bookingRequestMaterialForAttempt,
        bookingRequestIdForAttempt,
      );
      // A Try-On session is carried only by its opaque UUID in the URL; the
      // server additionally requires the HttpOnly bearer cookie and a fresh
      // same-salon booking before it will attach the private preview.
      const tryonSessionId = typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("tryon")
        : null;
      if (tryonSessionId) {
        try {
          await fetch("/api/nail-tryon/attach", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: tryonSessionId, bookingId: result.bookingId }),
          });
        } catch (e) {
          // Booking success must never be rolled back by a preview attachment.
          console.error("[booking] nail try-on attach failed", e);
        }
      }
      setBookingResult({
        bookingId: result.bookingId,
        startTimeUtc: result.startTimeUtc,
        endTimeUtc: result.endTimeUtc,
        staffName: result.staffName,
        addonServiceName: result.addonServiceName,
        addonPriceCents: result.addonPriceCents,
        addons: result.addons,
        price_cents: result.price_cents,
        pricing: result.pricing,
        cardManagementToken: result.cardManagementToken,
        cardManagementPending: result.cardManagementPending,
      });
      setStepDir(1);
      setStep("done");
    } catch (err) {
      if (err instanceof BookingPricingChangedError) {
        bookingSubmitAttemptedRef.current = false;
        if (pricingQuoteKey) {
          setFetchedPricingQuote({ key: pricingQuoteKey, quote: err.quote });
        }
        setPricingReconfirmRequired(true);
        setError("pricing_changed");
      } else if (err instanceof BookingConflictError) {
        bookingSubmitAttemptedRef.current = false;
        setStepDir(-1);
        setStep("time");
        setError(t.bookingErrors.slotJustTaken);
        if (serviceId && service) {
          setSlotsLoading(true);
          void getAvailableTimeSlots({
            salonId: salon.id,
            openingHoursRaw: salon.opening_hours,
            selectedDate,
            staffId: staffId ?? BOOKING_ANY_STAFF_ID,
            staffList: capableStaff,
            serviceDurationMinutes: slotBookingTiming.blockMinutes,
            trailingBufferMinutes: slotTrailingBufferMinutes,
            closedDateYmdSet,
            shortestServiceMinutes,
            leadMinutes: salon.bookingLeadMinutes,
            timezone: salon.timezone,
            requiresResource: resourceCapacity.requiresResource,
            eligibleResourceIds: resourceCapacity.eligibleResourceIds,
          }).then((slots) => {
            setTimeSlots(slots);
            setSlotsLoading(false);
          });
        }
      } else if (
        err instanceof Error &&
        err.message === "booking_rate_limited"
      ) {
        bookingSubmitAttemptedRef.current = false;
        setError(t.bookingErrors.rateLimited);
        setStep("info");
      } else if (
        err instanceof Error &&
        err.message === "cannot_book_past"
      ) {
        setTimeSlot(null);
        setError(t.slotTooSoonError ?? t.pastTimeError);
        setStep("time");
      } else if (
        err instanceof Error &&
        (err.message === "outside_opening_hours" ||
          err.message === "salon_closed_day")
      ) {
        setError(
          err.message === "salon_closed_day"
            ? t.salonClosedError
            : t.outsideHoursError,
        );
        setStep("time");
      } else if (
        err instanceof Error &&
        err.message === "salon_not_live"
      ) {
        setError(t.submitError);
      } else if (
        err instanceof Error &&
        (err.message === "booking_commit_unknown" ||
          err.message === "deposit_binding_pending")
      ) {
        // The booking/deposit commit may already exist. Keep both the logical
        // create key and replay marker so an explicit retry replays that exact
        // transaction identity instead of creating another appointment.
        setError(
          err.message === "booking_commit_unknown"
            ? t.submitUnknown
            : (t.noShowCardError ?? t.submitError),
        );
        setStep("confirm");
      } else if (
        err instanceof Error &&
        err.message === "invalid_name_chars"
      ) {
        setError(t.bookingErrors.invalidNameChars);
      } else if (
        err instanceof Error &&
        err.message === "invalid_phone"
      ) {
        setError(t.bookingErrors.invalidPhone);
      } else if (
        err instanceof Error &&
        err.message === "invalid_email"
      ) {
        setError(t.bookingErrors.invalidEmail);
      } else if (
        err instanceof Error &&
        err.message === "invalid_addon"
      ) {
        setError(t.submitError);
        setSelectedAddonIds([]);
      } else if (
        err instanceof Error &&
        err.message === "monthly_booking_limit_reached"
      ) {
        setError(t.bookingErrors.monthlyLimitReached);
      } else if (
        err instanceof Error &&
        (err.message === "otp_required" || err.message === "otp_invalid")
      ) {
        // OTP session missing or expired — send user back to OTP step.
        setOtpSessionId(null);
        setOtpVerifiedPhone(null);
        setStepDir(-1);
        setStep("otp");
        setError(t.bookingErrors.otpRequired);
      } else {
        ErrorReporter.captureException(
          err instanceof Error ? err : new Error(String(err)),
          {
            tags: {
              "salon.slug": shopSlug,
              "salon.id": salon.id,
              "booking.flow": "confirm_submit",
            },
          },
        );
        setError(t.submitError);
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    clientName,
    clientPhone,
    clientEmail,
    clientNotes,
    clientWebsite,
    resolvedBookingRequest,
    pricingQuote,
    pricingQuoteLoading,
    pricingQuoteKey,
    appliedVoucher,
    paidDeposit,
    language,
    marketingConsent,
    referenceImagePath,
    selectedCombo,
    selectedAddonIds,
    upsellCandidates,
    selectedDate,
    serviceId,
    staffId,
    timeSlot,
    shopSlug,
    salon.id,
    salon.opening_hours,
    salon.bookingLeadMinutes,
    salon.timezone,
    closedDateYmdSet,
    service,
    capableStaff,
    slotBookingTiming.blockMinutes,
    slotTrailingBufferMinutes,
    shortestServiceMinutes,
    resourceCapacity,
    smsConsent,
    verificationAction,
    otpSessionId,
    t.bookingErrors.nameRequired,
    t.bookingErrors.nameTooShort,
    t.bookingErrors.nameTooLong,
    t.bookingErrors.invalidNameChars,
    t.bookingErrors.invalidPhone,
    t.bookingErrors.phoneRequired,
    t.bookingErrors.invalidEmail,
    t.outsideHoursError,
    t.pastTimeError,
    t.salonClosedError,
    t.bookingErrors.slotJustTaken,
    t.bookingErrors.rateLimited,
    t.bookingErrors.monthlyLimitReached,
    t.bookingErrors.otpRequired,
    t.noShowCardError,
    t.slotTooSoonError,
    t.submitError,
    t.submitUnknown,
  ]);

  const submitWaitlistSlotUnavailable = useCallback(async () => {
    if (!serviceId || !staffId) return;
    const name = clientName.trim();
    const phone = clientPhone.trim();
    const email = clientEmail.trim();
    const nameEmpty = name.length === 0;
    const nameTooLong = name.length > BOOKING_GUEST_NAME_MAX;
    const nameWrongChars =
      !nameEmpty && !nameTooLong && !isValidCustomerName(name);
    if (
      nameEmpty ||
      nameTooLong ||
      nameWrongChars ||
      !validateGuestPhone(phone).ok ||
      !isValidEmailFormat(email)
    ) {
      setError(
        nameEmpty
          ? t.bookingErrors.nameRequired
          : nameTooLong
            ? t.bookingErrors.nameTooLong
            : nameWrongChars
              ? t.bookingErrors.invalidNameChars
              : phone.length === 0
                ? t.bookingErrors.phoneRequired
                : !validateGuestPhone(phone).ok
                  ? t.bookingErrors.invalidPhone
                  : email.length === 0
                    ? t.waitlistEmailRequired
                    : t.bookingErrors.invalidEmail,
      );
      return;
    }
    setWaitlistSubmitting(true);
    setError(null);
    try {
      const bookingDateYmd = bookingDateYmdFromLocalDate(selectedDate);
      const preferredSlotLabel = waitlistPreferredTime.trim() || null;
      const waitlistIntentKey = JSON.stringify({
        salonId: salon.id,
        serviceId,
        staffId,
        bookingDateYmd,
        preferredSlotLabel,
        clientName: name,
        clientPhone: phone,
        clientEmail: email,
      });
      if (waitlistRequestRef.current.intentKey !== waitlistIntentKey) {
        waitlistRequestRef.current = {
          intentKey: waitlistIntentKey,
          requestId: createPublicWaitlistRequestId(),
        };
      }
      await submitPublicWaitlistEntry({
        shopSlug,
        serviceId,
        staffId,
        bookingDateYmd,
        preferredSlotLabel,
        clientName: name,
        clientPhone: phone,
        clientEmail: email,
        source: "slot_unavailable",
        requestId: waitlistRequestRef.current.requestId,
        clientLocale: language,
      });
      setWaitlistSlotJoined(true);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "invalid_phone"
          ? t.bookingErrors.invalidPhone
          : e instanceof Error && e.message === "invalid_email"
            ? t.bookingErrors.invalidEmail
            : e instanceof Error && e.message === "invalid_name_chars"
              ? t.bookingErrors.invalidNameChars
              : t.waitlistError,
      );
    } finally {
      setWaitlistSubmitting(false);
    }
  }, [
    clientName,
    clientPhone,
    clientEmail,
    waitlistPreferredTime,
    selectedDate,
    serviceId,
    salon.id,
    shopSlug,
    staffId,
    language,
    t.bookingErrors.nameRequired,
    t.bookingErrors.nameTooLong,
    t.bookingErrors.invalidNameChars,
    t.bookingErrors.invalidPhone,
    t.bookingErrors.phoneRequired,
    t.bookingErrors.invalidEmail,
    t.waitlistEmailRequired,
    t.waitlistError,
  ]);

  const backToPhone = useCallback(() => {
    setStepDir(-1);
    setStep("phone");
  }, []);

  const backToService = useCallback(() => {
    setStepDir(-1);
    setStep("service");
  }, []);

  const backToStaff = useCallback(() => {
    setStepDir(-1);
    // Staff step is hidden when selection is disabled — go back to service.
    setStep(salon.staffSelectionEnabled === false ? "service" : "staff");
  }, [salon.staffSelectionEnabled]);

  const backToDate = useCallback(() => {
    setStepDir(-1);
    setStep("date");
    setError(null);
  }, []);

  const backToTime = useCallback(() => {
    setStepDir(-1);
    setStep("time");
    setError(null);
    setInfoNameError(null);
    setInfoPhoneError(null);
  }, []);

  const backToInfo = useCallback(() => {
    setStepDir(-1);
    // confirm → info. Only route back through the OTP step when the customer is
    // NOT yet verified — re-showing OTP to an already-verified phone re-asked the
    // code and re-sent an SMS. Verified (session for this phone) → straight to info.
    if (
      verificationAction !== "none" &&
      !(otpSessionId && otpVerifiedPhone === clientPhone)
    ) {
      setStep("otp");
    } else {
      setStep("info");
    }
    setError(null);
    setInfoNameError(null);
    setInfoPhoneError(null);
  }, [verificationAction, otpSessionId, otpVerifiedPhone, clientPhone]);

  async function handleApplyVoucher(
    code: string,
    _totalCents: number,
  ): Promise<{ error?: string }> {
    void _totalCents;
    const normalizedCode = code.trim().toUpperCase();
    const request = buildPricingQuoteRequest(normalizedCode);
    if (!request) return { error: "generic" };
    try {
      setPricingQuoteLoading(true);
      const quote = await quotePublicBooking(request);
      if (!quote.voucherId) return { error: "invalid" };
      setAppliedVoucher({
        voucher_id: quote.voucherId,
        code: quote.voucherCode ?? normalizedCode,
        discount_cents: quote.voucherDiscountCents,
        final_price_cents: quote.subtotalCents,
      });
      const key = buildPublicBookingPricingQuoteKey({
        shopSlug: request.shopSlug,
        serviceId: request.serviceId,
        staffId: request.staffId,
        bookingDateYmd: request.bookingDateYmd,
        timeSlot: request.timeSlot,
        clientPhone: request.clientPhone,
        clientEmail: request.clientEmail ?? null,
        addonServiceIds: [...(request.addonServiceIds ?? [])],
        comboId: request.comboOverride?.comboId ?? null,
        voucherCode: normalizedCode,
        applyEmailDiscount: request.emailCaptureDiscount === true,
      });
      setFetchedPricingQuote({ key, quote });
      setPricingQuoteError(null);
      return {};
    } catch {
      return { error: "generic" };
    } finally {
      setPricingQuoteLoading(false);
    }
  }

  function handleRemoveVoucher() {
    setAppliedVoucher(null);
  }

  return {
    shopLabel,
    step,
    stepDir,
    serviceId,
    staffId,
    selectedDate,
    timeSlot,
    timeSlots,
    slotsLoading,
    availabilityRealtimeStatus,
    popularSlotLabels,
    selectedCombo,
    selectedComboId: selectedCombo?.id ?? null,
    tryonDesignName,
    tryonBookingQuote,
    clientName,
    clientPhone,
    clientEmail,
    clientNotes,
    clientWebsite,
    selectedAddonIds,
    upsellCandidates,
    upsellGapMinutes,
    submitting,
    waitlistSubmitting,
    waitlistSlotJoined,
    waitlistPreferredTime,
    setWaitlistPreferredTime,
    waitlistTimeOptions,
    error,
    serviceError,
    bookingResult,
    pricingQuote,
    pricingQuoteLoading,
    pricingQuoteError,
    pricingReconfirmRequired,
    bookingRequestId,
    infoNameError,
    infoPhoneError,
    infoEmailError,
    service,
    capableStaff,
    staffSummaryLabel,
    confirmTimeLabel,
    guestContactInvalid,
    waitlistContactInvalid,
    setServiceId: setServiceIdAndClearError,
    setSelectedCombo,
    setStaffId,
    setSelectedDate: selectDateIfChanged,
    setTimeSlot,
    setClientName: setBookingClientName,
    setClientPhone: setBookingClientPhone,
    setClientEmail: setBookingClientEmail,
    handleInfoNameBlur,
    handleInfoPhoneBlur,
    handleInfoEmailBlur,
    setClientNotes,
    setClientWebsite,
    toggleAddon,
    addAddonAndRepickTime,
    selectedAddonsTotalMin,
    selectedAddonsSlotMin,
    setSelectedAddonIds,
    setError,
    otpSessionId,
    verificationAction,
    verificationLoading,
    setVerificationLoading,
    appliedVoucher,
    handleApplyVoucher,
    handleRemoveVoucher,
    referenceImagePath,
    referenceImagePreview,
    setReferenceImage: (path: string | null, preview: string | null) => {
      setReferenceImagePath(path);
      setReferenceImagePreview(preview);
    },
    goServiceNext,
    goStaffNext,
    goDateNext,
    goTimeNext,
    goTimeNextDirect,
    applyWebVoiceBookingHandoff,
    goInfoNext,
    goVerifyDecided,
    goSkipOtp,
    goDepositPaid,
    goDepositSkip,
    goOtpNext,
    resetAfterDone,
    handleAddToCalendar,
    onConfirm,
    cardRequirement,
    cardRequirementLoading,
    savedCard,
    smsConsent,
    setSmsConsent,
    marketingConsent,
    setMarketingConsent,
    submitWaitlistSlotUnavailable,
    backToPhone,
    backToService,
    backToStaff,
    backToDate,
    backToTime,
    backToInfo,
    backFromOtpToInfo,
    // Phone step handlers
    onContinueFromPhone: handleContinueFromPhone,
    onRebook: handleRebook,
    // Returning customer lookup
    returningCustomer,
    lookupLoading,
    preferredStaffDismissed,
    onAcceptPreferredStaff: handleAcceptPreferredStaff,
    onDismissPreferredStaff: handleDismissPreferredStaff,
  };
}
