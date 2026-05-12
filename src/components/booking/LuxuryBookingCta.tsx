"use client";

import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { cn } from "@/shared/lib/cn";

export function LuxuryBookingCta({
  children,
  disabled,
  className,
  onClick,
  type = "button",
  "data-testid": dataTestId,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  className?: string;
  onClick?: () => void | Promise<void>;
  type?: "button" | "submit";
  /** Optional Playwright test selector — forwarded to the underlying
   * <motion.button>. Several callers in BookingGroupFlow pass this
   * already; without the explicit prop declaration framer-motion
   * silently dropped it (Playwright tests couldn't find the next
   * button). Forwarding here is the single source of truth. */
  "data-testid"?: string;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.button
      type={type}
      disabled={disabled}
      data-testid={dataTestId}
      onClick={() => {
        void onClick?.();
      }}
      whileTap={disabled || reduceMotion ? undefined : { scale: 0.97 }}
      transition={{
        type: "spring",
        stiffness: 520,
        damping: 29,
      }}
      className={cn(
        "nq-booking-luxury-cta inline-flex h-14 min-h-14 w-full cursor-pointer items-center justify-center px-8 text-[15px] sm:text-base lg:w-auto lg:min-w-[13rem] lg:max-w-none lg:px-10",
        "disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none motion-reduce:hover:scale-100 motion-reduce:active:scale-100",
        className,
      )}
    >
      <span>{children}</span>
    </motion.button>
  );
}
