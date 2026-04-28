"use client";

import confetti from "canvas-confetti";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "@/shared/lib/motionClient";
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

type BookingWizardStep = "service" | "time" | "confirm";

const BOOKING_STEP_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

type BookingMotionCustom = number;

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
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
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

const bookingStepVariants = {
  initial: (dir: BookingMotionCustom) => ({
    x: dir * 40,
    opacity: 0,
  }),
  animate: {
    x: 0,
    opacity: 1,
  },
  exit: (dir: BookingMotionCustom) => ({
    x: dir * -40,
    opacity: 0,
  }),
};

function BookingStepper({
  activeStep,
  t,
}: {
  activeStep: BookingWizardStep;
  t: BookingMessages;
}) {
  const steps: { id: BookingWizardStep; label: string }[] = [
    { id: "service", label: t.breadcrumbServices },
    { id: "time", label: t.breadcrumbTime },
    { id: "confirm", label: t.breadcrumbConfirm },
  ];
  const activeIdx = steps.findIndex((s) => s.id === activeStep);

  return (
    <nav aria-label="Booking steps" className="mb-8 lg:mb-10">
      <ol className="flex flex-wrap items-center gap-y-3 text-[13px] font-medium sm:text-sm lg:text-[15px]">
        {steps.map((s, i) => {
          const state =
            i < activeIdx ? "complete" : i === activeIdx ? "current" : "upcoming";

          return (
            <li key={s.id} className="flex items-center">
              {i > 0 ? (
                <span
                  className="mx-3 inline text-nq-muted/35 select-none lg:mx-5"
                  aria-hidden
                >
                  /
                </span>
              ) : null}
              <span
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-2 lg:gap-2.5 lg:px-5 lg:py-2.5",
                  state === "current" &&
                    "border-nq-primary/40 bg-nq-primary/[0.09] text-nq-primary shadow-[0_0_28px_-10px_rgba(212,175,55,0.45)]",
                  state === "complete" && "border-white/[0.08] text-nq-foreground",
                  state === "upcoming" && "border-transparent text-nq-muted/50",
                )}
              >
                <span
                  className={cn(
                    "flex h-7 min-w-[1.75rem] items-center justify-center rounded-full text-[11px] font-semibold tabular-nums lg:h-8 lg:min-w-[2rem] lg:text-xs",
                    state === "current" && "bg-nq-primary text-nq-bg",
                    state === "complete" &&
                      "border border-white/[0.1] bg-white/[0.06] text-nq-primary",
                    state === "upcoming" && "bg-white/[0.04] text-nq-muted",
                  )}
                  aria-hidden
                >
                  {state === "complete" ? (
                    <svg
                      className="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  className={cn(
                    state === "current" && "font-semibold text-nq-foreground",
                    state !== "current" && "text-nq-muted",
                  )}
                >
                  {s.label}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function LuxuryBookingCta({
  children,
  disabled,
  className,
  onClick,
  type = "button",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
  onClick?: () => void | Promise<void>;
  type?: "button" | "submit";
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      type={type}
      disabled={disabled}
      onClick={() => {
        void onClick?.();
      }}
      whileTap={
        disabled || reduceMotion
          ? undefined
          : { scale: 0.97 }
      }
      transition={{
        type: "spring",
        stiffness: 520,
        damping: 29,
      }}
      className={cn(
        "nq-booking-luxury-cta inline-flex h-14 min-h-14 w-full cursor-pointer items-center justify-center px-8 text-[15px] sm:text-base lg:w-auto lg:min-w-[13rem] lg:max-w-none lg:px-10",
        "disabled:cursor-not-allowed motion-reduce:transition-none motion-reduce:hover:scale-100 motion-reduce:active:scale-100",
        className,
      )}
    >
      <span>{children}</span>
    </motion.button>
  );
}

function BookingSummaryGlass({
  t,
  shopLabel,
  serviceName,
  timeLabel,
}: {
  t: BookingMessages;
  shopLabel: string;
  serviceName: string;
  timeLabel: string;
}) {
  const rows = [
    { label: t.summaryShop, value: shopLabel, valueGold: false },
    { label: t.summaryService, value: serviceName, valueGold: false },
    { label: t.summaryTime, value: timeLabel, valueGold: true },
  ];

  return (
    <div
      className="nq-booking-glass rounded-[1.25rem] px-5 py-5 [-webkit-font-smoothing:antialiased]"
      role="group"
    >
      <div className="space-y-3.5">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] pb-3.5 text-[15px] last:border-b-0 last:pb-0 sm:text-base"
          >
            <span className="shrink-0 font-semibold text-nq-muted">
              {row.label}
            </span>
            <span
              className={cn(
                "min-w-0 shrink text-right text-[15px] font-semibold leading-snug tracking-tight sm:text-base",
                row.valueGold ? "text-nq-primary" : "text-nq-foreground",
              )}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BookingFlow({
  t,
  shopSlug,
  services,
  timeSlots,
}: BookingFlowProps) {
  const shopLabel = useMemo(() => decodeShop(shopSlug), [shopSlug]);
  const reducedMotion = useReducedMotion();

  const [step, setStep] = useState<Step>("service");
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
    setStepDir(1);
    setStep("time");
  }, [serviceId]);

  const goTimeNext = useCallback(() => {
    if (!timeSlot) {
      return;
    }
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

  const stepTransition = useMemo(
    () => ({
      duration: reducedMotion ? 0 : 0.34,
      ease: BOOKING_STEP_EASE,
    }),
    [reducedMotion],
  );

  if (step === "done") {
    return (
      <div className="mt-10 w-full space-y-8 fade-in">
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
          <h2 className="mt-5 text-[1.65rem] font-semibold tracking-tight text-nq-foreground sm:text-[1.85rem] lg:text-[2.0625rem] lg:tracking-[-0.02em]">
            {t.successHeading}
          </h2>
          <p className="mt-2 max-w-md text-[15px] leading-relaxed text-nq-muted sm:text-base">
            {t.successSeeYouSoonBefore}
            <span className="font-medium text-nq-foreground">{shopLabel}</span>
          </p>
        </div>

        <div
          className="nq-booking-glass rounded-[1.35rem] px-5 py-5"
          role="group"
          aria-labelledby="success-summary-heading"
        >
          <h3 id="success-summary-heading" className="sr-only">
            {t.stepConfirmHeading}
          </h3>
          <div className="space-y-3.5">
            <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] pb-3.5 text-[15px] sm:text-base">
              <span className="font-semibold text-nq-muted">{t.summaryShop}</span>
              <span className="min-w-0 shrink text-right font-semibold text-nq-foreground tabular-nums">
                {shopLabel}
              </span>
            </div>
            {service ? (
              <div className="flex items-baseline justify-between gap-4 border-b border-white/[0.06] pb-3.5 text-[15px] sm:text-base">
                <span className="font-semibold text-nq-muted">
                  {t.summaryService}
                </span>
                <span className="min-w-0 shrink text-right font-semibold text-nq-foreground">
                  {service.name}
                </span>
              </div>
            ) : null}
            {timeSlot ? (
              <div className="flex items-baseline justify-between gap-4 text-[15px] sm:text-base">
                <span className="font-semibold text-nq-muted">
                  {t.summaryTime}
                </span>
                <span className="min-w-0 shrink text-right font-semibold text-nq-primary">
                  {timeSlot}
                </span>
              </div>
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

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center lg:justify-end lg:gap-4">
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="nq-booking-glass w-full shrink-0 border border-nq-primary/35 bg-transparent text-nq-primary shadow-none hover:bg-white/[0.04] hover:opacity-100 sm:min-w-[11rem] lg:w-auto"
            onClick={handleAddToCalendar}
          >
            {t.addToCalendar}
          </Button>
          <LuxuryBookingCta className="lg:min-w-[11rem]" onClick={resetAfterDone}>
            {t.doneCta}
          </LuxuryBookingCta>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-8 w-full">
      <BookingStepper activeStep={step} t={t} />
      <AnimatePresence mode="wait" custom={stepDir}>
          {step === "service" && (
            <motion.section
              key="service"
              role="group"
              aria-labelledby="svc-heading"
              custom={stepDir}
              variants={bookingStepVariants}
              initial={reducedMotion ? false : "initial"}
              animate="animate"
              exit="exit"
              transition={stepTransition}
              className="will-change-transform"
            >
              <h2
                id="svc-heading"
                className="text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
              >
                {t.stepServiceHeading}
              </h2>

              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:mt-8 lg:grid-cols-3 lg:gap-6 lg:gap-y-7">
                {services.map((s) => {
                  const selected = serviceId === s.id;
                  const durationText =
                    s.totalMinutes > 0
                      ? `${s.totalMinutes} ${t.minuteSuffixShort}`
                      : t.serviceDurationFlexible;

                  return (
                    <motion.button
                      key={s.id}
                      type="button"
                      whileTap={{ scale: 0.99 }}
                      transition={{
                        type: "spring",
                        stiffness: 420,
                        damping: 28,
                      }}
                      aria-pressed={selected}
                      onClick={() => {
                        setServiceId(s.id);
                      }}
                      className={cn(
                        "nq-booking-glass flex w-full min-h-[4.5rem] items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-left sm:min-h-[5rem] sm:px-5",
                        !selected && "nq-booking-tile-interactive",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
                        selected
                          ? "border border-[#D4AF37] shadow-[var(--shadow-nq-tile-selected)]"
                          : "border border-white/[0.06] hover:border-white/[0.12]",
                      )}
                    >
                      <span className="min-w-0 flex-1 text-[15px] font-medium leading-snug tracking-tight text-nq-foreground sm:text-base">
                        {s.name}
                      </span>
                      <div className="shrink-0 text-right">
                        <span className="block text-sm font-medium tabular-nums tracking-tight text-nq-muted sm:text-[15px]">
                          {durationText}
                        </span>
                        {s.priceDisplay ? (
                          <span className="mt-1 block text-sm font-semibold tabular-nums text-nq-primary sm:text-[15px]">
                            {s.priceDisplay}
                          </span>
                        ) : null}
                      </div>
                    </motion.button>
                  );
                })}
              </div>

              <div className="mt-10 flex justify-end lg:mt-12">
                <LuxuryBookingCta
                  disabled={!serviceId}
                  onClick={goServiceNext}
                >
                  {t.next}
                </LuxuryBookingCta>
              </div>
            </motion.section>
          )}

          {step === "time" && (
            <motion.section
              key="time"
              role="group"
              aria-labelledby="time-heading"
              custom={stepDir}
              variants={bookingStepVariants}
              initial={reducedMotion ? false : "initial"}
              animate="animate"
              exit="exit"
              transition={stepTransition}
              className="will-change-transform"
            >
              <h2
                id="time-heading"
                className="text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
              >
                {t.stepTimeHeading}
              </h2>

              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:mt-8 lg:grid-cols-3 lg:gap-5">
                {timeSlots.map((slot) => {
                  const selected = timeSlot === slot;
                  return (
                    <motion.button
                      key={slot}
                      type="button"
                      whileTap={{ scale: 0.99 }}
                      transition={{
                        type: "spring",
                        stiffness: 420,
                        damping: 28,
                      }}
                      aria-pressed={selected}
                      onClick={() => {
                        setTimeSlot(slot);
                      }}
                      className={cn(
                        "nq-booking-glass min-h-[3.25rem] rounded-2xl px-3 py-3 text-center text-sm font-medium tracking-tight text-nq-foreground sm:min-h-[3.5rem] sm:text-[15px]",
                        !selected && "nq-booking-tile-interactive",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
                        selected
                          ? "border border-[#D4AF37] shadow-[var(--shadow-nq-tile-selected)]"
                          : "border border-white/[0.06] hover:border-white/[0.12]",
                      )}
                    >
                      {slot}
                    </motion.button>
                  );
                })}
              </div>

              <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:gap-4 lg:mt-12 lg:items-center lg:justify-between">
                <Button
                  type="button"
                  variant="secondary"
                  className="nq-booking-glass h-14 min-h-14 w-full shrink-0 border border-white/[0.08] text-nq-primary shadow-none hover:bg-white/[0.04] sm:w-auto sm:min-w-[8.5rem]"
                  onClick={() => {
                    setStepDir(-1);
                    setStep("service");
                  }}
                >
                  {t.back}
                </Button>
                <div className="flex w-full justify-end sm:flex-1">
                  <LuxuryBookingCta
                    disabled={!timeSlot}
                    onClick={goTimeNext}
                  >
                    {t.next}
                  </LuxuryBookingCta>
                </div>
              </div>
            </motion.section>
          )}

          {step === "confirm" && service && timeSlot && (
            <motion.div
              key="confirm"
              custom={stepDir}
              variants={bookingStepVariants}
              initial={reducedMotion ? false : "initial"}
              animate="animate"
              exit="exit"
              transition={stepTransition}
              className="flex min-h-[min(100dvh,920px)] flex-col will-change-transform sm:min-h-[70vh] lg:min-h-[min(88dvh,880px)]"
            >
              <section
                aria-labelledby="conf-heading"
                className="flex min-h-0 flex-1 flex-col"
              >
                <h2
                  id="conf-heading"
                  className="text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
                >
                  {t.stepConfirmHeading}
                </h2>

                <div className="mt-5 shrink-0">
                  <BookingSummaryGlass
                    t={t}
                    shopLabel={shopLabel}
                    serviceName={service.name}
                    timeLabel={timeSlot}
                  />
                </div>

                <div className="mt-8 min-h-0 flex-1 space-y-6">
                  <div>
                    <label
                      htmlFor="booking-client-name"
                      className="mb-2 block text-[13px] font-medium tracking-wide text-nq-muted sm:text-sm"
                      style={{ fontFamily: "system-ui, -apple-system, SF Pro Text, sans-serif" }}
                    >
                      {t.clientNameLabel}
                    </label>
                    <input
                      id="booking-client-name"
                      type="text"
                      name="clientName"
                      autoComplete="name"
                      value={clientName}
                      inputMode="text"
                      autoCorrect="off"
                      onChange={(e) => {
                        setClientName(e.target.value);
                      }}
                      className="nq-booking-field"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor="booking-client-phone"
                      className="mb-2 block text-[13px] font-medium tracking-wide text-nq-muted sm:text-sm"
                      style={{ fontFamily: "system-ui, -apple-system, SF Pro Text, sans-serif" }}
                    >
                      {t.clientPhoneLabel}
                    </label>
                    <input
                      id="booking-client-phone"
                      type="tel"
                      name="clientPhone"
                      autoComplete="tel"
                      inputMode="tel"
                      value={clientPhone}
                      onChange={(e) => {
                        setClientPhone(e.target.value);
                      }}
                      className="nq-booking-field"
                    />
                  </div>
                </div>
                {error ? (
                  <p className="mt-4 shrink-0 text-sm text-nq-error" role="alert">
                    {error}
                  </p>
                ) : null}
              </section>

              <div className="sticky bottom-0 z-10 shrink-0 border-t border-transparent bg-gradient-to-t from-nq-bg from-75% via-nq-bg/92 to-transparent pb-[max(env(safe-area-inset-bottom),0px)] pt-5">
                <div className="flex flex-col gap-3 bg-nq-bg/80 backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:bg-nq-bg/60">
                  <Button
                    type="button"
                    variant="secondary"
                    className="nq-booking-glass h-14 min-h-14 w-full shrink-0 border border-white/[0.08] text-nq-primary shadow-none hover:bg-white/[0.04] disabled:opacity-50 sm:w-auto sm:min-w-[8.5rem]"
                    disabled={submitting}
                    onClick={() => {
                      setStepDir(-1);
                      setStep("time");
                      setError(null);
                    }}
                  >
                    {t.back}
                  </Button>
                  <LuxuryBookingCta
                    className="lg:min-w-[14rem]"
                    disabled={submitting || confirmInputsInvalid}
                    onClick={onConfirm}
                  >
                    <span>{submitting ? t.submitting : t.confirmBooking}</span>
                  </LuxuryBookingCta>
                </div>
              </div>
            </motion.div>
          )}
      </AnimatePresence>
    </div>
  );
}
