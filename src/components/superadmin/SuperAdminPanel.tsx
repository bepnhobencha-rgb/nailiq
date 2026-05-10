"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { maskPhonePartial } from "@/shared/lib/maskPhone";
import { cn } from "@/shared/lib/cn";
import { updateSalonFlags } from "@/shared/superadmin/superadminActions";
import {
  SUPERADMIN_FEATURE_FLAG_KEYS,
  type SuperAdminFeatureFlagKey,
  type SuperAdminFeatureFlags,
  type SuperAdminPlanOverride,
  type SuperAdminSalonRow,
} from "@/shared/superadmin/superadminTypes";

type Props = {
  salons: SuperAdminSalonRow[];
  viewerEmail: string | null;
};

const PLAN_OVERRIDE_OPTIONS: ReadonlyArray<{
  value: "" | "free" | "pro" | "premium";
  label: string;
}> = [
  { value: "", label: "Inherit" },
  { value: "free", label: "Free" },
  { value: "pro", label: "Pro" },
  { value: "premium", label: "Premium" },
];

const FEATURE_FLAG_LABELS: Record<SuperAdminFeatureFlagKey, string> = {
  loyalty: "Loyalty",
  reports: "Reports",
  audit_log: "Audit log",
  beta_features: "Beta features",
  unlimited_staff: "Unlimited staff",
  unlimited_services: "Unlimited services",
};

/**
 * E2E fixture salons leak into prod-like SuperAdmin views and dwarf
 * the real-tenant signal. Hidden by default; toggle restores them.
 * Heuristic: slug `e2e-*` (helpers/db.ts naming convention) or name
 * starting with `E2E` (case-sensitive — we don't want to swallow real
 * salons that happen to contain "e2e" in any other casing).
 */
function isTestSalon(salon: SuperAdminSalonRow): boolean {
  return (
    salon.slug.startsWith("e2e-") ||
    salon.name.startsWith("E2E")
  );
}

const CREATED_AT_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatCreatedAt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return CREATED_AT_FORMATTER.format(d);
}

