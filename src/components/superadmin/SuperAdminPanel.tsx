"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { maskPhonePartial } from "@/shared/lib/maskPhone";
import { cn } from "@/shared/lib/cn";
import {
  loadDeletedRecordsForSalon,
  restoreSalonRecord,
  updatePlatformFlag,
  updateSalonFlags,
} from "@/shared/superadmin/superadminActions";
import {
  PLATFORM_FLAG_DESCRIPTORS,
  SUPERADMIN_FLAG_GROUPS,
  SUPERADMIN_PER_SALON_FLAGS,
  type DeletedRecord,
  type PlatformFlag,
  type PlatformFlagBadge,
  type PlatformFlagDescriptor,
  type PlatformFlagKey,
  type SuperAdminFeatureFlags,
  type SuperAdminFlagDescriptor,
  type SuperAdminFlagGroup,
  type SuperAdminFlagPhase,
  type SuperAdminPlanOverride,
  type SuperAdminSalonRow,
} from "@/shared/superadmin/superadminTypes";

type Props = {
  salons: SuperAdminSalonRow[];
  viewerEmail: string | null;
  initialPlatformFlags: PlatformFlag[];
  platformFlagsError: string | null;
};

type AdminTab = "global" | "per_salon";

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
  operations: "A · Vận hành (Operations)",
  intelligence: "B · Thông minh (Intelligence)",
  customers: "C · Khách hàng (Customers)",
  analytics: "D · Báo cáo (Analytics)",
  business: "E · Kinh doanh (Business)",
  limits: "F · Giới hạn (Limits)",
};

const PHASE_BADGE_LABEL: Record<SuperAdminFlagPhase, string | null> = {
  live: null,
  phase_2: "Phase 2",
  phase_3: "Phase 3",
};

const PLATFORM_BADGE_CLASS: Record<PlatformFlagBadge, string> = {
  danger:
    "border-nq-error/55 bg-nq-error/15 text-nq-error",
  billing:
    "border-amber-500/55 bg-amber-400/15 text-amber-700",
  sms:
    "border-sky-500/55 bg-sky-400/15 text-sky-700",
  email:
    "border-purple-500/55 bg-purple-400/15 text-purple-700",
  registration:
    "border-emerald-500/55 bg-emerald-400/15 text-emerald-700",
};

const PLATFORM_BADGE_LABEL: Record<PlatformFlagBadge, string> = {
  danger: "⚠️ DANGER",
  billing: "💰 BILLING",
  sms: "📱 SMS",
  email: "📧 EMAIL",
  registration: "🔓 REGISTRATION",
};

/**
 * E2E fixture salons leak into prod-like SuperAdmin views and dwarf
 * the real-tenant signal. Hidden by default; toggle restores them.
 */
function isTestSalon(salon: SuperAdminSalonRow): boolean {
  return salon.slug.startsWith("e2e-") || salon.name.startsWith("E2E");
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

export function SuperAdminPanel({
  salons,
  viewerEmail,
  initialPlatformFlags,
  platformFlagsError,
}: Props) {
  const [tab, setTab] = useState<AdminTab>("global");

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
          {salons.length} salons
          {viewerEmail ? <> · signed in as {viewerEmail}</> : null}
        </p>
      </header>

      <nav
        role="tablist"
        aria-label="SuperAdmin sections"
        className="mb-6 inline-flex gap-1 rounded-xl border border-nq-border/40 bg-nq-surface/40 p-1"
      >
        <TabButton active={tab === "global"} onClick={() => setTab("global")}>
          🌐 Global Flags
        </TabButton>
        <TabButton
          active={tab === "per_salon"}
          onClick={() => setTab("per_salon")}
        >
          🏪 Per-Salon
        </TabButton>
      </nav>

      {tab === "global" ? (
        <GlobalFlagsTab
          initialFlags={initialPlatformFlags}
          loadError={platformFlagsError}
        />
      ) : (
        <PerSalonTab salons={salons} />
      )}
    </main>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-lg px-4 py-2 text-sm font-semibold transition-colors",
        active
          ? "bg-nq-primary/15 text-nq-primary"
          : "text-nq-muted hover:bg-nq-surface/60 hover:text-nq-foreground",
      )}
    >
      {children}
    </button>
  );
}

/* ───────────────────────── Global Flags Tab ───────────────────────── */

