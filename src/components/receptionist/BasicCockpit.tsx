"use client";

import { useMemo } from "react";

import { KPIWidget } from "@/components/ui/KPIWidget";
import { cn } from "@/shared/lib/cn";
import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import {
  computeCriticalAlerts,
  computeNextAction,
  type CockpitActionTarget,
  type CockpitInputs,
  type CockpitLabels,
} from "@/shared/dashboard/basicModeCockpit";

/**
 * Basic Mode "Front Desk Cockpit" header zone — shown in place of the full
 * KPIBar when Basic Mode is on (today + day view). Three stacked pieces:
 *
 *   1. Critical Alerts  — max 2 (+N more), risk-first; hidden when none.
 *   2. Next Action      — single deterministic nudge with an action button;
 *                         hidden entirely when there is no useful action.
 *   3. Now Bar          — 4 scan cards (Waiting / In service / Upcoming /
 *                         Available staff). Overdue is a RISK state → it
 *                         lives in Critical Alerts, never the Now Bar.
 *
 * Display-only; counts come from the server snapshot. Balanced/Advanced never
 * mount this — they keep the existing KPIBar untouched.
 */

const WAITING_DANGER_THRESHOLD = 5;

const NEXT_ACTION_TONE: Record<string, string> = {
  danger: "border-nq-error/50 bg-nq-error/10",
  warning: "border-nq-warning/50 bg-nq-warning/10",
  info: "border-nq-info/50 bg-nq-info/10",
};

export type BasicCockpitProps = {
  snapshot: ReceptionistCenterData["kpiSnapshot"];
  inputs: CockpitInputs;
  labels: CockpitLabels;
  /** Now Bar tile labels. */
  nowBar: {
    waiting: string;
    inService: string;
    upcoming: string;
    /** Hover title on the Upcoming tile clarifying the 30-min window. */
    upcomingTitle: string;
    availableStaff: string;
    /** Calm empty-state text for the Waiting tile when none are waiting. */
    noOneWaiting: string;
    /** Fallback when no staff is available. */
    noStaffAvailable: string;
  };
  headings: {
    nextAction: string;
    alerts: string;
    /** "+{n} more issues" — receives the overflow count. */
    moreIssues: (n: number) => string;
  };
  /** Fires when a Next Action / alert button is pressed. */
  onAction: (target: CockpitActionTarget) => void;
  /** Clicking the Waiting tile opens the queue (per spec). */
  onOpenQueue: () => void;
  isLoading?: boolean;
};

