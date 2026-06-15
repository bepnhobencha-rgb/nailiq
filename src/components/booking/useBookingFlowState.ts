"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getServiceById,
  type BookingComboItem,
  type BookingServiceItem,
} from "@/shared/booking/catalog";
import {
  BookingConflictError,
  submitPublicBooking,
} from "@/shared/booking/submitPublicBooking";
import { submitPublicWaitlistEntry } from "@/shared/booking/submitPublicWaitlist";
import {
  resolveNoShowCardRequirement,
  type NoShowCardRequirement,
} from "@/shared/noshow/resolveNoShowCardRequirement";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import {
  bookingDateYmdFromLocalDate,
  formatBookingSlotDisplay,
} from "@/shared/booking/bookingConfirmLabels";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import {
  getAvailableTimeSlots,
  type TimeSlot,
} from "@/shared/booking/getAvailableTimeSlots";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import { formatNailiqBookingRef } from "@/shared/lib/formatNailiqBookingRef";
import { formatPhoneInputProgressive } from "@/shared/lib/phoneFormat";
import { generateBookingCalendarIcs } from "@/components/booking/bookingCalendar";
import { formatSalonDisplayName } from "@/shared/lib/salonDisplay";
import { fireBookingConfetti } from "@/components/booking/bookingConfetti";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { parseTimeSlotOnDate } from "@/shared/booking/parseBookingTimeSlot";
import { localDayBoundsFromLocalDate } from "@/shared/booking/localDayBounds";
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

import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import * as Sentry from "@sentry/nextjs";
import { BOOKING_GUEST_NAME_MAX } from "@/shared/booking/bookingGuestContactLimits";

