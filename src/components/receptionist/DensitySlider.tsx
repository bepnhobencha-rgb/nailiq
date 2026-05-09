"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/Button";
import { updateDashboardDensity } from "@/shared/dashboard/salonOwnerActions";
import {
  DENSITY_LEVELS,
  type DensityLevel,
} from "@/shared/dashboard/dashboardDensity";
import { motion, useReducedMotion } from "@/shared/lib/motionClient";
import { cn } from "@/shared/lib/cn";

/**
 * Salon-wide density selector — Simple ↔ Balanced ↔ Pro.
 *
 * Reuses `Button` from `src/components/ui/` for each segment per
 * `COMPONENT_RULES.md §1` reuse-order; no new primitive. The active
 * segment uses a Framer Motion sliding indicator (200ms = `normal`
 * per `ANIMATION_RULES.md §2`) that respects `useReducedMotion`
 * (instant swap fallback).
 *
 * Mounts in the desk top bar near the Customize / preset chrome.
 * Server gate is owner-only (matches `updateDashboardPreset` pattern);
 * the slider is rendered to all roles for visibility but rejects
 * non-owner saves with a localized failure toast handled by the
 * caller via `onError`.
 *
 * Density value is **optimistic** — local state flips immediately,
 * server reconciliation happens via `useTransition`. On failure the
 * caller restores the previous value via `onError`.
 */

const DURATION_NORMAL_SEC = 0.2; // ANIMATION_RULES `normal` token (200ms).

export interface DensitySliderProps {
  slug: string;
  /** Current density (server-truth). */
  value: DensityLevel;
  /** Localized labels. */
  labels: {
    label: string;
    simple: string;
    balanced: string;
    pro: string;
    ariaLabel: string;
    updated: (label: string) => string;
    updateFailed: string;
  };
  /** Optimistic write succeeded — caller re-renders with new value. */
  onChanged: (next: DensityLevel) => void;
  /** Server rejected (forbidden / invalid / server_error). Caller surfaces toast. */
  onError: (message: string) => void;
}

export function DensitySlider({
  slug,
  value,
  labels,
  onChanged,
  onError,
}: DensitySliderProps) {
  const reduced = useReducedMotion();
  const [isPending, startTransition] = useTransition();
  // Local optimistic value — flips immediately on click; server
  // reconciliation happens in the transition.
  const [optimistic, setOptimistic] = useState<DensityLevel>(value);

  const labelFor = (level: DensityLevel): string => {
    if (level === "simple") return labels.simple;
    if (level === "pro") return labels.pro;
    return labels.balanced;
  };

  const handleSelect = (next: DensityLevel) => {
    if (next === optimistic) return;
    const previous = optimistic;
    setOptimistic(next);
    startTransition(async () => {
      const res = await updateDashboardDensity(slug, next);
      if (!res.ok) {
        setOptimistic(previous);
        onError(labels.updateFailed);
        return;
      }
      onChanged(res.density);
    });
  };

  const activeIndex = DENSITY_LEVELS.indexOf(optimistic);

  return (
    <div
      data-testid="density-slider"
      role="radiogroup"
      aria-label={labels.ariaLabel}
      className={cn(
        "inline-flex flex-col gap-1",
        isPending && "opacity-90",
      )}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
        {labels.label}
      </span>
      <div className="relative inline-flex rounded-full border border-nq-muted/30 bg-nq-bg p-0.5">
        {/*
         * Sliding active-indicator. Width is 1/3 of the track via
         * `w-1/3`; horizontal position is the active index × 100%.
         * Reduced-motion users get an instant swap (duration 0).
         */}
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(33.333%-0.25rem)] rounded-full bg-nq-primary/15 ring-1 ring-nq-primary/40"
          initial={false}
          animate={{ x: `${activeIndex * 100}%` }}
          transition={{
            duration: reduced ? 0 : DURATION_NORMAL_SEC,
            ease: "easeOut",
          }}
        />
        {DENSITY_LEVELS.map((level) => {
          const selected = optimistic === level;
          return (
            <Button
              key={level}
              type="button"
              variant="ghost"
              size="sm"
              role="radio"
              aria-checked={selected}
              data-testid={`density-option-${level}`}
              data-active={selected ? "true" : "false"}
              disabled={isPending}
              className={cn(
                "relative z-[1] min-w-16 px-3 text-xs font-semibold tabular-nums",
                selected ? "text-nq-primary" : "text-nq-muted hover:text-nq-foreground",
              )}
              onClick={() => handleSelect(level)}
            >
              {labelFor(level)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
