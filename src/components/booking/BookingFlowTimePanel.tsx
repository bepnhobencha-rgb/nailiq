"use client";

import { motion } from "@/shared/lib/motionClient";
import { Button } from "@/components/ui/Button";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";

export function BookingFlowTimePanel({
  t,
  timeSlots,
  timeSlot,
  stepDir,
  reducedMotion,
  stepTransition,
  onSelectSlot,
  onBack,
  onNext,
}: {
  t: BookingMessages;
  timeSlots: readonly string[];
  timeSlot: string | null;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onSelectSlot: (slot: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
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
              onClick={() => onSelectSlot(slot)}
              className={cn(
                "nq-booking-glass min-h-[3.25rem] rounded-2xl px-3 py-3 text-center text-sm font-medium tracking-tight text-nq-foreground sm:min-h-[3.5rem] sm:text-[15px]",
                !selected && "nq-booking-tile-interactive",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
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
          className="nq-booking-glass h-14 min-h-11 w-full shrink-0 border border-white/[0.08] text-nq-primary shadow-none hover:bg-white/[0.04] sm:w-auto sm:min-w-[8.5rem]"
          onClick={onBack}
        >
          {t.back}
        </Button>
        <div className="flex w-full justify-end sm:flex-1">
          <LuxuryBookingCta disabled={!timeSlot} onClick={onNext}>
            {t.next}
          </LuxuryBookingCta>
        </div>
      </div>
    </motion.section>
  );
}