export function SuperAdminPanel({ salons, viewerEmail }: Props) {
  const [query, setQuery] = useState("");
  const [showTestSalons, setShowTestSalons] = useState(false);

  const testCount = useMemo(
    () => salons.filter(isTestSalon).length,
    [salons],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return salons.filter((s) => {
      if (!showTestSalons && isTestSalon(s)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    });
  }, [salons, query, showTestSalons]);

  const visibleCount = filtered.length;
  const hiddenTestCount = showTestSalons ? 0 : testCount;

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10 md:px-8">
      <header className="mb-6">
        <p className="text-xs font-semibold tracking-[0.18em] text-nq-muted uppercase">
          Internal · Restricted
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          🔐 NailIQ SuperAdmin
        </h1>
        <p className="mt-2 text-sm text-nq-muted">
          {visibleCount} salons
          {hiddenTestCount > 0 ? (
            <>
              {" "}
              <span className="text-nq-muted/80">
                ({hiddenTestCount} test hidden)
              </span>
            </>
          ) : null}
          {viewerEmail ? <> · signed in as {viewerEmail}</> : null}
        </p>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="flex-1">
            <label htmlFor="superadmin-search" className="sr-only">
              Search salon name, slug, or ID
            </label>
            <input
              id="superadmin-search"
              type="search"
              placeholder="Search salon name / slug / id…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full rounded-xl border border-nq-border/50 bg-nq-bg/85 px-4 py-2.5 text-base text-nq-foreground outline-none placeholder:text-nq-muted/80 focus-visible:border-nq-primary/80 focus-visible:shadow-nq-input-focus"
            />
          </div>
          <label
            className={cn(
              "inline-flex shrink-0 cursor-pointer select-none items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors",
              showTestSalons
                ? "border-nq-error/50 bg-nq-error/10 text-nq-error"
                : "border-nq-border/50 bg-nq-surface/40 text-nq-muted hover:bg-nq-surface/60",
            )}
            title={
              showTestSalons
                ? "Including E2E test salons"
                : "Excluding E2E test salons (slug e2e-* or name E2E*)"
            }
          >
            <input
              type="checkbox"
              checked={showTestSalons}
              onChange={(e) => setShowTestSalons(e.target.checked)}
              className="size-4 cursor-pointer accent-nq-primary"
            />
            <span>Show test salons</span>
            {testCount > 0 ? (
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums",
                  showTestSalons
                    ? "bg-nq-error/20 text-nq-error"
                    : "bg-nq-surface/60 text-nq-muted",
                )}
              >
                {testCount}
              </span>
            ) : null}
          </label>
        </div>
      </header>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-nq-border/30 bg-nq-surface/40 px-4 py-6 text-center text-sm text-nq-muted">
          No salons match.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {filtered.map((salon) => (
            <li key={salon.id}>
              <SalonRow salon={salon} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

type RowDraft = {
  planOverride: "" | "free" | "pro" | "premium";
  featureFlags: SuperAdminFeatureFlags;
  isBeta: boolean;
  adminNotes: string;
};

function rowDraftFromSalon(salon: SuperAdminSalonRow): RowDraft {
  return {
    planOverride: (salon.plan_override ?? "") as RowDraft["planOverride"],
    featureFlags: { ...salon.feature_flags },
    isBeta: salon.is_beta,
    adminNotes: salon.admin_notes ?? "",
  };
}

function SalonRow({ salon }: { salon: SuperAdminSalonRow }) {
  const [draft, setDraft] = useState<RowDraft>(() => rowDraftFromSalon(salon));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedAt(Date.now());
      window.setTimeout(() => {
        setSavedAt((cur) => (cur && Date.now() - cur >= 2400 ? null : cur));
      }, 2500);
    });
  }, [draft, salon.id]);

  const phoneMasked = salon.phone ? maskPhonePartial(salon.phone) : "—";
  const inheritedPlan = salon.subscription_plan ?? "free";
  const isTest = isTestSalon(salon);

  return (
    <article className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold tracking-tight text-nq-foreground">
              {salon.name || "(unnamed)"}
            </h2>
            {isTest ? (
              <span className="rounded-full border border-nq-error/45 bg-nq-error/15 px-2 py-0.5 text-[10px] font-bold tracking-wide text-nq-error uppercase">
                TEST
              </span>
            ) : null}
          </div>
          <p className="mt-1 break-all font-mono text-xs text-nq-muted">
            /{salon.slug} · id {salon.id}
          </p>
          <p className="mt-1 text-xs text-nq-muted">
            Owner phone: <span className="tabular-nums">{phoneMasked}</span>
          </p>
          <p className="mt-1 text-xs text-nq-muted">
            Created {formatCreatedAt(salon.created_at)} ·{" "}
            <span className="tabular-nums">{salon.bookings_this_month}</span>{" "}
            booking{salon.bookings_this_month === 1 ? "" : "s"} this month
          </p>
        </div>
        {salon.is_beta ? (
          <span className="rounded-full border border-nq-primary/40 bg-nq-primary/10 px-2.5 py-0.5 text-[10px] font-bold tracking-wide text-nq-primary uppercase">
            BETA
          </span>
        ) : null}
      </header>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-nq-muted">
            Plan override
          </span>
          <select
            value={draft.planOverride}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                planOverride: e.target.value as RowDraft["planOverride"],
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
      </div>

      <fieldset className="mt-5">
        <legend className="text-xs font-medium text-nq-muted">
          Feature flags
        </legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {SUPERADMIN_FEATURE_FLAG_KEYS.map((key) => {
            const checked = Boolean(draft.featureFlags[key]);
            return (
              <label
                key={key}
                className={cn(
                  "flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                  checked
                    ? "border-nq-primary/40 bg-nq-primary/10 text-nq-foreground"
                    : "border-nq-border/40 bg-nq-surface/30 text-nq-muted hover:bg-nq-surface/50",
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      featureFlags: {
                        ...d.featureFlags,
                        [key]: e.target.checked,
                      },
                    }))
                  }
                  className="size-4 cursor-pointer accent-nq-primary"
                />
                <span>{FEATURE_FLAG_LABELS[key]}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

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
    </article>
  );
}
