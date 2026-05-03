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
import {
  decodeShopSlug,
  generateBookingCalendarIcs,
} from "@/components/booking/bookingCalendar";
import { fireBookingConfetti } from "@/components/booking/bookingConfetti";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { parseTimeSlotOnDate } from "@/shared/booking/parseBookingTimeSlot";
import { localDayBoundsFromLocalDate } from "@/shared/booking/localDayBounds";
import { fetchBookingOccupancyForRange } from "@/shared/booking/fetchBookingOccupancy";
import { intervalsOverlapMs } from "@/shared/booking/bookingIntervals";
import { pickBestStaffAmongFree } from "@/shared/booking/pickBestStaffAmongFree";
import { computeStaffFloatGapMinutes } from "@/shared/booking/computeStaffFloatGapMinutes";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import {
  loadSavedBookingGuestProfile,
  saveBookingGuestProfile,
} from "@/shared/booking/bookingClientProfile";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import * as Sentry from "@sentry/nextjs";

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
  const shopLabel = useMemo(() => decodeShopSlug(shopSlug), [shopSlug]);

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
  const [bookingResult, setBookingResult] = useState<{
    bookingId: string;
    startTimeUtc: string;
    endTimeUtc: string;
    staffName: string;
    addonServiceName: string | null;
    price_cents: number;
  } | null>(null);

  const confettiFiredRef = useRef(false);
  const profileLoadedRef = useRef(false);

  const service = serviceId ? getServiceById(services, serviceId) : undefined;

  useEffect(() => {
    if (profileLoadedRef.current) return;
    profileLoadedRef.current = true;
    const p = loadSavedBookingGuestProfile();
    if (p) {
      setClientName(p.name);
      setClientPhone(p.phone);
    }
  }, []);

  const guestContactInvalid = useMemo(() => {
    if (!clientName.trim()) return true;
    return !validateGuestPhone(clientPhone).ok;
  }, [clientName, clientPhone]);

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
    return row?.name ?? "—";
  }, [staffId, staff, t.anyStaffSummary]);

  const confirmTimeLabel = useMemo(() => {
    if (!timeSlot) return "";
    return formatBookingSlotDisplay(selectedDate, timeSlot);
  }, [selectedDate, timeSlot]);

  const goServiceNext = useCallback(() => {
    if (!serviceId) return;
    setStepDir(1);
    setStep("staff");
  }, [serviceId]);

  const goStaffNext = useCallback(() => {
    if (!staffId) return;
    setStepDir(1);
    setStep("date");
  }, [staffId]);

  const goDateNext = useCallback(() => {
    setStepDir(1);
    setTimeSlot(null);
    setStep("time");
  }, []);

  const goTimeNext = useCallback(() => {
    if (!timeSlot) return;
    setStepDir(1);
    setError(null);
    setStep("info");
  }, [timeSlot]);

  const goInfoNext = useCallback(() => {
    if (guestContactInvalid) {
      if (!clientName.trim()) {
        setError(t.contactRequiredError);
      } else {
        setError(t.invalidPhoneError);
      }
      return;
    }
    setError(null);
    setStepDir(1);
    setStep("confirm");
  }, [guestContactInvalid, clientName, t.contactRequiredError, t.invalidPhoneError]);

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
    if (!name || !validateGuestPhone(phone).ok) {
      setError(
        !name ? t.contactRequiredError : t.invalidPhoneError,
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
      saveBookingGuestProfile({ name, phone });
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
        err.message === "invalid_phone"
      ) {
        setError(t.invalidPhoneError);
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
    t.contactRequiredError,
    t.invalidPhoneError,
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
    if (!name || !validateGuestPhone(phone).ok) {
      setError(
        !name ? t.contactRequiredError : t.invalidPhoneError,
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
          ? t.invalidPhoneError
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
    t.contactRequiredError,
    t.invalidPhoneError,
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
  }, []);

  const backToInfo = useCallback(() => {
    setStepDir(-1);
    setStep("info");
    setError(null);
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
    bookingResult,
    service,
    staffSummaryLabel,
    confirmTimeLabel,
    guestContactInvalid,
    setServiceId,
    setStaffId,
    setSelectedDate,
    setTimeSlot,
    setClientName,
    setClientPhone,
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