function GlobalFlagsTab({
  initialFlags,
  loadError,
}: {
  initialFlags: PlatformFlag[];
  loadError: string | null;
}) {
  if (loadError) {
    return (
      <p
        role="alert"
        className="rounded-xl border border-nq-error/40 bg-nq-error/10 px-4 py-3 text-sm text-nq-error"
      >
        Failed to load platform flags ({loadError}). Apply the
        platform_flags migration before the panel will render.
      </p>
    );
  }

  return (
    <section data-testid="superadmin-global-flags" className="space-y-3">
      <p className="text-sm text-nq-muted">
        These flags affect <strong>every salon</strong> on the platform.
        Toggling saves immediately. Dangerous flags ask for confirmation.
      </p>
      <ul className="flex flex-col gap-3">
        {PLATFORM_FLAG_DESCRIPTORS.map((descriptor) => {
          const initial = initialFlags.find((f) => f.key === descriptor.key);
          return (
            <li key={descriptor.key}>
              <PlatformFlagRow
                descriptor={descriptor}
                initialEnabled={initial?.enabled === true}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PlatformFlagRow({
  descriptor,
  initialEnabled,
}: {
  descriptor: PlatformFlagDescriptor;
  initialEnabled: boolean;
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const onToggle = (next: boolean) => {
    if (descriptor.danger && next) {
      const confirmed = window.confirm(
        `Enable "${descriptor.label}"?\n\nThis is a DANGEROUS flag. Make sure this is the right environment.`,
      );
      if (!confirmed) return;
    }
    if (descriptor.danger && !next === false) {
      // (no-op — turning OFF is always safe)
    }
    const prev = enabled;
    setEnabled(next);
    setError(null);
    startTransition(() => {
      void (async () => {
        const r = await updatePlatformFlag(descriptor.key, next);
        if (!r.ok) {
          setEnabled(prev);
          setError(r.error);
          return;
        }
        setSavedAt(Date.now());
      })();
    });
  };

  return (
    <article
      data-testid={`platform-flag-${descriptor.key}`}
      className={cn(
        "flex items-start gap-4 rounded-2xl border bg-nq-surface/40 p-4",
        descriptor.danger
          ? "border-nq-error/45"
          : "border-nq-border/40",
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={pending}
        onClick={() => onToggle(!enabled)}
        data-testid={`platform-flag-toggle-${descriptor.key}`}
        className={cn(
          "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors",
          enabled ? "bg-nq-primary" : "bg-nq-muted/40",
          pending && "opacity-60",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block h-5 w-5 transform rounded-full bg-white transition-transform",
            enabled ? "translate-x-6" : "translate-x-1",
          )}
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-nq-muted">
            {descriptor.key}
          </span>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
              PLATFORM_BADGE_CLASS[descriptor.badge],
            )}
          >
            {PLATFORM_BADGE_LABEL[descriptor.badge]}
          </span>
        </div>
        <p className="mt-1 text-sm font-semibold text-nq-foreground">
          {descriptor.label}
        </p>
        <p className="mt-0.5 text-xs text-nq-muted">{descriptor.description}</p>
        <div className="mt-2 min-h-4 text-[11px]">
          {error ? (
            <span className="text-nq-error">Save failed: {error}</span>
          ) : savedAt && Date.now() - savedAt < 2400 ? (
            <span className="text-nq-success">Saved ✓</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/* ───────────────────────── Per-Salon Tab ───────────────────────── */

function PerSalonTab({ salons }: { salons: SuperAdminSalonRow[] }) {
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
    <section data-testid="superadmin-per-salon">
      <header className="mb-5">
        <p className="text-sm text-nq-muted">
          {visibleCount} salons
          {hiddenTestCount > 0 ? (
            <> · ({hiddenTestCount} test hidden)</>
          ) : null}
        </p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
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
    </section>
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

      <DeletedRecordsSection salonId={salon.id} />

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

/**
 * Per-salon "Show deleted" expander. Lazy-loads soft-deleted services
 * + staff on first open; each row has a Restore button.
 */
function DeletedRecordsSection({ salonId }: { salonId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [records, setRecords] = useState<DeletedRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const refresh = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    startTransition(async () => {
      const result = await loadDeletedRecordsForSalon(salonId);
      setLoading(false);
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setRecords(result.records);
    });
  }, [salonId]);

  const onToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next && records.length === 0 && !loading && !loadError) {
        refresh();
      }
      return next;
    });
  }, [records.length, loading, loadError, refresh]);

  const onRestore = useCallback((rec: DeletedRecord) => {
    const key = `${rec.table}:${rec.id}`;
    setBusyKey(key);
    startTransition(async () => {
      const result = await restoreSalonRecord(rec.table, rec.id);
      setBusyKey((cur) => (cur === key ? null : cur));
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setRecords((cur) =>
        cur.filter((r) => !(r.id === rec.id && r.table === rec.table)),
      );
    });
  }, []);

  return (
    <div className="mt-4 rounded-xl border border-nq-border/30 bg-nq-bg/40 p-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-left text-xs font-semibold text-nq-muted transition-colors hover:text-nq-foreground"
      >
        <span className="uppercase tracking-[0.14em]">
          {open ? "Hide" : "Show"} deleted records
        </span>
        <span className="font-mono text-[10px] text-nq-muted/70">
          {open && records.length > 0 ? `${records.length} hidden` : null}
        </span>
      </button>

      {open ? (
        <div className="mt-3">
          {loading ? (
            <p className="text-xs text-nq-muted">Loading…</p>
          ) : loadError ? (
            <p className="text-xs text-nq-error">Error: {loadError}</p>
          ) : records.length === 0 ? (
            <p className="text-xs text-nq-muted">No deleted records.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {records.map((rec) => {
                const key = `${rec.table}:${rec.id}`;
                const busy = busyKey === key;
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-2 rounded-md border border-nq-border/40 bg-nq-surface/40 px-2.5 py-1.5"
                  >
                    <div className="min-w-0 text-xs">
                      <span className="mr-2 inline-block rounded bg-nq-surface/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-nq-muted">
                        {rec.table}
                      </span>
                      <span className="font-medium text-nq-foreground">
                        {rec.label}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => onRestore(rec)}
                    >
                      {busy ? "Restoring…" : "Restore"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

// Re-exported for tree-shake friendliness; actual usage is from
// the typed import at the top of the file.
export type { PlatformFlagKey };
