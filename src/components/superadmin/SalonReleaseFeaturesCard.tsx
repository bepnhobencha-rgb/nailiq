"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/shared/lib/cn";
import {
  describeReleaseFeaturesForSalon,
  releaseFeatureEditableFlagKey,
  type ReleaseFeatureResolution,
  type ReleaseFeatureUiGroup,
} from "@/shared/features/featureRegistry";
import { updateSalonFlags } from "@/shared/superadmin/superadminActions";
import type { SuperAdminSalonDetail } from "@/shared/superadmin/superadminTypes";

/**
 * Resolved-release-state panel for a single salon
 * (`/superadmin/salons/[salonId]`, rendered under `SalonOverrideCard`).
 *
 * PR4a shipped this read-only. PR4b-1 makes the **jsonb-sourced** release
 * features editable in place — a toggle to force ON/OFF and a "reset to
 * default" that removes the override so the resolver falls back to the
 * registry default. Every other source stays read-only:
 *   - column (ai_voice): edit via the Overrides / Voice AI control above,
 *   - plan (reviews/photos): owned by billing — toggling would conflict,
 *   - registry-only: no per-salon override store yet (no migration).
 *
 * Writes reuse `updateSalonFlags` (same audited path as the Overrides card);
 * after a successful change we `router.refresh()` so the resolved state never
 * goes stale. Release flags answer "is this surface shipped/enabled?" — a
 * separate concern from billing (see the explicit copy below).
 */

const GROUP_META: Record<
  ReleaseFeatureUiGroup,
  { title: string; hint: string }
> = {
  base: {
    title: "Base",
    hint: "Customer-ready surfaces — default ON.",
  },
  beta: {
    title: "Beta",
    hint: "Unfinished / opt-in surfaces — default OFF.",
  },
  plan_column: {
    title: "Plan / Column-controlled",
    hint: "Resolved from the billing plan or the dedicated voice column, not the feature_flags jsonb.",
  },
};

const GROUP_ORDER: ReleaseFeatureUiGroup[] = ["base", "beta", "plan_column"];

const SOURCE_LABEL: Record<ReleaseFeatureResolution["source"], string> = {
  jsonb: "jsonb",
  column: "column",
  plan: "plan",
  registry: "registry",
};

/** Why a non-editable row is read-only — shown inline on the row. */
const READ_ONLY_REASON: Record<
  Exclude<ReleaseFeatureResolution["source"], "jsonb">,
  string
> = {
  column: "Column-controlled — edit in Overrides → Voice AI.",
  plan: "Plan-controlled — set by the billing plan.",
  registry: "Registry default — no per-salon override.",
};

export function SalonReleaseFeaturesCard({
  salon,
}: {
  salon: SuperAdminSalonDetail;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = describeReleaseFeaturesForSalon(salon);

  const runChange = useCallback(
    (
      row: ReleaseFeatureResolution,
      patch: Parameters<typeof updateSalonFlags>[1],
    ) => {
      setError(null);
      setBusyKey(row.key);
      startTransition(async () => {
        const result = await updateSalonFlags(salon.id, patch);
        if (!result.ok) {
          setError(`Save failed (${row.label}): ${result.error}`);
          setBusyKey(null);
          return;
        }
        // Re-fetch resolved state from the DB so the panel never shows a stale
        // value; clearing busyKey happens after the refresh settles.
        router.refresh();
        setBusyKey(null);
      });
    },
    [router, salon.id],
  );

  const onToggle = useCallback(
    (row: ReleaseFeatureResolution, flagKey: string) => {
      // Toggle = set the mapped key to the opposite of the resolved value.
      runChange(row, { featureFlags: { [flagKey]: !row.resolved } });
    },
    [runChange],
  );

  const onReset = useCallback(
    (row: ReleaseFeatureResolution, flagKey: string) => {
      // Reset = REMOVE the key so the resolver falls back to the registry
      // default (not set false).
      runChange(row, { featureFlagsUnset: [flagKey] });
    },
    [runChange],
  );

  return (
    <section
      data-testid="superadmin-salon-release-features"
      className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5"
    >
      <header className="mb-4">
        <h2 className="text-base font-semibold tracking-tight text-nq-foreground">
          Release features
        </h2>
        <p className="mt-0.5 text-xs text-nq-muted">
          Resolved state per surface. jsonb-sourced features are editable here;
          plan/column/registry sources are read-only.
        </p>
        <p
          data-testid="release-features-billing-note"
          className="mt-2 rounded-lg border border-nq-border/40 bg-nq-bg/40 px-3 py-2 text-xs text-nq-muted"
        >
          Release flags control product visibility, not billing.
        </p>
        {error ? (
          <p
            role="alert"
            data-testid="release-features-error"
            className="mt-2 text-xs text-nq-error"
          >
            {error}
          </p>
        ) : null}
      </header>

      <div className="space-y-3">
        {GROUP_ORDER.map((group) => (
          <FeatureGroup
            key={group}
            group={group}
            rows={groups[group]}
            busyKey={busyKey}
            pending={pending}
            onToggle={onToggle}
            onReset={onReset}
          />
        ))}
      </div>
    </section>
  );
}

function FeatureGroup({
  group,
  rows,
  busyKey,
  pending,
  onToggle,
  onReset,
}: {
  group: ReleaseFeatureUiGroup;
  rows: ReleaseFeatureResolution[];
  busyKey: string | null;
  pending: boolean;
  onToggle: (row: ReleaseFeatureResolution, flagKey: string) => void;
  onReset: (row: ReleaseFeatureResolution, flagKey: string) => void;
}) {
  const meta = GROUP_META[group];
  return (
    <section
      data-testid={`release-group-${group}`}
      className="rounded-xl border border-nq-border/35 bg-nq-bg/30 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
          {meta.title}
        </h3>
        <p className="text-[10px] leading-snug text-nq-muted/80">{meta.hint}</p>
      </div>
      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <FeatureRow
            key={row.key}
            row={row}
            busyKey={busyKey}
            pending={pending}
            onToggle={onToggle}
            onReset={onReset}
          />
        ))}
      </ul>
    </section>
  );
}

