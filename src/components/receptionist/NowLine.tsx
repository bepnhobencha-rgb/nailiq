"use client";

import { cn } from "@/shared/lib/cn";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";

/**
 * Vertical "current time" anchor across the staff timeline rows.
 *
 * Color/treatment:
 *   - Line + glow use `--color-nq-error` (red). Gold (`--color-nq-primary`)
 *     is reserved for VIP / brand commitment / focus affordance per
 *     `COLOR_TOKENS.md §6` — NOW line is a temporal anchor, not VIP, so
 *     red is the operationally correct family (matches calendar / Gantt
 *     conventions across operational software).
 *   - Soft glow via `box-shadow` with `color-mix()` for a low-noise halo
 *     that reads at peripheral vision per `ANIMATION_RULES.md §3` ("NOW
 *     line pulse — must remain ignorable at peripheral vision").
 *
 * Motion:
 *   - Pulse opacity `0.7 → 1 → 0.7` on a 2.0s loop, matching
 *     `BookingBlock`'s `PULSE_PERIOD_SEC` (operational pulse rhythm
 *     established in PR #55).
 *   - `useReducedMotion` honored: falls back to a **static** line at
 *     full opacity per `ANIMATION_RULES.md §5` reduced-motion table for
 *     the NOW line.
 *   - Framer Motion only (`ANIMATION_RULES.md §6`); no CSS keyframes.
 *   - Module-scope constants — no raw `ms` literals in this feature
 *     component (§6 "single shared mapping" rule).
 *
 * Layout:
 *   - The line itself spans the full vertical height of the staff rows
 *     container (`inset-y-0`). The companion **time bubble** is rendered
 *     separately in the time-header strip by `StaffTimelineGrid` so it
 *     stays vertically sticky during vertical scroll.
 */

/** Periodic pulse cycle, seconds. Mirrors `BookingBlock.tsx` PULSE_PERIOD_SEC. */
const PULSE_PERIOD_SEC = 2.0;
/** Opacity floor for the pulse; floor stays high enough to keep the line readable in peripheral vision. */
const PULSE_OPACITY_MIN = 0.7;
/** Opacity ceiling for the pulse. */
const PULSE_OPACITY_MAX = 1;

export interface NowLineProps {
  /** X position in pixels relative to the timeline grid; `null` hides the line (off-grid times). */
  leftPx: number | null;
}

export function NowLine({ leftPx }: NowLineProps) {
  const reduced = useReducedMotion();

  if (leftPx === null) return null;

  return (
    <motion.div
      className={cn(
        "pointer-events-none absolute inset-y-0 z-10 w-px -translate-x-1/2",
      )}
      style={{
        left: leftPx,
        backgroundColor: "var(--color-nq-error)",
        boxShadow:
          "0 0 8px color-mix(in srgb, var(--color-nq-error) 45%, transparent)",
      }}
      initial={{ opacity: PULSE_OPACITY_MAX }}
      animate={
        reduced
          ? undefined
          : { opacity: [PULSE_OPACITY_MIN, PULSE_OPACITY_MAX, PULSE_OPACITY_MIN] }
      }
      transition={{
        duration: PULSE_PERIOD_SEC,
        repeat: Infinity,
        ease: "easeInOut",
      }}
      aria-hidden
    />
  );
}
