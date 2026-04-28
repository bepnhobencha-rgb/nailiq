"use client";

import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { cn } from "@/shared/lib/cn";

export function LuxuryBookingCta({
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