function FeatureRow({
  row,
  busyKey,
  pending,
  onToggle,
  onReset,
}: {
  row: ReleaseFeatureResolution;
  busyKey: string | null;
  pending: boolean;
  onToggle: (row: ReleaseFeatureResolution, flagKey: string) => void;
  onReset: (row: ReleaseFeatureResolution, flagKey: string) => void;
}) {
  const flagKey = releaseFeatureEditableFlagKey(row.key);
  const editable = flagKey !== null;
  const rowBusy = busyKey === row.key;
  // Disable interaction while any row's mutation is in flight to avoid
  // overlapping writes against the same salon row.
  const disabled = pending;

  return (
    <li
      data-testid={`release-feature-${row.key}`}
      data-resolved={row.resolved ? "on" : "off"}
      data-overridden={row.overridden ? "true" : "false"}
      data-editable={editable ? "true" : "false"}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border px-3 py-2 text-sm",
        row.resolved
          ? "border-nq-primary/30 bg-nq-primary/5"
          : "border-nq-border/40 bg-nq-surface/30",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="block font-medium text-nq-foreground">
            {row.label}
          </span>
          <span className="mt-0.5 block font-mono text-[10px] text-nq-muted/80">
            {row.key}
          </span>
        </div>
        {editable ? (
          <StateToggle
            featureKey={row.key}
            on={row.resolved}
            disabled={disabled}
            busy={rowBusy}
            onClick={() => onToggle(row, flagKey)}
          />
        ) : (
          <StateBadge on={row.resolved} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-nq-muted">
          default {row.defaultOn ? "ON" : "OFF"}
        </span>
        <SourceBadge source={row.source} />
        {row.overridden ? <OverrideBadge featureKey={row.key} /> : null}
        {editable && row.overridden ? (
          <button
            type="button"
            data-testid={`release-reset-${row.key}`}
            disabled={disabled}
            onClick={() => onReset(row, flagKey)}
            className={cn(
              "rounded-full border border-nq-border/50 bg-nq-bg/50 px-1.5 py-0.5 text-[10px] font-semibold text-nq-muted transition-colors hover:bg-nq-surface/60",
              disabled && "cursor-not-allowed opacity-60",
            )}
          >
            Reset to default
          </button>
        ) : null}
      </div>

      {row.source !== "jsonb" ? (
        <p className="text-[10px] leading-snug text-nq-muted/70">
          {READ_ONLY_REASON[row.source]}
        </p>
      ) : null}
    </li>
  );
}

function StateToggle({
  featureKey,
  on,
  disabled,
  busy,
  onClick,
}: {
  featureKey: string;
  on: boolean;
  disabled: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      data-testid={`release-toggle-${featureKey}`}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[10px] font-bold uppercase tracking-wide transition-colors",
        on
          ? "border-nq-success/45 bg-nq-success/15 text-nq-success"
          : "border-nq-border/50 bg-nq-bg/50 text-nq-muted hover:bg-nq-surface/60",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-2 w-2 rounded-full",
          on ? "bg-nq-success" : "bg-nq-muted/60",
        )}
      />
      {busy ? "…" : on ? "ON" : "OFF"}
    </button>
  );
}

function StateBadge({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
        on
          ? "border-nq-success/45 bg-nq-success/15 text-nq-success"
          : "border-nq-border/50 bg-nq-bg/50 text-nq-muted",
      )}
    >
      {on ? "ON" : "OFF"}
    </span>
  );
}

function SourceBadge({
  source,
}: {
  source: ReleaseFeatureResolution["source"];
}) {
  return (
    <span
      data-testid={`release-source-${source}`}
      className="rounded-full border border-nq-border/45 bg-nq-bg/55 px-1.5 py-0.5 font-mono text-[10px] text-nq-muted"
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

function OverrideBadge({ featureKey }: { featureKey: string }) {
  return (
    <span
      data-testid={`release-override-${featureKey}`}
      className="rounded-full border border-nq-primary/45 bg-nq-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-nq-primary"
    >
      Override
    </span>
  );
}
