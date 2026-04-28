"use client";

import confetti from "canvas-confetti";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { getServiceById, type BookingServiceItem } from "@/shared/booking/catalog";
import {
  BookingConflictError,
  submitPublicBooking,
} from "@/shared/booking/submitPublicBooking";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";
import { colors } from "@/shared/theme/tokens";

type Step = "service" | "time" | "confirm" | "done";

/** Confetti accents: primary palette + deeper gold accent (booking success only). */
const BOOKING_CONFETTI_COLORS = [
  colors.primary,
  colors.primarySoft,
  "#B8960C",
];

type BookingFlowProps = {
  t: BookingMessages;
  shopSlug: string;
  services: readonly BookingServiceItem[];
  timeSlots: readonly string[];
};

function decodeShop(shop: string) {
  try {
    return decodeURIComponent(shop);
  } catch {
    return shop;
  }
}

function escapeIcsText(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

function utcToIcsUtc(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function generateBookingCalendarIcs(args: {
  title: string;
  description: string;
  location: string;
  start: Date;
  end: Date;
  eventUid: string;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "PRODID:-//NailIQ//Public Booking//EN",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(args.eventUid)}`,
    `DTSTAMP:${utcToIcsUtc(new Date())}`,
    `DTSTART:${utcToIcsUtc(args.start)}`,
    `DTEND:${utcToIcsUtc(args.end)}`,
    `SUMMARY:${escapeIcsText(args.title)}`,
    `DESCRIPTION:${escapeIcsText(args.description)}`,
    `LOCATION:${escapeIcsText(args.location)}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

export function BookingFlow({
  t,
  shopSlug,
  services,
  timeSlots,
}: BookingFlowProps) {
  const shopLabel = useMemo(() => decodeShop(shopSlug), [shopSlug]);

  const [step, setStep] = useState<Step>("service");
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [timeSlot, setTimeSlot] = useState<string | null>(null);
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bookingResult, setBookingResult] = useState<
    | { bookingId: string; startTimeUtc: string }
    | null
  >(null);

  const confettiFiredRef = useRef(false);

  const service = serviceId
    ? getServiceById(services, serviceId)
    : undefined;

  useEffect(() => {
    if (step !== "done") {
      confettiFiredRef.current = false;
      return;
    }
    if (confettiFiredRef.current) {
      return;
    }
    confettiFiredRef.current = true;
    confetti({
      particleCount: 80,
      spread: 70,
      origin: { x: 0.5, y: 0.6 },
      colors: BOOKING_CONFETTI_COLORS,
      disableForReducedMotion: true,
    });
  }, [step]);

  const goServiceNext = useCallback(() => {
    if (!serviceId) {
      return;
    }
    setStep("time");
  }, [serviceId]);

  const goTimeNext = useCallback(() => {
    if (!timeSlot) {
      return;
    }
    setStep("confirm");
  }, [timeSlot]);

  const resetAfterDone = useCallback(() => {
    setStep("service");
    setBookingResult(null);
    setClientName("");
    setClientPhone("");
    setServiceId(null);
    setTimeSlot(null);
    setError(null);
  }, []);

  const handleAddToCalendar = useCallback(() => {
    if (!bookingResult || !service) {
      return;
    }
    const start = new Date(bookingResult.startTimeUtc);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const icsBody = generateBookingCalendarIcs({
      title: `${service.name} — ${shopLabel}`,
      description: `Booking reference: #${bookingResult.bookingId.slice(0, 8)}\nSalon: ${shopLabel}`,
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
      a.download = `nailiq-booking-${bookingResult.bookingId.slice(0, 8)}.ics`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }, [bookingResult, service, shopLabel]);

  const onConfirm = useCallback(async () => {
    if (!serviceId || !timeSlot) {
      return;
    }
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
      setStep("done");
    } catch (err) {
      setError(err instanceof BookingConflictError ? t.slotTakenError : t.submitError);
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

  const confirmInputsInvalid =
    !clientName.trim() || !clientPhone.trim();

  if (step === "done") {
    return (
      <div className="mt-8 space-y-6">
        <div className="flex flex-col items-center text-center">
          <div
            className="flex h-[5.25rem] w-[5.25rem] shrink-0 items-center justify-center rounded-full bg-nq-primary text-nq-bg ring-4 ring-nq-primary/25"
            aria-hidden
          >
            <svg
              className="h-11 w-11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="mt-5 text-2xl font-semibold tracking-tight text-nq-foreground">
            {t.successHeading}
          </h2>
          <p className="mt-2 max-w-md text-[15px] leading-relaxed text-nq-muted sm:text-base">
            {t.successSeeYouSoonBefore}
            <span className="text-nq-foreground">{shopLabel}</span>
          </p>
        </div>

        <div
          className="rounded-2xl border-[0.5px] border-nq-primary/35 bg-white/[0.04] px-5 py-5 backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)]"
          role="group"
          aria-labelledby="success-summary-heading"
        >
          <h3 id="success-summary-heading" className="sr-only">
            {t.stepConfirmHeading}
          </h3>
          <div className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-2.5 text-left text-[15px] sm:text-base">
            <span className="text-nq-muted">{t.summaryShop}</span>
            <span className="min-w-0 text-right font-medium text-nq-foreground tabular-nums">
              {shopLabel}
            </span>
            {service ? (
              <>
                <span className="text-nq-muted">{t.summaryService}</span>
                <span className="min-w-0 text-right text-nq-foreground">
                  {service.name}
                </span>
              </>
            ) : null}
            {timeSlot ? (
              <>
                <span className="text-nq-muted">{t.summaryTime}</span>
                <span className="min-w-0 text-right text-nq-foreground">
                  {timeSlot}
                </span>
              </>
            ) : null}
          </div>
          {bookingResult ? (
            <p className="mt-5 border-t border-white/[0.08] pt-4 text-sm text-nq-muted">
              <span className="text-nq-muted">{t.bookingReferenceLabel}: </span>
              <span className="font-mono text-nq-primary">
                #{bookingResult.bookingId.slice(0, 8)}
              </span>
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="w-full shrink-0 border border-nq-primary/50 bg-transparent text-nq-primary shadow-none hover:bg-nq-primary/[0.06] hover:opacity-100 sm:min-w-[11rem]"
            onClick={handleAddToCalendar}
          >
            {t.addToCalendar}
          </Button>
          <Button
            type="button"
            size="lg"
            className="w-full bg-nq-primary text-nq-bg shadow-none hover:bg-nq-primary-soft hover:text-nq-bg sm:min-w-[11rem]"
            onClick={resetAfterDone}
          >
            {t.doneCta}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      {step === "service" && (
        <section aria-labelledby="svc-heading">
          <h2
            id="svc-heading"
            className="text-base font-medium text-nq-foreground"
          >
            {t.stepServiceHeading}
          </h2>
          <fieldset className="mt-3 space-y-2">
            <legend className="sr-only">{t.stepServiceHeading}</legend>
            {services.map((s) => (
              <label
                key={s.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-nq-border px-3 py-2 text-nq-foreground has-[:checked]:border-nq-primary/60"
              >
                <input
                  type="radio"
                  name="service"
                  value={s.id}
                  className="text-nq-primary"
                  checked={serviceId === s.id}
                  onChange={() => {
                    setServiceId(s.id);
                  }}
                />
                <span>{s.name}</span>
              </label>
            ))}
          </fieldset>
          <div className="mt-4">
            <Button
              type="button"
              className="w-full"
              size="lg"
              disabled={!serviceId}
              onClick={goServiceNext}
            >
              {t.next}
            </Button>
          </div>
        </section>
      )}

      {step === "time" && (
        <section aria-labelledby="time-heading">
          <h2
            id="time-heading"
            className="text-base font-medium text-nq-foreground"
          >
            {t.stepTimeHeading}
          </h2>
          <fieldset className="mt-3 space-y-2">
            <legend className="sr-only">{t.stepTimeHeading}</legend>
            {timeSlots.map((slot) => (
              <label
                key={slot}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-nq-border px-3 py-2 text-nq-foreground has-[:checked]:border-nq-primary/60"
              >
                <input
                  type="radio"
                  name="time"
                  value={slot}
                  className="text-nq-primary"
                  checked={timeSlot === slot}
                  onChange={() => {
                    setTimeSlot(slot);
                  }}
                />
                <span>{slot}</span>
              </label>
            ))}
          </fieldset>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:gap-3">
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={() => {
                setStep("service");
              }}
            >
              {t.back}
            </Button>
            <Button
              type="button"
              className="w-full"
              size="lg"
              disabled={!timeSlot}
              onClick={goTimeNext}
            >
              {t.next}
            </Button>
          </div>
        </section>
      )}

      {step === "confirm" && service && timeSlot && (
        <div className="flex min-h-[100dvh] min-h-[100svh] flex-col">
          <section
            aria-labelledby="conf-heading"
            className="flex min-h-0 flex-1 flex-col"
          >
            <h2
              id="conf-heading"
              className="text-base font-medium text-nq-foreground"
            >
              {t.stepConfirmHeading}
            </h2>

            <div className="mt-3 shrink-0 rounded-2xl border-[0.5px] border-nq-primary/35 bg-white/[0.04] px-5 py-5 backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)]">
              <div className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-4 gap-y-3 text-[15px] sm:text-base">
                <span className="text-nq-muted">{t.summaryShop}</span>
                <span className="min-w-0 text-right font-medium text-nq-foreground tabular-nums">
                  {shopLabel}
                </span>
                <span className="text-nq-muted">{t.summaryService}</span>
                <span className="min-w-0 text-right text-nq-foreground">
                  {service.name}
                </span>
                <span className="text-nq-muted">{t.summaryTime}</span>
                <span className="min-w-0 text-right text-nq-foreground">
                  {timeSlot}
                </span>
              </div>
            </div>

            <div className="mt-6 min-h-0 flex-1 space-y-4">
              <label className="block text-sm font-medium text-nq-foreground">
                {t.clientNameLabel}
                <input
                  type="text"
                  name="clientName"
                  autoComplete="name"
                  value={clientName}
                  inputMode="text"
                  autoCorrect="off"
                  onChange={(e) => {
                    setClientName(e.target.value);
                  }}
                  className="mt-2 block min-h-[52px] w-full rounded-xl border border-white/[0.12] bg-transparent px-[14px] py-3 text-base text-nq-foreground transition-[border-color,box-shadow] duration-200 ease-out outline-none focus:border-nq-primary/60 focus:ring-[3px] focus:ring-nq-primary/12 focus:outline-none"
                />
              </label>
              <label className="block text-sm font-medium text-nq-foreground">
                {t.clientPhoneLabel}
                <input
                  type="tel"
                  name="clientPhone"
                  autoComplete="tel"
                  inputMode="tel"
                  value={clientPhone}
                  onChange={(e) => {
                    setClientPhone(e.target.value);
                  }}
                  className="mt-2 block min-h-[52px] w-full rounded-xl border border-white/[0.12] bg-transparent px-[14px] py-3 text-base text-nq-foreground transition-[border-color,box-shadow] duration-200 ease-out outline-none focus:border-nq-primary/60 focus:ring-[3px] focus:ring-nq-primary/12 focus:outline-none"
                />
              </label>
            </div>
            {error ? (
              <p className="mt-3 shrink-0 text-sm text-nq-error" role="alert">
                {error}
              </p>
            ) : null}
          </section>

            <div className="sticky bottom-0 z-10 shrink-0 border-t border-transparent bg-gradient-to-t from-nq-bg from-80% to-transparent pb-[env(safe-area-inset-bottom,0)] pt-3">
            <div className="flex flex-col gap-2 bg-nq-bg/90 backdrop-blur-sm sm:flex-row sm:gap-3">
              <Button
                type="button"
                variant="secondary"
                className="w-full shadow-none hover:opacity-100"
                disabled={submitting}
                onClick={() => {
                  setStep("time");
                  setError(null);
                }}
              >
                {t.back}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="lg"
                disabled={
                  submitting || confirmInputsInvalid
                }
                onClick={onConfirm}
                className={cn(
                  "w-full shadow-none disabled:hover:scale-100",
                  !submitting &&
                    clientName.trim() &&
                    clientPhone.trim() &&
                    "nq-booking-confirm-btn",
                )}
              >
                <span>
                  {submitting ? t.submitting : t.confirmBooking}
                </span>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
