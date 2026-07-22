"use client";

import { useMemo } from "react";
import { Sparkles } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import {
  computeCriticalAlerts,
  computeNextAction,
  type CockpitActionTarget,
  type CockpitInputs,
  type CockpitLabels,
  type CriticalAlertKey,
  type NextActionKind,
} from "@/shared/dashboard/basicModeCockpit";

const TONE_CLASS = {
  danger: "border-nq-error/45 bg-nq-error/10",
  warning: "border-nq-warning/45 bg-nq-warning/10",
  info: "border-nq-primary/35 bg-nq-primary/[0.08]",
} as const;

type Props = {
  inputs: CockpitInputs;
  labels: CockpitLabels;
  heading: string;
  allClear: string;
  reasons: Record<CriticalAlertKey | NextActionKind | "all_clear", string>;
  onAction: (target: CockpitActionTarget) => void;
};

/**
 * One proactive, deterministic recommendation for the live desk.
 *
 * The bar deliberately shows only the highest-priority item: urgent alerts
 * win, then the next useful action, then a calm all-clear. It reuses the same
 * tested cockpit rules, so NailIQ never invents advice or depends on an LLM to
 * make a time-sensitive front-desk decision.
 */
export function NailiqSuggestionBar({
  inputs,
  labels,
  heading,
  allClear,
  reasons,
  onAction,
}: Props) {
  const suggestion = useMemo(() => {
    const alerts = computeCriticalAlerts(inputs, labels);
    const urgent = alerts.shown[0];
    if (urgent) {
      return {
        text: urgent.text,
        tone: urgent.tone,
        action: urgent.action,
        reason: reasons[urgent.key],
      };
    }

    const next = computeNextAction(inputs, labels);
    return next
      ? {
          text: next.text,
          tone: next.tone,
          action: next.action,
          reason: reasons[next.kind],
        }
      : {
          text: allClear,
          tone: "info" as const,
          action: null,
          reason: reasons.all_clear,
        };
  }, [allClear, inputs, labels, reasons]);

  return (
    <div
      data-testid="nailiq-suggestion-bar"
      role="status"
      className="border-b border-nq-muted/20 px-[var(--pad-nq-section-mobile)] py-2 md:px-6"
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-[var(--max-nq-desktop)] items-center gap-2.5 rounded-xl border px-3 py-2",
          TONE_CLASS[suggestion.tone],
        )}
      >
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-nq-primary/15 text-nq-primary">
          <Sparkles className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-nq-primary">
            {heading}
          </p>
          <p className="text-sm font-medium leading-snug text-nq-foreground">
            {suggestion.text}
          </p>
          <p className="mt-0.5 text-[11px] leading-snug text-nq-muted">
            {suggestion.reason}
          </p>
        </div>
        {suggestion.action ? (
          <button
            type="button"
            onClick={() => onAction(suggestion.action!.target)}
            className="min-h-9 shrink-0 rounded-lg bg-nq-primary px-3 text-xs font-semibold text-nq-bg transition-colors hover:bg-nq-primary/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/60"
          >
            {suggestion.action.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