export function BasicCockpit({
  snapshot,
  inputs,
  labels,
  nowBar,
  headings,
  onAction,
  onOpenQueue,
  isLoading = false,
}: BasicCockpitProps) {
  // Alerts first — Next Action dedupes against the shown alert keys so the
  // same urgent issue never appears as both an alert and a Next Action.
  const alertsResult = useMemo(
    () => computeCriticalAlerts(inputs, labels),
    [inputs, labels],
  );
  const nextAction = useMemo(
    () => computeNextAction(inputs, labels, alertsResult.shown.map((a) => a.key)),
    [inputs, labels, alertsResult],
  );

  const availableStaffValue =
    inputs.availableStaffLabel ??
    inputs.availableStaffName ??
    nowBar.noStaffAvailable;

  return (
    <div
      data-testid="basic-cockpit"
      className="border-b border-nq-muted/20 bg-nq-surface/60 px-[var(--pad-nq-section-mobile)] py-3 md:px-6"
    >
      <div className="mx-auto flex w-full max-w-[var(--max-nq-desktop)] flex-col gap-3">
        {/* Critical Alerts — max 2 + "+N more" */}
        {alertsResult.shown.length > 0 ? (
          <div
            data-testid="basic-cockpit-alerts"
            className="flex flex-col gap-2"
            aria-label={headings.alerts}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              {alertsResult.shown.map((a) => (
                <div
                  key={a.key}
                  data-testid={`basic-alert-${a.key}`}
                  className={cn(
                    "flex flex-1 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium text-nq-foreground",
                    a.tone === "danger"
                      ? "border-nq-error/50 bg-nq-error/15"
                      : "border-nq-warning/50 bg-nq-warning/15",
                  )}
                >
                  <span aria-hidden>{a.tone === "danger" ? "⚠" : "•"}</span>
                  <span className="min-w-0 flex-1">{a.text}</span>
                  {a.action ? (
                    <button
                      type="button"
                      data-testid={`basic-alert-action-${a.key}`}
                      onClick={() => onAction(a.action!.target)}
                      className="shrink-0 rounded-md border border-nq-border bg-nq-surface px-2 py-1 text-xs font-semibold text-nq-foreground transition-colors hover:bg-nq-surface/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/60"
                    >
                      {a.action.label}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {alertsResult.overflowCount > 0 ? (
              <p
                data-testid="basic-alerts-overflow"
                className="text-xs font-medium text-nq-muted"
              >
                {headings.moreIssues(alertsResult.overflowCount)}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Next Action — single deterministic card with action button.
            Hidden entirely when there is no useful action. */}
        {nextAction ? (
          <div
            data-testid="basic-cockpit-next-action"
            className={cn(
              "flex items-center gap-3 rounded-lg border px-3.5 py-2",
              NEXT_ACTION_TONE[nextAction.tone] ?? NEXT_ACTION_TONE.info,
            )}
          >
            {/* Single-line feel: tiny inline heading + the action text on one row. */}
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-nq-muted">
                {headings.nextAction}
              </span>
              <span
                data-testid={`basic-next-action-${nextAction.kind}`}
                className="min-w-0 flex-1 truncate text-sm font-semibold text-nq-foreground"
              >
                {nextAction.text}
              </span>
            </div>
            {nextAction.action ? (
              <button
                type="button"
                data-testid="basic-next-action-button"
                onClick={() => onAction(nextAction.action!.target)}
                className="shrink-0 rounded-lg bg-nq-primary px-3 py-2 text-sm font-semibold text-nq-bg transition-colors hover:bg-nq-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-nq-bg"
              >
                {nextAction.action.label}
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Now Bar — exactly 4 cards */}
        <div
          data-testid="basic-now-bar"
          className="flex gap-3 overflow-x-auto pb-1"
        >
          {/* Waiting — clickable → opens queue */}
          <button
            type="button"
            data-testid="basic-now-tile-waiting"
            onClick={onOpenQueue}
            className="min-w-32 flex-1 shrink-0 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/60"
          >
            <KPIWidget
              compact
              label={nowBar.waiting}
              value={
                snapshot.waitingCount === 0
                  ? nowBar.noOneWaiting
                  : snapshot.waitingCount
              }
              status={
                snapshot.waitingCount > WAITING_DANGER_THRESHOLD
                  ? "danger"
                  : "default"
              }
              isLoading={isLoading}
            />
          </button>

          <div
            data-testid="basic-now-tile-in-service"
            className="min-w-32 flex-1 shrink-0"
          >
            <KPIWidget
              compact
              label={nowBar.inService}
              value={snapshot.inProgressCount}
              status="default"
              isLoading={isLoading}
            />
          </div>

          <div
            data-testid="basic-now-tile-upcoming"
            className="min-w-32 flex-1 shrink-0"
            title={nowBar.upcomingTitle}
          >
            <KPIWidget
              compact
              label={nowBar.upcoming}
              value={snapshot.comingUpCount}
              status="default"
              isLoading={isLoading}
            />
          </div>

          <div
            data-testid="basic-now-tile-available-staff"
            className="min-w-32 flex-1 shrink-0"
          >
            <KPIWidget
              compact
              label={nowBar.availableStaff}
              value={availableStaffValue}
              status="default"
              valueNoWrap
              isLoading={isLoading}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default BasicCockpit;
