"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { cn } from "@/shared/lib/cn";
import { updateSalonFlags } from "@/shared/superadmin/superadminActions";
import {
  SUPERADMIN_FLAG_GROUPS,
  SUPERADMIN_PER_SALON_FLAGS,
  type SuperAdminFeatureFlags,
  type SuperAdminFlagDescriptor,
  type SuperAdminFlagGroup,
  type SuperAdminFlagPhase,
  type SuperAdminPlanOverride,
  type SuperAdminSalonRow,
} from "@/shared/superadmin/superadminTypes";

/**
 * Per-salon override controls — plan_override, beta, feature flags,
 * admin notes. Lives on `/superadmin/salons/[salonId]` (Phase 1D).
 *
 * Extracted from `SuperAdminPanel.SalonRow` (PR #82) minus the
 * salon-header section, which the detail page renders separately.
 * The save path still calls `updateSalonFlags` so server-side
 * semantics are unchanged.
 */

const PLAN_OVERRIDE_OPTIONS: ReadonlyArray<{
  value: "" | "free" | "pro" | "premium";
  label: string;
}> = [
  { value: "", label: "Inherit" },
  { value: "free", label: "Free" },
  { value: "pro", label: "Pro" },
  { value: "premium", label: "Premium" },
];

const FLAG_GROUP_LABELS: Record<SuperAdminFlagGroup, string> = {
  operations: "Operations",
  intelligence: "Intelligence",
  customers: "Customers",
  analytics: "Analytics",
  business: "Business",
  limits: "Limits",
};

const PHASE_BADGE_LABEL: Record<SuperAdminFlagPhase, string | null> = {
  live: null,
  phase_2: "Phase 2",
  phase_3: "Phase 3",
};

type Draft = {
  planOverride: "" | "free" | "pro" | "premium";
  featureFlags: SuperAdminFeatureFlags;
  isBeta: boolean;
  adminNotes: string;
  voiceAiEnabled: boolean;
};

function draftFromSalon(salon: SuperAdminSalonRow): Draft {
  return {
    planOverride: (salon.plan_override ?? "") as Draft["planOverride"],
    featureFlags: { ...salon.feature_flags },
    isBeta: salon.is_beta,
    adminNotes: salon.admin_notes ?? "",
    voiceAiEnabled: salon.voice_ai_enabled,
  };
}

