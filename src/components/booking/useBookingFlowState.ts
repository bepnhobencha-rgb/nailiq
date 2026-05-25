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

export type BookingFlowStep =
  | "service"
  | "staff"
  | "date"
  | "time"
  | "info"
  | "verify"
  | "otp"
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

  const [step, setStep] = useState<BookingFlowStep>("service");
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

  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  /** B-10: optional. Empty stays empty — we never persist locally (privacy fix B-02). */
  const [clientEmail, setClientEmail] = useState("");
  const [clientNotes, setClientNotes] = useState("");
  /** Task #09-11 — honeypot field, never shown to humans (CSS-hidden +
   *  `tabIndex=-1` + `aria-hidden`). Bots autofilling every `<input>`
   *  in the form will put something here; `submitPublicBooking`
   *  silently returns a fake success when that happens so no row is
   *  written and the bot doesn't learn it was caught. */
  const [clientWebsite, setClientWebsite] = useState("");
  const [selectedAddonId, setSelectedAddonId] = useState<string | null>(null);
  const [upsellCandidates, setUpsellCandidates] = useState<
    BookingServiceItem[]
  >([]);
  /** Staff free-gap minutes after the main service; surfaced in the upsell heading copy. */
  const [upsellGapMinutes, setUpsellGapMinutes] = useState<number>(0);

  const [otpSessionId, setOtpSessionId] = useState<string | null>(null);
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

  const [submitting, setSubmitting] = useState(false);
  const [waitlistSubmitting, setWaitlistSubmitting] = useState(false);
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
    price_cents: number;
  } | null>(null);

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
      serviceDurationMinutes: service.totalMinutes,
      closedDateYmdSet,
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
    setSelectedAddonId(null);
  }, [serviceId, timeSlot, staffId, selectedDate]);

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

      const candidates = services.filter(
        (s) =>
          s.id !== serviceId &&
          s.totalMinutes > 0 &&
          s.totalMinutes <= gapMin,
      );
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

  const goServiceNext = useCallback(() => {
    if (!serviceId) {
      setServiceError(t.bookingErrors.serviceRequired);
      return;
    }
    setServiceError(null);
    setStepDir(1);
    setStep("staff");
  }, [serviceId, t.bookingErrors.serviceRequired]);

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
      });
      setBookingResult({
        bookingId: result.bookingId,
        startTimeUtc: result.startTimeUtc,
        endTimeUtc: result.endTimeUtc,
        staffName: result.staffName,
        addonServiceName: result.addonServiceName,
        addonPriceCents: result.addonPriceCents,
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
        setError(t.pastTimeError);
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
        // deposit_required / deposit_or_otp — fall back to OTP until Stripe deposit UI is built
        setStep("otp");
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
    setStep("service");
    setBookingResult(null);
    setClientName("");
    setClientPhone("");
    setClientEmail("");
    setClientNotes("");
    setClientWebsite("");
    setSelectedAddonId(null);
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

  const onConfirm = useCallback(async () => {
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
    const addonId =
      selectedAddonId && upsellCandidates.some((s) => s.id === selectedAddonId)
        ? selectedAddonId
        : null;

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
        addonServiceId: addonId,
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
      });
      setBookingResult({
        bookingId: result.bookingId,
        startTimeUtc: result.startTimeUtc,
        endTimeUtc: result.endTimeUtc,
        staffName: result.staffName,
        addonServiceName: result.addonServiceName,
        addonPriceCents: result.addonPriceCents,
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
            closedDateYmdSet,
          }).then((slots) => {
            setTimeSlots(slots);
            setSlotsLoading(false);
          });
        }
      } else if (
        err instanceof Error &&
        err.message === "cannot_book_past"
      ) {
        setError(t.pastTimeError);
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
        setSelectedAddonId(null);
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
    selectedAddonId,
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

  const backToService = useCallback(() => {
    setStepDir(-1);
    setStep("service");
  }, []);

  const backToStaff = useCallback(() => {
    setStepDir(-1);
    setStep("staff");
  }, []);

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
    selectedAddonId,
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
    setSelectedAddonId,
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
    goOtpNext,
    resetAfterDone,
    handleAddToCalendar,
    onConfirm,
    submitWaitlistSlotUnavailable,
    backToService,
    backToStaff,
    backToDate,
    backToTime,
    backToInfo,
    backFromOtpToInfo,
  };
}
