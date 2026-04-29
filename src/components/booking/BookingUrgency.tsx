"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "@/shared/lib/motionClient";
import type { BookingMessages } from "@/shared/i18n/booking/en";
import { cn } from "@/shared/lib/cn";

const ROTATE_MS = 5000;

/**
 * Light social-proof strip under the returning-guest greeting (`/[slug]`).
 */
export function BookingUrgency({ t, className }: { t: BookingMessages; className?: string }) {
  const reduceMotion = useReducedMotion();
  const lines = useMemo(
    () => [t.urgencySalon24h, t.urgencyPlatformLive],
    [t.urgencyPlatformLive, t.urgencySalon24h],
  );
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % lines.length);
    }, ROTATE_MS);
    return () => window.clearInterval(id);
  }, [lines.length]);

  const dur = reduceMotion ? 0 : 0.32;

  return (
    <div
      className={cn(
        "mt-2 flex items-start gap-2 text-left lg:mt-2.5",
        className,
      )}
      aria-live="polite"
    >
      <span
        className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-nq-primary/12 text-[11px] leading-none text-nq-primary"
        aria-hidden
      >
        ✦
      </span>
      <div className="min-h-[2.75rem] min-w-0 flex-1 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={index}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : -6 }}
            transition={{ duration: dur, ease: [0.22, 1, 0.36, 1] }}
            className="text-[13px] leading-snug text-nq-muted sm:text-sm lg:text-[14px]"
          >
            {lines[index]}
          </motion.p>
        </AnimatePresence>
      </div>
    </div>
  );
}
