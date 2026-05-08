"use client";

import { useMemo } from "react";

import { KPIWidget, type KPIStatus } from "@/components/ui/KPIWidget";
import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import type { getUserMessages } from "@/shared/i18n/user";

/**
 * Top-of-shell KPI band for the receptionist workspace.
 *
 * Layout: a horizontally scrollable strip mounted **above** the three-zone
 * row per `docs/DASHBOARD_LAYOUT_RULES.md` §5 — never between staff and
 * cells. Composes only `KPIWidget` from `src/components/ui/`; no new
 * primitive (per `docs/COMPONENT_RULES.md` §1 / §4 reuse order).
 *
 * Visibility:
 *   - The whole band is gated by `dashboard_modules.kpi_bar` at the **call
 *     site** in `ReceptionistCenter` (mirrors the `StatusPill` pattern).
 *   - The Revenue tile is gated by `dashboard_modules.revenue_today` via
 *     the `showRevenue` prop, AND by data presence (snapshot returns
 *     `null` when the module is off).
 *
 * Status semantics (color + text label, never color-only — see
 * `COLOR_TOKENS.md` §5):
 *   - Waiting       → `danger` when `> 5`
 *   - Avg wait      → `warning` when `> 20 min`
 *   - Overdue       → `danger` when `> 0`
 *   - All others    → `default`
 */

const WAITING_DANGER_THRESHOLD = 5;
const AVG_WAIT_WARNING_MINUTES = 20;

type KpiBarMessages =
  ReturnType<typeof getUserMessages>["receptionist"]["kpiBar"];

export type KPIBarProps = {
  snapshot: ReceptionistCenterData["kpiSnapshot"];
  /** Drives the Revenue Today tile only — band itself is parent-gated. */
  showRevenue: boolean;
  /** Receptionist `kpiBar` i18n bundle from `getUserMessages(language)`. */
  messages: KpiBarMessages;
  /**
   * Render skeleton tiles in place of values. Used when the parent is
   * mid-day-switch and a stale snapshot would mislead.
   */
  isLoading?: boolean;
};

type Tile = {
  key: string;
  label: string;
  value: string | number;
  status: KPIStatus;
};

/** Locale-stable CAD formatter (whole dollars for desk scan). */
const CAD_FORMATTER = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  maximumFractionDigits: 0,
});

export function KPIBar({
  snapshot,
  showRevenue,
  messages,
  isLoading = false,
}: KPIBarProps) {
  const tiles = useMemo<Tile[]>(() => {
    const out: Tile[] = [];

    out.push({
      key: "waiting",
      label: messages.waiting,
      value: snapshot.waitingCount,
      status:
        snapshot.waitingCount > WAITING_DANGER_THRESHOLD ? "danger" : "default",
    });

    const avg = snapshot.avgWaitMinutes;
    out.push({
      key: "avg-wait",
      label: messages.avgWait,
      value: avg === null ? messages.emptyDash : messages.minutesShort(avg),
      status:
        avg !== null && avg > AVG_WAIT_WARNING_MINUTES ? "warning" : "default",
    });

    out.push({
      key: "in-service",
      label: messages.inService,
      // Real status is `in_progress`; "in service" is the localized label
      // (see `COLOR_TOKENS.md` booking-state translation).
      value: snapshot.inProgressCount,
      status: "default",
    });

    out.push({
      key: "coming-up",
      label: messages.comingUp,
      value: snapshot.comingUpCount,
      status: "default",
    });

    out.push({
      key: "overdue",
      label: messages.overdue,
      value: snapshot.overdueCount,
      status: snapshot.overdueCount > 0 ? "danger" : "default",
    });

    const next = snapshot.nextAvailableStaff;
    let nextValue: string;
    if (next === null) {
      nextValue = messages.emptyDash;
    } else if (next.minutesUntilFree === 0) {
      nextValue = messages.nextAvailableNow(next.name);
    } else {
      nextValue = `${next.name} ${messages.nextAvailableHint(next.minutesUntilFree)}`;
    }
    out.push({
      key: "next-available",
      label: messages.nextAvailable,
      value: nextValue,
      status: "default",
    });

    if (showRevenue) {
      const cents = snapshot.revenueTodayCents;
      out.push({
        key: "revenue",
        label: messages.revenueToday,
        value: cents === null ? messages.emptyDash : CAD_FORMATTER.format(cents / 100),
        status: "default",
      });
    }

    return out;
  }, [snapshot, showRevenue, messages]);

  return (
    <div
      data-testid="receptionist-kpi-bar"
      className="border-b border-nq-muted/20 bg-nq-surface/60 px-[var(--pad-nq-section-mobile)] py-3 md:px-6"
      aria-label={isLoading ? messages.loading : undefined}
    >
      <div
        className="mx-auto flex w-full max-w-[var(--max-nq-desktop)] gap-3 overflow-x-auto pb-1"
        // Horizontal scroll on narrow viewports (iPad portrait); tiles keep
        // their min-width to remain scannable rather than truncating to
        // illegibility per `DASHBOARD_LAYOUT_RULES.md` §2.
      >
        {tiles.map((tile) => (
          <div
            key={tile.key}
            data-testid={`kpi-tile-${tile.key}`}
            className="min-w-40 shrink-0 first:pl-0 last:pr-0"
          >
            <KPIWidget
              label={tile.label}
              value={tile.value}
              status={tile.status}
              isLoading={isLoading}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default KPIBar;
