"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getServiceById, type BookingServiceItem } from "@/shared/booking/catalog";
import {
  BookingConflictError,
  submitPublicBooking,
} from "@/shared/booking/submitPublicBooking";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { formatNailiqBookingRef } from "@/shared/lib/formatNailiqBookingRef";
import { decodeShopSlug, generateBookingCalendarIcs } from "@/components/booking/bookingCalendar";
import { fireBookingConfetti } from "@/components/booking/bookingConfetti";

export type BookingFlowStep = "service" | "time" | "confirm" | "done";

export function useBookingFlowState(
  t: BookingMessages,
  shopSlug: string,
  services: readonly BookingServiceItem[],
) {
  const shopLabel = useMemo(() => decodeShopSlug(shopSlug), [shopSlug]);

  const [step, setStep] = useState<BookingFlowStep>("service");
  const [stepDir, setStepDir] = useState<1 | -1>(1);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [timeSlot, setTimeSlot] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookingResult, setBookingResult] = useState<{
    bookingId: string;
    startTimeUtc: string;
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

  const goServiceNext = useCallback(() => {
    if (!serviceId) return;
    setStepDir(1);
    setStep("time");
  }, [serviceId]);

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
    setTimeSlot(null);
    setError(null);
  }, []);

  const handleAddToCalendar = useCallback(() => {
    if (!bookingResult || !service) return;
    const start = new Date(bookingResult.startTimeUtc);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const ref = formatNailiqBookingRef(bookingResult.bookingId);
    const icsBody = generateBookingCalendarIcs({
      title: `${service.name} — ${shopLabel}`,
      description: `Booking reference: ${ref}\nSalon: ${shopLabel}`,
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
    if (!serviceId || !timeSlot) return;
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
        clientName: name,
        clientPhone: phone,
      });
      setBookingResult({
        bookingId: result.bookingId,
        startTimeUtc: result.startTimeUtc,
      });
      setStepDir(1);
      setStep("done");
    } catch (err) {
      setError(
        err instanceof BookingConflictError ? t.slotTakenError : t.submitError,
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    clientName,
    clientPhone,
    serviceId,
    timeSlot,
    shopSlug,
    t.slotTakenError,
    t.submitError,
  ]);

  const confirmInputsInvalid = !clientName.trim() || !clientPhone.trim();

  const backToService = useCallback(() => {
    setStepDir(-1);
    setStep("service");
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
    timeSlot,
    clientName,
    clientPhone,
    submitting,
    error,
    bookingResult,
    service,
    setServiceId,
    setTimeSlot,
    setClientName,
    setClientPhone,
    setError,
    goServiceNext,
    goTimeNext,
    resetAfterDone,
    handleAddToCalendar,
    onConfirm,
    confirmInputsInvalid,
    backToService,
    backToTime,
  };
}
