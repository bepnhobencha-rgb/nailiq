"use client";

import { Badge } from "@/components/ui/Badge";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from "@/shared/lib/motionClient";
import { cn } from "@/shared/lib/cn";

/**
 * Receptionist connection-state banner mounted directly below the desk
 * header (above the KPI band + setup-incomplete strip).
 *
 *   - `connected`     → renders nothing (operational default)
 *   - `reconnecting`  → amber strip + Badge with subtle pulsing dot
 *   - `offline`       → red strip + Badge, no pulse (state is steady,
 *                       not transient)
 *
 * Pulse usage matches `ANIMATION_RULES.md §3` ("Badge pulse — Exceptional
 * attention for actionable or critical desk signals only"); 2.0s period
 * mirrors `BookingBlock`'s late-pulse rhythm. `useReducedMotion` skips
 * the pulse and the slide-in transition; the banner still appears via
 * an instant opacity step so the receptionist always gets the signal
 * (`COLOR_TOKENS.md §5` "never rely on hue alone" — Badge text label
 * + `aria-live="polite"` carry the message regardless of motion).
 *
 * Reuses `Badge` from `src/components/ui/` per `COMPONENT_RULES.md §1`
 * reuse-order; no new primitive.
 */

const DURATION_SLOW_SEC = 0.35; // ANIMATION_RULES `slow` token (350ms).
const PULSE_PERIOD_SEC = 2.0;

export type ConnectionState = "connected" | "reconnecting" | "offline";

export interface ConnectionBannerProps {
  state: ConnectionState;
  labels: {
    reconnecting: string;
    offline: string;
    /** "Updated {time}" — when the data was last synced from the server. */
    lastUpdated: (time: string) => string;
    /** One-click recovery button label. */
    reload: string;
  };
  /** Pre-formatted salon-local time of the last successful sync. */
  lastUpdatedLabel?: string | null;
  /** Full page reload to re-sync every widget (grid + party cards). */
  onReload?: () => void;
}

export function ConnectionBanner({
  state,
  labels,
  lastUpdatedLabel,
  onReload,
}: ConnectionBannerProps) {
  const reduced = useReducedMotion();

  const visible = state === "reconnecting" || state === "offline";
  const isReconnecting = state === "reconnecting";

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          key={state}
          data-testid={`connection-banner-${state}`}
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{
            duration: reduced ? 0 : DURATION_SLOW_SEC,
            ease: "easeOut",
          }}
          className={cn(
            "border-b px-[var(--pad-nq-section-mobile)] py-2 md:px-6",
            isReconnecting
              ? "border-nq-warning/40 bg-nq-warning/10"
              : "border-nq-error/40 bg-nq-error/10",
          )}
        >
          <div className="mx-auto flex w-full max-w-[var(--max-nq-desktop)] flex-wrap items-center justify-center gap-x-3 gap-y-1">
            <motion.div
              initial={false}
              animate={
                reduced || !isReconnecting
                  ? undefined
                  : { opacity: [0.85, 1, 0.85] }
              }
              transition={{
                duration: PULSE_PERIOD_SEC,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            >
              <Badge
                variant={isReconnecting ? "warning" : "danger"}
                state="default"
                size="sm"
                dot
              >
                {isReconnecting ? labels.reconnecting : labels.offline}
              </Badge>
            </motion.div>

            {/* Last-updated timestamp — tells the receptionist how old the
                board is while disconnected (no silent stale data). */}
            {lastUpdatedLabel ? (
              <span
                data-testid="connection-last-updated"
                className={cn(
                  "text-xs font-medium",
                  isReconnecting ? "text-nq-warning" : "text-nq-error",
                )}
              >
                {labels.lastUpdated(lastUpdatedLabel)}
              </span>
            ) : null}

            {/* One-click recovery — a full reload re-runs SSR so every widget
                (timeline grid AND party cards) re-syncs together. */}
            {onReload ? (
              <button
                type="button"
                data-testid="connection-reload"
                onClick={onReload}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-semibold transition-colors",
                  isReconnecting
                    ? "border-nq-warning/50 text-nq-warning hover:bg-nq-warning/15"
                    : "border-nq-error/50 text-nq-error hover:bg-nq-error/15",
                )}
              >
                {labels.reload}
              </button>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
