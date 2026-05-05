"use client";

import { motion } from "@/shared/lib/motionClient";
import type { BookingStaffItem } from "@/shared/booking/loadBookingServices";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { cn } from "@/shared/lib/cn";
import { LuxuryBookingCta } from "@/components/booking/LuxuryBookingCta";
import {
  bookingStepVariants,
  type BookingMotionDir,
} from "@/components/booking/bookingMotion";
import { formatStaffJobRole } from "@/shared/booking/staffJobRoleLabel";
import {
  getPublicStaffDisplayName,
  isPlaceholderStaffName,
} from "@/shared/booking/publicStaffDisplay";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]!.slice(0, 1)}${parts[parts.length - 1]!.slice(0, 1)}`.toUpperCase();
  }
  const one = parts[0] ?? "?";
  return one.slice(0, 2).toUpperCase();
}

const AVATAR_TONES = [
  "bg-[#5c6bc0]/35 ring-[#5c6bc0]/45",
  "bg-[#26a69a]/35 ring-[#26a69a]/45",
  "bg-[#ef5350]/35 ring-[#ef5350]/35",
  "bg-[#ab47bc]/35 ring-[#ab47bc]/40",
  "bg-[#ffa726]/35 ring-[#ffa726]/40",
  "bg-[#42a5f5]/35 ring-[#42a5f5]/45",
];

export function BookingFlowStaffPanel({
  t,
  staff,
  staffId,
  stepDir,
  reducedMotion,
  stepTransition,
  onSelectStaffId,
  onNext,
}: {
  t: BookingMessages;
  staff: readonly BookingStaffItem[];
  staffId: string | null;
  stepDir: BookingMotionDir;
  reducedMotion: boolean;
  stepTransition: { duration: number; ease: [number, number, number, number] };
  onSelectStaffId: (id: string) => void;
  onNext: () => void;
}) {
  return (
    <motion.section
      key="staff"
      role="radiogroup"
      aria-labelledby="staff-heading"
      custom={stepDir}
      variants={bookingStepVariants}
      initial={reducedMotion ? false : "initial"}
      animate="animate"
      exit="exit"
      transition={stepTransition}
      className="will-change-transform"
    >
      <h2
        id="staff-heading"
        className="text-lg font-semibold tracking-tight text-nq-foreground sm:text-xl lg:text-[1.625rem] lg:tracking-[-0.02em]"
      >
        {t.stepStaffHeading}
      </h2>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:mt-8 lg:grid-cols-3 lg:gap-6 lg:gap-y-7">
        <motion.button
          type="button"
          data-testid="any-staff-option"
          role="radio"
          aria-checked={staffId === BOOKING_ANY_STAFF_ID}
          whileTap={{ scale: 0.99 }}
          transition={{ type: "spring", stiffness: 420, damping: 28 }}
          onClick={() => onSelectStaffId(BOOKING_ANY_STAFF_ID)}
          className={cn(
            "nq-booking-glass flex min-h-11 w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left sm:min-h-[3rem]",
            staffId !== BOOKING_ANY_STAFF_ID && "nq-booking-tile-interactive",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
            staffId === BOOKING_ANY_STAFF_ID
              ? "border border-[#D4AF37] shadow-[var(--shadow-nq-tile-selected)]"
              : "border border-white/[0.06] hover:border-white/[0.12]",
          )}
        >
          <span
            className={cn(
              "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.06] text-[13px] font-semibold text-nq-foreground ring-2 ring-white/[0.08]",
            )}
            aria-hidden
          >
            <svg
              viewBox="0 0 24 24"
              className="h-6 w-6 text-nq-muted"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
            >
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium leading-snug text-nq-foreground sm:text-base">
              {t.anyStaffOptionTitle}
            </span>
            <span className="mt-0.5 block text-sm text-nq-muted">{t.anyStaffOptionSubtitle}</span>
          </span>
        </motion.button>

        {staff.map((s, index) => {
          const selected = staffId === s.id;
          const tone = AVATAR_TONES[index % AVATAR_TONES.length]!;
          const placeholder = isPlaceholderStaffName(s.name);
          const displayName = getPublicStaffDisplayName(
            s.name,
            t.staffPlaceholderName,
          );
          return (
            <motion.button
              key={s.id}
              type="button"
              data-testid="staff-item"
              role="radio"
              aria-checked={selected}
              whileTap={{ scale: 0.99 }}
              transition={{ type: "spring", stiffness: 420, damping: 28 }}
              onClick={() => onSelectStaffId(s.id)}
              className={cn(
                "nq-booking-glass flex min-h-11 w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left sm:min-h-[3rem]",
                !selected && "nq-booking-tile-interactive",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg",
                selected
                  ? "border border-[#D4AF37] shadow-[var(--shadow-nq-tile-selected)]"
                  : "border border-white/[0.06] hover:border-white/[0.12]",
              )}
            >
              <span
                className={cn(
                  "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold tracking-tight text-nq-foreground ring-2",
                  tone,
                )}
                aria-hidden
              >
                {placeholder ? "?" : initials(s.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-medium leading-snug text-nq-foreground sm:text-base">
                  {displayName}
                </span>
                <span className="mt-0.5 block text-sm text-nq-muted">
                  {formatStaffJobRole(s.job_role)}
                </span>
              </span>
            </motion.button>
          );
        })}
      </div>

      <div className="mt-10 flex justify-end lg:mt-12">
        <LuxuryBookingCta disabled={!staffId} onClick={onNext}>
          {t.next}
        </LuxuryBookingCta>
      </div>
    </motion.section>
  );
}
