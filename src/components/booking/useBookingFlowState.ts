"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getServiceById,
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
import { getAvailableTimeSlots } from "@/shared/booking/getAvailableTimeSlots";
import type {
  BookingSalonMeta,
  BookingStaffItem,
} from "@/shared/booking/loadBookingServices";
import { formatNailiqBookingRef } from "@/shared/lib/formatNailiqBookingRef";
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
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
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
  | "confirm"
  | "done";

function normalizeNoon(d: Date): Date {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  return x;
}

export function useBookingFlowState(
  t: BookingMessages,
  shopSlug: string,
  services: readonly BookingServiceItem[],
  staff: readonly BookingStaffItem[],
  salon: BookingSalonMeta,
) {
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
  const [staffId, setStaffId] = useState<string | null>(BOOKING_ANY_STAFF_ID);
  const [selectedDate, setSelectedDate] = useState<Date>(() =>
    normalizeNoon(new Date()),
  );
  const [timeSlot, setTimeSlot] = useState<string | null>(null);
  const [timeSlots, setTimeSlots] = useState<string[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);

  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientNotes, setClientNotes] = useState("");
  const [selectedAddonId, setSelectedAddonId] = useState<string | null>(null);
  const [upsellCandidates, setUpsellCandidates] = useState<
    BookingServiceItem[]
  >([]);

  const [submitting, setSubmitting] = useState(false);
  const [waitlistSubmitting, setWaitlistSubmitting] = useState(false);
  const [waitlistSlotJoined, setWaitlistSlotJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [infoNameError, setInfoNameError] = useState<string | null>(null);
  const [infoPhoneError, setInfoPhoneError] = useState<string | null>(null);
  const [bookingResult, setBookingResult] = useState<{
    bookingId: string;
    startTimeUtc: string;
    endTimeUtc: string;
    staffName: string;
    addonServiceName: string | null;
    price_cents: number;
  } | null>(null);

  const confettiFiredRef = useRef(false);

  const service = serviceId ? getServiceById(services, serviceId) : undefined;

  const guestContactInvalid = useMemo(() => {
    const nameT = clientName.trim();
    if (nameT.length === 0 || nameT.length > BOOKING_GUEST_NAME_MAX) return true;
    if (!isValidCustomerName(nameT)) return true;
    return !validateGuestPhone(clientPhone).ok;
  }, [clientName, clientPhone]);

  const setBookingClientName = useCallback((v: string) => {
    setClientName(v);
    setInfoNameError(null);
  }, []);

  const setBookingClientPhone = useCallback((v: string) => {
    setClientPhone(v);
    setInfoPhoneError(null);
  }, []);

  const handleInfoNameBlur = useCallback(() => {
    const trimmed = clientName.trim();
    setClientName(trimmed);
    if (trimmed.length === 0 || trimmed.length > BOOKING_GUEST_NAME_MAX) {
      setInfoNameError(t.bookingErrors.invalidName);
    } else if (!isValidCustomerName(trimmed)) {
      setInfoNameError(t.bookingErrors.invalidNameChars);
    } else {
      setInfoNameError(null);
    }
  }, [clientName, t.bookingErrors.invalidName, t.bookingErrors.invalidNameChars]);

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
    setSlotsLoading(true);

    void getAvailableTimeSlots({
      salonId: salon.id,
      openingHoursRaw: salon.opening_hours,
      selectedDate,
      staffId: staffId ?? BOOKING_ANY_STAFF_ID,
      staffList: staff,
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
    staff,
    serviceId,
    service,
  ]);

  useEffect(() => {
    setWaitlistSlotJoined(false);
  }, [selectedDate, staffId, serviceId, salon.id]);

  useEffect(() => {
    if (!timeSlot) return;
    if (timeSlots.length > 0 && !timeSlots.includes(timeSlot)) {
      setTimeSlot(null);
    }
  }, [timeSlots, timeSlot]);

  useEffect(() => {
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
      setUpsellCandidates([]);
      return;
    }

    const week = parseOpeningHours(salon.opening_hours);
    if (!week) {
      setUpsellCandidates([]);
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
      if (!cancelled) setUpsellCandidates(candidates);
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
    return getPublicStaffDisplayName(row.name, t.staffPlaceholderName);
  }, [staffId, staff, t.anyStaffSummary, t.staffPlaceholderName]);

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

  const goInfoNext = useCallback(() => {
    const nameTrim = clientName.trim();
    const phoneTrim = clientPhone.trim();

    const nameErr =
      nameTrim.length === 0 || nameTrim.length > BOOKING_GUEST_NAME_MAX
        ? t.bookingErrors.invalidName
        : !isValidCustomerName(nameTrim)
          ? t.bookingErrors.invalidNameChars
          : null;

    let phoneErr: string | null = null;
    if (phoneTrim.length === 0) {
      phoneErr = t.bookingErrors.phoneRequired;
    } else if (!validateGuestPhone(phoneTrim).ok) {
      phoneErr = t.bookingErrors.invalidPhone;
    }

    setInfoNameError(nameErr);
    setInfoPhoneError(phoneErr);

    if (nameErr !== null || phoneErr !== null) {
      setError(null);
      return;
    }

    setError(null);
    setStepDir(1);
    setStep("confirm");
  }, [
    clientName,
    clientPhone,
    t.bookingErrors.invalidName,
    t.bookingErrors.invalidNameChars,
    t.bookingErrors.invalidPhone,
    t.bookingErrors.phoneRequired,
  ]);

  const resetAfterDone = useCallback(() => {
    setStepDir(1);
    setStep("service");
    setBookingResult(null);
    setClientName("");
    setClientPhone("");
    setClientNotes("");
    setSelectedAddonId(null);
    setServiceId(null);
    setStaffId(BOOKING_ANY_STAFF_ID);
    setSelectedDate(normalizeNoon(new Date()));
    setTimeSlot(null);
    setTimeSlots([]);
    setError(null);
    setWaitlistSlotJoined(false);
    setInfoNameError(null);
    setInfoPhoneError(null);
  }, []);

  const handleAddToCalendar = useCallback(() => {
    if (!bookingResult || !service) return;
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
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [bookingResult, service, shopLabel]);

  const onConfirm = useCallback(async () => {
    if (!serviceId || !timeSlot || !staffId) return;
    setError(null);
    const name = clientName.trim();
    const phone = clientPhone.trim();
    const nameTooShortOrLong =
      name.length === 0 || name.length > BOOKING_GUEST_NAME_MAX;
    const nameWrongChars =
      !nameTooShortOrLong && !isValidCustomerName(name);
    if (nameTooShortOrLong || nameWrongChars || !validateGuestPhone(phone).ok) {
      setError(
        nameTooShortOrLong
          ? t.bookingErrors.invalidName
          : nameWrongChars
            ? t.bookingErrors.invalidNameChars
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
        clientNotes: notes,
        addonServiceId: addonId,
      });
      setBookingResult({
        bookingId: result.bookingId,
        startTimeUtc: result.startTimeUtc,
        endTimeUtc: result.endTimeUtc,
        staffName: result.staffName,
        addonServiceName: result.addonServiceName,
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
            staffList: staff,
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
        err.message === "invalid_addon"
      ) {
        setError(t.submitError);
        setSelectedAddonId(null);
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
    clientNotes,
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
    t.bookingErrors.invalidName,
    t.bookingErrors.invalidNameChars,
    t.bookingErrors.invalidPhone,
    t.bookingErrors.phoneRequired,
    t.outsideHoursError,
    t.pastTimeError,
    t.salonClosedError,
    t.bookingErrors.slotJustTaken,
    t.submitError,
  ]);

  const submitWaitlistSlotUnavailable = useCallback(async () => {
    if (!serviceId || !staffId) return;
    const name = clientName.trim();
    const phone = clientPhone.trim();
    const nameTooShortOrLong =
      name.length === 0 || name.length > BOOKING_GUEST_NAME_MAX;
    const nameWrongChars =
      !nameTooShortOrLong && !isValidCustomerName(name);
    if (
      nameTooShortOrLong ||
      nameWrongChars ||
      !validateGuestPhone(phone).ok
    ) {
      setError(
        nameTooShortOrLong
          ? t.bookingErrors.invalidName
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
    selectedDate,
    serviceId,
    shopSlug,
    staffId,
    t.bookingErrors.invalidName,
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
    setStep("info");
    setError(null);
    setInfoNameError(null);
    setInfoPhoneError(null);
  }, []);

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
    clientName,
    clientPhone,
    clientNotes,
    selectedAddonId,
    upsellCandidates,
    submitting,
    waitlistSubmitting,
    waitlistSlotJoined,
    error,
    serviceError,
    bookingResult,
    infoNameError,
    infoPhoneError,
    service,
    staffSummaryLabel,
    confirmTimeLabel,
    guestContactInvalid,
    setServiceId: setServiceIdAndClearError,
    setStaffId,
    setSelectedDate: selectDateIfChanged,
    setTimeSlot,
    setClientName: setBookingClientName,
    setClientPhone: setBookingClientPhone,
    handleInfoNameBlur,
    handleInfoPhoneBlur,
    setClientNotes,
    setSelectedAddonId,
    setError,
    goServiceNext,
    goStaffNext,
    goDateNext,
    goTimeNext,
    goInfoNext,
    resetAfterDone,
    handleAddToCalendar,
    onConfirm,
    submitWaitlistSlotUnavailable,
    backToService,
    backToStaff,
    backToDate,
    backToTime,
    backToInfo,
  };
}
