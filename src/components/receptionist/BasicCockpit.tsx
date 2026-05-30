"use client";

import { useMemo } from "react";

import { KPIWidget } from "@/components/ui/KPIWidget";
import { cn } from "@/shared/lib/cn";
import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import {
  computeCriticalAlerts,
  computeNextAction,
  type CockpitInputs,
  type CockpitLabels,
} from "@/shared/dashboard/basicModeCockpit";

/**
 * Basic Mode "Front Desk Cockpit" header zone. Rendered in place of the full
 * KPIBar when Basic Mode is on (today + day view). Three stacked pieces:
 *
 *   1. Critical Alerts  — max 2, risk-first; never hides operational risk.
 *   2. Next Action      — single deterministic nudge; hidden entirely when
 *                         there is no useful action (no "all clear" filler).
 *   3. Now Bar          — exactly 4 scan cards (Waiting / In service /
 *                         Upcoming / Available staff). Overdue is a RISK
 *                         state → it lives in Critical Alerts, not here.
 *                         No revenue / avg-wait clutter.
 *
 * Display-only; all counts come from the server snapshot. Balanced/Advanced
 * views never mount this — they keep the existing KPIBar untouched.
 */

const WAITING_DANGER_THRESHOLD = 5;

const TONE_CARD: Record<string, string> = {
  danger: "border-nq-error/50 bg-nq-error/10",
  warning: "border-nq-warning/50 bg-nq-warning/10",
  info: "border-nq-info/50 bg-nq-info/10",
  neutral: "border-nq-muted/30 bg-nq-surface/60",
};

export type BasicCockpitProps = {
  snapshot: ReceptionistCenterData["kpiSnapshot"];
  inputs: CockpitInputs;
  labels: CockpitLabels;
  /** Count of staff currently available (status === "available"). */
  availableStaffCount: number;
  /** Now Bar tile labels. */
  nowBar: {
    waiting: string;
    inService: string;
    upcoming: string;
    availableStaff: string;
  };
  /** Section heading labels. */
  headings: {
    nextAction: string;
    alerts: string;
  };
  isLoading?: boolean;
};

export function BasicCockpit({
  snapshot,
  inputs,
  labels,
  availableStaffCount,
  nowBar,
  headings,
  isLoading = false,
}: BasicCockpitProps) {
  const nextAction = useMemo(
    () => computeNextAction(inputs, labels),
    [inputs, labels],
  );
  const alerts = useMemo(
    () => computeCriticalAlerts(inputs, labels),
    [inputs, labels],
  );

  const tiles = useMemo(
    () => [
      {
        key: "waiting",
        label: nowBar.waiting,
        value: snapshot.waitingCount,
        status:
          snapshot.waitingCount > WAITING_DANGER_THRESHOLD
            ? ("danger" as const)
            : ("default" as const),
      },
      {
        key: "in-service",
        label: nowBar.inService,
        value: snapshot.inProgressCount,
        status: "default" as const,
      },
      {
        key: "upcoming",
        label: nowBar.upcoming,
        value: snapshot.comingUpCount,
        status: "default" as const,
      },
      {
        key: "available-staff",
        label: nowBar.availableStaff,
        value: availableStaffCount,
        status: "default" as const,
      },
    ],
    [snapshot, nowBar, availableStaffCount],
  );

  return (
    <div
      data-testid="basic-cockpit"
      className="border-b border-nq-muted/20 bg-nq-surface/60 px-[var(--pad-nq-section-mobile)] py-3 md:px-6"
    >
      <div className="mx-auto flex w-full max-w-[var(--max-nq-desktop)] flex-col gap-3">
        {/* Critical Alerts — max 2 */}
        {alerts.length > 0 ? (
          <div
            data-testid="basic-cockpit-alerts"
            className="flex flex-col gap-2 sm:flex-row"
            aria-label={headings.alerts}
          >
            {alerts.map((a) => (
              <div
                key={a.key}
                data-testid={`basic-alert-${a.key}`}
                className={cn(
                  "flex-1 rounded-lg border px-3 py-2 text-sm font-medium text-nq-foreground",
                  a.tone === "danger"
                    ? "border-nq-error/50 bg-nq-error/15"
                    : "border-nq-warning/50 bg-nq-warning/15",
                )}
              >
                <span aria-hidden className="mr-1.5">
                  {a.tone === "danger" ? "⚠" : "•"}
                </span>
                {a.text}
              </div>
            ))}
          </div>
        ) : null}

        {/* Next Action — single deterministic card. Hidden entirely when
            there is no useful action (no neutral "all clear" filler). */}
        {nextAction ? (
          <div
            data-testid="basic-cockpit-next-action"
            className={cn(
              "rounded-lg border px-3.5 py-2.5",
              TONE_CARD[nextAction.tone] ?? TONE_CARD.neutral,
            )}
          >
            <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
              {headings.nextAction}
            </p>
            <p
              data-testid={`basic-next-action-${nextAction.kind}`}
              className="mt-0.5 text-sm font-semibold text-nq-foreground"
            >
              {nextAction.text}
            </p>
          </div>
        ) : null}

        {/* Now Bar — exactly 4 cards */}
        <div
          data-testid="basic-now-bar"
          className="flex gap-3 overflow-x-auto pb-1"
        >
          {tiles.map((tile) => (
            <div
              key={tile.key}
              data-testid={`basic-now-tile-${tile.key}`}
              className="min-w-36 flex-1 shrink-0 first:pl-0 last:pr-0"
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
    </div>
  );
}

export default BasicCockpit;
