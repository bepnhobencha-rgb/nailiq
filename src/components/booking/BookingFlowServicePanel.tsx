"use client";

import { motion } from "@/shared/lib/motionClient";
import type { BookingServiceItem } from "@/shared/booking/catalog";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";

export function BookingFlowServicePanel({
  t,
  services,
  serviceId,
  error,
  stepDir,
  reducedMotion,
  stepTransition,
  onSelectService,
  onNext,
}: {
  t: BookingMessages;
  services: readonly BookingServiceItem[];
  serviceId: string | null;
  error: string | null;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onSelectService: (id: string) => void;
  onNext: () => void;
}) {
  return (
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
              data-testid="service-item"
              whileTap={{ scale: 0.99 }}
              transition={{
                type: "spring",
                stiffness: 420,
                damping: 28,
              }}
              aria-pressed={selected}
              onClick={() => onSelectService(s.id)}
              className={cn(
                "nq-booking-glass flex w-full min-w-0 min-h-[4.5rem] items-center justify-between gap-4 rounded-2xl px-4 py-3.5 text-left sm:min-h-[5rem] sm:gap-5 sm:px-5",
                !selected && "nq-booking-tile-interactive",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
                selected
                  ? "border border-[var(--salon-primary)] shadow-[var(--shadow-nq-tile-selected)]"
                  : "border border-white/[0.06] hover:border-white/[0.12]",
              )}
            >
              <span className="min-w-0 flex-1 pr-2 text-[15px] font-medium leading-snug tracking-tight text-nq-foreground sm:text-base">
                {s.name}
              </span>
              <div className="flex shrink-0 flex-col items-end gap-1 text-right">
                <span className="text-sm font-medium tabular-nums tracking-tight text-nq-muted sm:text-[15px]">
                  {durationText}
                </span>
                {s.priceDisplay ? (
                  <span className="text-sm font-semibold tabular-nums text-[var(--salon-primary)] sm:text-[15px]">
                    {s.priceDisplay}
                  </span>
                ) : null}
              </div>
            </motion.button>
          );
        })}
      </div>

      <div className="mt-10 flex flex-col items-end gap-2 lg:mt-12">
        {error ? (
          <p
            className="self-stretch text-right text-sm text-nq-error"
            role="alert"
            data-testid="booking-service-error"
          >
            {error}
          </p>
        ) : null}
        <LuxuryBookingCta onClick={onNext}>{t.next}</LuxuryBookingCta>
      </div>
    </motion.section>
  );
}