export type ReturningCustomer = {
  found: true;
  name: string;
  email: string | null;
  isVip: boolean;
  visitCount: number;
  preferredStaffId: string | null;
  preferredStaffName: string | null;
  lastBooking: {
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
  /** Booking surface language — forwarded to the booking so the
   *  confirmation SMS is sent in the language the customer chose. */
  language: "en" | "vi" = "vi",
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
    normalizeNoon(new Date()),
  );
  const [timeSlot, setTimeSlot] = useState<string | null>(null);
  const [timeSlots, setTimeSlots] = useState<TimeSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [popularSlotLabels, setPopularSlotLabels] = useState<string[]>([]);
  const [selectedCombo, setSelectedComboState] = useState<BookingComboItem | null>(null);

  const [clientName, setClientName] = useState(
    initialName.trim() || (initialReturningCustomer?.name ?? ""),
  );
  const [clientPhone, setClientPhone] = useState(initialPhone ?? "");
  /** B-10: optional. Empty stays empty — we never persist locally (privacy fix B-02). */
  const [clientEmail, setClientEmail] = useState(
    initialReturningCustomer?.email ?? "",
  );
  const [clientNotes, setClientNotes] = useState("");
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

  const [otpSessionId, setOtpSessionId] = useState<string | null>(null);
  const [depositPaymentIntentId, setDepositPaymentIntentId] = useState<string | null>(null);
  const [depositConnectedAccountId, setDepositConnectedAccountId] = useState<string | null>(null);
  const [verificationAction, setVerificationAction] = useState<VerificationAction>("none");
  const [verificationLoading, setVerificationLoading] = useState(false);

  type AppliedVoucher = {
    voucher_id: string;
    code: string;
    discount_cents: number;
    final_price_cents: number;
  };
  const [appliedVoucher, setAppliedVoucher] = useState<AppliedVoucher | null>(null);
  const [referenceImagePath, setReferenceImagePath] = useState<string | null>(null);
  const [referenceImagePreview, setReferenceImagePreview] = useState<string | null>(null);

  // Returning customer lookup state
  const [returningCustomer, setReturningCustomer] = useState<ReturningCustomer | null>(
    initialReturningCustomer ?? null,
  );
  const [lookupLoading, setLookupLoading] = useState(false);
  const [preferredStaffDismissed, setPreferredStaffDismissed] = useState(false);
  const lookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [waitlistSubmitting, setWaitlistSubmitting] = useState(false);
  // Option A no-show card gate — resolved when the customer reaches the confirm
  // step (before any booking exists) so the card form can render in-step.
  const [cardRequirement, setCardRequirement] = useState<NoShowCardRequirement | null>(null);
  const [waitlistSlotJoined, setWaitlistSlotJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
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

  // Extra minutes for the pending (wanted-but-not-yet-fitting) add-on; added
  // to the time-step slot sizing so the grid offers times that fit it.
  const pendingAddonMin = useMemo(
    () =>
      pendingAddonId
        ? addonAddedMinutes(addOns.find((s) => s.id === pendingAddonId))
        : 0,
    [pendingAddonId, addOns, addonAddedMinutes],
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

  const baseService = serviceId ? getServiceById(services, serviceId) : undefined;
  // When a combo is selected, override the base service's duration and price
  // so slot blocking and pricing reflect the combo, not just the first component.
  const service = baseService && selectedCombo
    ? {
        ...baseService,
        totalMinutes: selectedCombo.durationMinutes,
        durationMinutes: selectedCombo.durationMinutes,
        priceCents: selectedCombo.priceCents,
        priceDisplay: null,
        name: selectedCombo.name,
      }
    : baseService;

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

  // Debounced phone lookup — auto-fills name/email for returning customers
  useEffect(() => {
    // Cancel any pending lookup
    if (lookupTimerRef.current) {
      clearTimeout(lookupTimerRef.current);
      lookupTimerRef.current = null;
    }

    const phoneValidation = validateGuestPhone(clientPhone.trim());
    if (!phoneValidation.ok) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reactive reset when phone becomes invalid
      setReturningCustomer(null);
      setLookupLoading(false);
      return;
    }

    // Phone valid — debounce 400ms then fetch
    setLookupLoading(true);
    lookupTimerRef.current = setTimeout(() => {
      void fetch(
        `/api/customer/${encodeURIComponent(phoneValidation.digits)}?salon_id=${encodeURIComponent(salon.id)}`
      )
        .then((r) => r.json() as Promise<ReturningCustomer | { found: false }>)
        .then((data) => {
          if (data.found) {
            setReturningCustomer(data as ReturningCustomer);
            setPreferredStaffDismissed(false); // reset dismiss when new profile loaded
            // Auto-fill name only if empty (don't overwrite what the user typed)
            setClientName((prev) => (!prev.trim() ? (data as ReturningCustomer).name : prev));
            // Auto-fill email only if empty
            const email = (data as ReturningCustomer).email;
            if (email) {
              setClientEmail((prev) => (!prev.trim() ? email : prev));
            }
          } else {
            setReturningCustomer(null);
          }
        })
        .catch(() => {
          setReturningCustomer(null);
        })
        .finally(() => {
          setLookupLoading(false);
        });
    }, 400);

    return () => {
      if (lookupTimerRef.current) {
        clearTimeout(lookupTimerRef.current);
      }
    };
  }, [clientPhone, salon.id]); // eslint-disable-line react-hooks/exhaustive-deps -- setClientName/setClientEmail are stable setters

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
      serviceDurationMinutes:
        service.totalMinutes + selectedAddonsSlotMin + pendingAddonMin,
      // NOTE: trailing-buffer spill past close is DISABLED. create_public_booking
      // rejects any booking whose end (service + buffer) is after close
      // (outside_hours), so offering a buffer-spill slot produced a slot the
      // server always refused ("Could not complete booking"). Require the whole
      // block to fit before close so availability matches create.
      trailingBufferMinutes: 0,
      closedDateYmdSet,
      shortestServiceMinutes,
      leadMinutes: salon.bookingLeadMinutes,
      timezone: salon.timezone,
    }).then((slots) => {
      if (cancelled) return;
      setTimeSlots(slots);
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
    selectedAddonsSlotMin,
    pendingAddonMin,
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
      const { start: dayStart, end: dayEnd } =
        localDayBoundsFromLocalDate(selectedDate);
      const occ = await fetchBookingOccupancyForRange(
        salon.id,
        dayStart.toISOString(),
        dayEnd.toISOString(),
      );
      if (cancelled) return;

      let startLocal: Date;
      try {
        startLocal = parseTimeSlotOnDate(timeSlot, ymd);
      } catch {
        setUpsellCandidates([]);
        setUpsellGapMinutes(0);
        return;
      }

      const slotStartMs = startLocal.getTime();
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

      const dayStartMs = dayStart.getTime();
      const dayEndMs = dayEnd.getTime();
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
        selectedDate,
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
      const today = new Date();
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
    [],
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

  // Voice full-flow: skip info/verify/otp, submit directly when voice has all 5 fields.
  // Falls back to goTimeNextDirect if name/phone are missing or invalid.
  const goVoiceSubmitDirect = useCallback(async (slot: string) => {
    if (!serviceId) { goTimeNextDirect(slot); return; }
    const name = clientName.trim();
    const phone = clientPhone.trim();
    if (!name || name.length < 2 || !validateGuestPhone(phone).ok) {
      goTimeNextDirect(slot);
      return;
    }
    setTimeSlot(slot);
    setSubmitting(true);
    setStepDir(1);
    setStep("confirm");
    try {
      const result = await submitPublicBooking({
        shopSlug,
        serviceId,
        timeSlot: slot,
        bookingDateYmd: bookingDateYmdFromLocalDate(selectedDate),
        staffId: staffId ?? BOOKING_ANY_STAFF_ID,
        clientName: name,
        clientPhone: phone,
        clientEmail: clientEmail.trim() || null,
        clientNotes: clientNotes.trim(),
        verificationMethod: "none",
        language,
      });
      setBookingResult({
        bookingId: result.bookingId,
        startTimeUtc: result.startTimeUtc,
        endTimeUtc: result.endTimeUtc,
        staffName: result.staffName,
        addonServiceName: result.addonServiceName,
        addonPriceCents: result.addonPriceCents,
        addons: result.addons,
        price_cents: result.price_cents,
      });
      setStepDir(1);
      setStep("done");
      void fireBookingConfetti();
    } catch (err) {
      setSubmitting(false);
      if (err instanceof BookingConflictError) {
        setStepDir(-1);
        setStep("time");
        setError(t.bookingErrors.slotJustTaken);
      } else if (err instanceof Error && err.message === "cannot_book_past") {
        // The slot was offered but is now within the lead window (or just
        // passed). Clear the stale selection so the user re-picks from the
        // freshly re-fetched grid instead of re-submitting the same slot.
        setTimeSlot(null);
        setError(t.slotTooSoonError ?? t.pastTimeError);
        setStep("time");
      } else if (err instanceof Error && (err.message === "outside_opening_hours" || err.message === "salon_closed_day")) {
        setError(err.message === "salon_closed_day" ? t.salonClosedError : t.outsideHoursError);
        setStep("time");
      } else if (err instanceof Error && err.message === "invalid_phone") {
        setError(t.bookingErrors.invalidPhone);
        setStep("info");
      } else if (err instanceof Error && err.message === "invalid_name_chars") {
        setError(t.bookingErrors.invalidNameChars);
        setStep("info");
      } else {
        Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: { "salon.slug": shopSlug, "booking.flow": "voice_submit_direct" },
        });
        setError(t.submitError);
        setStep("info");
      }
    } finally {
      setSubmitting(false);
    }
  }, [ // eslint-disable-line react-hooks/exhaustive-deps -- goTimeNextDirect is stable
    shopSlug, serviceId, staffId, selectedDate, clientName, clientPhone, clientEmail, clientNotes,
    goTimeNextDirect, t.bookingErrors.slotJustTaken, t.bookingErrors.invalidPhone,
    t.bookingErrors.invalidNameChars, t.pastTimeError, t.salonClosedError,
    t.outsideHoursError, t.submitError,
  ]);

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
    // Always go through "verify" — it auto-routes to otp/confirm based on risk
    setOtpSessionId(null);
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
        setStep("otp");
      } else {
        // deposit_required / deposit_or_otp → collect a deposit on the salon's
        // connected Stripe. The deposit panel self-skips to confirm if the salon
        // isn't connected or no deposit is actually owed (booking stays unblocked).
        setStep("deposit");
      }
    },
    [],
  );

  // Customer skipped optional OTP — proceed to confirm unverified
  const goSkipOtp = useCallback(() => {
    setOtpSessionId(null);
    setStepDir(1);
    setStep("confirm");
  }, []);

  // Deposit paid on the salon's connected Stripe → carry ids to submit + confirm.
  const goDepositPaid = useCallback((piId: string, acct: string) => {
    setDepositPaymentIntentId(piId);
    setDepositConnectedAccountId(acct);
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
    setStepDir(1);
    setStep("confirm");
  }, []);

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
    setVerificationAction("none");
    setVerificationLoading(false);
    setServiceId(null);
    setStaffId(BOOKING_ANY_STAFF_ID);
    setSelectedDate(normalizeNoon(new Date()));
    setTimeSlot(null);
    setTimeSlots([]);
    setError(null);
    setWaitlistSlotJoined(false);
    setInfoNameError(null);
    setInfoPhoneError(null);
    setInfoEmailError(null);
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
  useEffect(() => {
    if (step !== "confirm" || !serviceId) return;
    const v = validateGuestPhone(clientPhone.trim());
    if (!v.ok) {
      setCardRequirement(null);
      return;
    }
    let alive = true;
    void resolveNoShowCardRequirement({
      salonId: salon.id,
      serviceId,
      clientPhone: v.digits,
    })
      .then((r) => alive && setCardRequirement(r))
      .catch(() => alive && setCardRequirement(null));
    return () => {
      alive = false;
    };
  }, [step, serviceId, clientPhone, salon.id]);

  const onConfirm = useCallback(async (
    extra?: { noShowCardSourceId?: string; noShowConsent?: boolean },
  ) => {
    if (!serviceId || !timeSlot || !staffId) return;
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
        voucherRedemption: appliedVoucher
          ? { voucher_id: appliedVoucher.voucher_id, discount_cents: appliedVoucher.discount_cents }
          : undefined,
        referenceImagePath: referenceImagePath ?? undefined,
        comboOverride: selectedCombo
          ? { comboId: selectedCombo.id, durationMinutes: selectedCombo.durationMinutes, priceCents: selectedCombo.priceCents }
          : undefined,
        verificationMethod:
          verificationAction === "none" ? "none"
          : otpSessionId ? "otp"
          : undefined,
        noShowCardSourceId: extra?.noShowCardSourceId,
        noShowConsent: extra?.noShowConsent,
      });
      // Link a paid deposit to the freshly-created booking (server re-verifies
      // the PaymentIntent with Stripe). Best-effort: the webhook is the backstop.
      if (depositPaymentIntentId && depositConnectedAccountId) {
        try {
          await fetch("/api/booking/record-deposit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              bookingId: result.bookingId,
              paymentIntentId: depositPaymentIntentId,
              connectedAccountId: depositConnectedAccountId,
            }),
          });
        } catch (e) {
          console.error("[booking] record-deposit failed", e);
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
      });
      setStepDir(1);
      setStep("done");
    } catch (err) {
      if (err instanceof BookingConflictError) {
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
            serviceDurationMinutes: service.totalMinutes,
            // Disabled (see other call site): create rejects buffer-spill-past-close
            // slots, so require the whole block to fit before close.
            trailingBufferMinutes: 0,
            closedDateYmdSet,
            shortestServiceMinutes,
            leadMinutes: salon.bookingLeadMinutes,
            timezone: salon.timezone,
          }).then((slots) => {
            setTimeSlots(slots);
            setSlotsLoading(false);
          });
        }
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
        err.message.startsWith("card_save_failed")
      ) {
        // Card couldn't be saved → booking was cancelled server-side. Stay on
        // the confirm step so the customer can re-enter the card. Show the
        // provider reason (decline code) to aid diagnosis.
        const reason = err.message.slice("card_save_failed:".length).trim();
        setError(
          (t.noShowCardError ?? t.submitError) + (reason ? ` — ${reason}` : ""),
        );
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
        setStepDir(-1);
        setStep("otp");
        setError(t.bookingErrors.otpRequired);
      } else {
        Sentry.captureException(
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
    selectedAddonIds,
    upsellCandidates,
    selectedDate,
    serviceId,
    staffId,
    timeSlot,
    shopSlug,
    salon.id,
    salon.opening_hours,
    closedDateYmdSet,
    serviceId,
    service,
    staff,
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
    t.submitError,
  ]); // eslint-disable-line react-hooks/exhaustive-deps -- capableStaff, t.bookingErrors.monthlyLimitReached, t.bookingErrors.otpRequired are intentionally omitted; they don't affect the booking submission path

  const submitWaitlistSlotUnavailable = useCallback(async () => {
    if (!serviceId || !staffId) return;
    const name = clientName.trim();
    const phone = clientPhone.trim();
    const nameEmpty = name.length === 0;
    const nameTooLong = name.length > BOOKING_GUEST_NAME_MAX;
    const nameWrongChars =
      !nameEmpty && !nameTooLong && !isValidCustomerName(name);
    if (
      nameEmpty ||
      nameTooLong ||
      nameWrongChars ||
      !validateGuestPhone(phone).ok
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
                : t.bookingErrors.invalidPhone,
      );
      return;
    }
    setWaitlistSubmitting(true);
    setError(null);
    try {
      await submitPublicWaitlistEntry({
        shopSlug,
        serviceId,
        staffId,
        bookingDateYmd: bookingDateYmdFromLocalDate(selectedDate),
        preferredSlotLabel: null,
        clientName: name,
        clientPhone: phone,
        clientEmail: clientEmail.trim() || undefined,
        source: "slot_unavailable",
      });
      setWaitlistSlotJoined(true);
    } catch (e) {
      setError(
        e instanceof Error && e.message === "invalid_phone"
          ? t.bookingErrors.invalidPhone
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
    selectedDate,
    serviceId,
    shopSlug,
    staffId,
    t.bookingErrors.nameRequired,
    t.bookingErrors.nameTooLong,
    t.bookingErrors.invalidNameChars,
    t.bookingErrors.invalidPhone,
    t.bookingErrors.phoneRequired,
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
    // confirm → otp/verify → info: always go back two steps through verify
    if (verificationAction !== "none") {
      setStep("otp");
    } else {
      setStep("info");
    }
    setError(null);
    setInfoNameError(null);
    setInfoPhoneError(null);
  }, [verificationAction]);

  async function handleApplyVoucher(
    code: string,
    totalCents: number,
  ): Promise<{ error?: string }> {
    try {
      const res = await fetch("/api/vouchers/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salon_id: salon.id,
          code,
          client_phone: clientPhone,
          price_cents: totalCents,
        }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        voucher_id?: string;
        code?: string;
        discount_cents?: number;
        final_price_cents?: number;
      };
      if (!data.ok || !data.voucher_id) {
        return { error: data.error ?? "generic" };
      }
      setAppliedVoucher({
        voucher_id: data.voucher_id,
        code: data.code ?? code,
        discount_cents: data.discount_cents ?? 0,
        final_price_cents: data.final_price_cents ?? totalCents,
      });
      return {};
    } catch {
      return { error: "generic" };
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
    popularSlotLabels,
    selectedCombo,
    selectedComboId: selectedCombo?.id ?? null,
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
    error,
    serviceError,
    bookingResult,
    infoNameError,
    infoPhoneError,
    infoEmailError,
    service,
    capableStaff,
    staffSummaryLabel,
    confirmTimeLabel,
    guestContactInvalid,
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
    goVoiceSubmitDirect,
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
