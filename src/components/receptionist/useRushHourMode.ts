"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Rush-hour heuristic for the front desk.
 *
 * Auto-activates when EITHER signal trips:
 *   - the walk-in queue holds 3+ customers, OR
 *   - 2+ active staff are flagged `overloaded` by the availability
 *     engine (per `OVERLOAD_QUEUE_AHEAD` / `OVERLOAD_BOOKINGS_NEXT_2H`
 *     in `availabilityEngine.ts`).
 *
 * Auto-deactivates when the queue is below 2 AND no staff is
 * overloaded — calm thresholds beat the activation thresholds so we
 * don't flip-flop on a single arrival/leave during a borderline lull.
 *
 * Receptionist override: a manual dismiss persists until the auto
 * thresholds clear and re-arm (preventing the dismiss from blocking
 * a future surge). Manual activation isn't exposed yet — keeping the
 * surface area minimal until the first salons report a need.
 */

const RUSH_QUEUE_ENTER = 3;
const RUSH_QUEUE_EXIT = 2;
const RUSH_OVERLOAD_ENTER = 2;

export type RushHourSignals = {
  /** Current waiting count from `walkinQueue.length`. */
  queueLength: number;
  /** Number of staff currently flagged `overloaded` by the engine. */
  overloadedStaffCount: number;
};

export type RushHourState = {
  /** True when the desk is currently in rush mode (auto OR manual minus dismiss). */
  active: boolean;
  /** True when auto-detection currently asserts rush. Drives the
   * "should we re-arm after a manual dismiss?" check. */
  autoActive: boolean;
  /** Manually dismissed by the receptionist this session. Cleared
   * automatically when auto-detection drops back to false. */
  dismissed: boolean;
  /** Manual override toggle; the latch the receptionist controls. */
  setDismissed: (next: boolean) => void;
};

export function useRushHourMode(signals: RushHourSignals): RushHourState {
  const autoActive = useMemo(() => {
    if (signals.queueLength >= RUSH_QUEUE_ENTER) return true;
    if (signals.overloadedStaffCount >= RUSH_OVERLOAD_ENTER) return true;
    return false;
  }, [signals.queueLength, signals.overloadedStaffCount]);

  const [dismissed, setDismissed] = useState(false);

  // Auto-clear the dismiss latch when calm thresholds hit so a later
  // surge re-shows the banner.
  useEffect(() => {
    const calm =
      signals.queueLength < RUSH_QUEUE_EXIT &&
      signals.overloadedStaffCount === 0;
    if (calm && dismissed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- ARCHITECTURE_LOCK: auto-reset dismissed state when rush subsides
      setDismissed(false);
    }
  }, [signals.queueLength, signals.overloadedStaffCount, dismissed]);

  const active = autoActive && !dismissed;

  return {
    active,
    autoActive,
    dismissed,
    setDismissed,
  };
}
