"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getServiceById, type BookingServiceItem } from "@/shared/booking/catalog";
import {
  BookingConflictError,
  submitPublicBooking,
} from "@/shared/booking/submitPublicBooking";
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
import { decodeShopSlug, generateBookingCalendarIcs } from "@/components/booking/bookingCalendar";
import { fireBookingConfetti } from "@/components/booking/bookingConfetti";

export type BookingFlowStep =
  | "service"
  | "staff"
  | "date"
  | "time"
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookingResult, setBookingResult] = useState<{
    bookingId: string;
    startTimeUtc: string;
    staffName: string;
  } | null>(null);

  const confettiFiredRef = useRef(false);

  const service = serviceId ? getServiceById(services, serviceId) : undefined;

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
    selectedDate,
    staffId,
    staff,
    serviceId,
    service,
  ]);

  useEffect(() => {
    if (!timeSlot) return;
    if (timeSlots.length > 0 && !timeSlots.includes(timeSlot)) {
      setTimeSlot(null);
    }
  }, [timeSlots, timeSlot]);

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
    setStep("confirm");
  }, [timeSlot]);

  const resetAfterDone = useCallback(() => {
    setStepDir(1);
    setStep("service");
    setBookingResult(null);
    setClientName("");
    setClientPhone("");
    setServiceId(null);
    setStaffId(BOOKING_ANY_STAFF_ID);
    setSelectedDate(normalizeNoon(new Date()));
    setTimeSlot(null);
    setTimeSlots([]);
    setError(null);
  }, []);

  const handleAddToCalendar = useCallback(() => {
    if (!bookingResult || !service) return;
    const start = new Date(bookingResult.startTimeUtc);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const ref = formatNailiqBookingRef(bookingResult.bookingId);
    const staffBit =
      bookingResult.staffName.trim().length > 0
        ? `\nProfessional: ${bookingResult.staffName}`
        : "";
    const icsBody = generateBookingCalendarIcs({
      title: `${service.name} — ${shopLabel}`,
      description: `Booking reference: ${ref}\nSalon: ${shopLabel}${staffBit}`,
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
    if (!name || !phone) {
      setError(t.submitError);
      return;
    }

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
      });
      setBookingResult({
        bookingId: result.bookingId,
        startTimeUtc: result.startTimeUtc,
        staffName: result.staffName,
      });
      setStepDir(1);
      setStep("done");
    } catch (err) {
      if (err instanceof BookingConflictError) {
        setError(t.slotTakenError);
        setStep("time");
      } else if (
        err instanceof Error &&
        err.message === "cannot_book_past"
      ) {
        setError(t.pastTimeError);
        setStep("time");
      } else {
        setError(t.submitError);
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    clientName,
    clientPhone,
    selectedDate,
    serviceId,
    staffId,
    timeSlot,
    shopSlug,
    t.pastTimeError,
    t.slotTakenError,
    t.submitError,
  ]);

  const confirmInputsInvalid = !clientName.trim() || !clientPhone.trim();

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
    submitting,
    error,
    bookingResult,
    service,
    staffSummaryLabel,
    confirmTimeLabel,
    setServiceId,
    setStaffId,
    setSelectedDate,
    setTimeSlot,
    setClientName,
    setClientPhone,
    setError,
    goServiceNext,
    goStaffNext,
    goDateNext,
    goTimeNext,
    resetAfterDone,
    handleAddToCalendar,
    onConfirm,
    confirmInputsInvalid,
    backToService,
    backToStaff,
    backToDate,
    backToTime,
  };
}