export function SalonOverrideCard({
  salon,
}: {
  salon: SuperAdminSalonRow;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFromSalon(salon));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const onSave = useCallback(() => {
    setError(null);
    startTransition(async () => {
      const planOverride: SuperAdminPlanOverride =
        draft.planOverride === "" ? null : draft.planOverride;
      const result = await updateSalonFlags(salon.id, {
        planOverride,
        featureFlags: draft.featureFlags,
        isBeta: draft.isBeta,
        adminNotes: draft.adminNotes,
        voiceAiEnabled: draft.voiceAiEnabled,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedAt(Date.now());
      router.refresh();
      window.setTimeout(() => {
        setSavedAt((cur) => (cur && Date.now() - cur >= 2400 ? null : cur));
      }, 2500);
    });
  }, [draft, salon.id]);

  const inheritedPlan = salon.subscription_plan ?? "free";

  return (
    <section
      data-testid="superadmin-salon-overrides"
      className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5"
    >
      <header className="mb-4">
        <h2 className="text-base font-semibold tracking-tight text-nq-foreground">
          Overrides
        </h2>
        <p className="mt-0.5 text-xs text-nq-muted">
          Internal — customer never sees these.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-nq-muted">
            Plan override
          </span>
          <select
            value={draft.planOverride}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                planOverride: e.target.value as Draft["planOverride"],
              }))
            }
            className="rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 text-sm text-nq-foreground outline-none focus-visible:border-nq-primary/80"
          >
            {PLAN_OVERRIDE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
                {opt.value === "" ? ` (current: ${inheritedPlan})` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-nq-muted">Beta cohort</span>
          <button
            type="button"
            role="switch"
            aria-checked={draft.isBeta}
            onClick={() => setDraft((d) => ({ ...d, isBeta: !d.isBeta }))}
            className={cn(
              "self-start inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors",
              draft.isBeta
                ? "border-nq-primary/45 bg-nq-primary/15 text-nq-primary"
                : "border-nq-border/50 bg-nq-surface/40 text-nq-muted hover:bg-nq-surface/60",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "inline-block h-2 w-2 rounded-full",
                draft.isBeta ? "bg-nq-primary" : "bg-nq-muted/60",
              )}
            />
            {draft.isBeta ? "ON" : "OFF"}
          </button>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-nq-muted">Voice AI (Lily)</span>
          <button
            type="button"
            role="switch"
            aria-checked={draft.voiceAiEnabled}
            onClick={() => setDraft((d) => ({ ...d, voiceAiEnabled: !d.voiceAiEnabled }))}
            className={cn(
              "self-start inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors",
              draft.voiceAiEnabled
                ? "border-emerald-500/45 bg-emerald-500/15 text-emerald-400"
                : "border-nq-border/50 bg-nq-surface/40 text-nq-muted hover:bg-nq-surface/60",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "inline-block h-2 w-2 rounded-full",
                draft.voiceAiEnabled ? "bg-emerald-400" : "bg-nq-muted/60",
              )}
            />
            {draft.voiceAiEnabled ? "ON" : "OFF"}
          </button>
        </label>
      </div>

      <FeatureFlagsGrouped
        draft={draft.featureFlags}
        onChange={(next) => setDraft((d) => ({ ...d, featureFlags: next }))}
      />

      <label className="mt-5 block">
        <span className="text-xs font-medium text-nq-muted">Admin notes</span>
        <textarea
          value={draft.adminNotes}
          onChange={(e) =>
            setDraft((d) => ({ ...d, adminNotes: e.target.value }))
          }
          rows={2}
          maxLength={2000}
          placeholder="Internal notes (Huy-only). Customer never sees this."
          className="mt-1.5 block w-full rounded-lg border border-nq-border/50 bg-nq-bg/85 px-3 py-2 text-sm text-nq-foreground outline-none placeholder:text-nq-muted/70 focus-visible:border-nq-primary/80"
        />
      </label>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-h-5 text-xs">
          {error ? (
            <span className="text-nq-error">Save failed: {error}</span>
          ) : savedAt ? (
            <span className="text-nq-success">Saved ✓</span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={pending}
          onClick={onSave}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </section>
  );
}

function FeatureFlagsGrouped({
  draft,
  onChange,
}: {
  draft: SuperAdminFeatureFlags;
  onChange: (next: SuperAdminFeatureFlags) => void;
}) {
  return (
    <div className="mt-5">
      <p className="mb-2 text-xs font-medium text-nq-muted">Feature flags</p>
      <div className="space-y-3">
        {SUPERADMIN_FLAG_GROUPS.map((group) => {
          const items = SUPERADMIN_PER_SALON_FLAGS.filter(
            (d) => d.group === group,
          );
          return (
            <fieldset
              key={group}
              data-testid={`flag-group-${group}`}
              className="rounded-xl border border-nq-border/35 bg-nq-bg/30 p-3"
            >
              <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-nq-muted">
                {FLAG_GROUP_LABELS[group]}
              </legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {items.map((descriptor) => (
                  <FeatureFlagRow
                    key={descriptor.key}
                    descriptor={descriptor}
                    checked={Boolean(draft[descriptor.key])}
                    onChange={(next) =>
                      onChange({ ...draft, [descriptor.key]: next })
                    }
                  />
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

function FeatureFlagRow({
  descriptor,
  checked,
  onChange,
}: {
  descriptor: SuperAdminFlagDescriptor;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const phaseLabel = PHASE_BADGE_LABEL[descriptor.phase];
  const isPhased = phaseLabel !== null;
  return (
    <label
      data-testid={`flag-${descriptor.key}`}
      data-phase={descriptor.phase}
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
        checked
          ? "border-nq-primary/40 bg-nq-primary/10 text-nq-foreground"
          : "border-nq-border/40 bg-nq-surface/30 text-nq-muted hover:bg-nq-surface/50",
        isPhased && "opacity-80",
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 cursor-pointer accent-nq-primary"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{descriptor.label}</span>
          {phaseLabel ? (
            <span className="rounded-full border border-nq-muted/40 bg-nq-bg/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-nq-muted">
              {phaseLabel}
            </span>
          ) : null}
          {descriptor.danger ? (
            <span className="rounded-full border border-nq-error/45 bg-nq-error/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-nq-error">
              ⚠️
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block font-mono text-[10px] text-nq-muted/80">
          {descriptor.key}
        </span>
        <span className="mt-1 block text-[11px] leading-snug text-nq-muted">
          {descriptor.description}
        </span>
      </span>
    </label>
  );
}
