import Link from "next/link";
import { cn } from "@/shared/lib/cn";
import { maskPhonePartial } from "@/shared/lib/maskPhone";
import { DeletedRecordsSection } from "@/components/superadmin/DeletedRecordsSection";
import { ImpersonateButton } from "@/components/superadmin/ImpersonateButton";
import { SalonOverrideCard } from "@/components/superadmin/SalonOverrideCard";
import { SalonReleaseFeaturesCard } from "@/components/superadmin/SalonReleaseFeaturesCard";
import { SquareConnectionCard } from "@/components/superadmin/SquareConnectionCard";
import type { SuperAdminSalonDetail } from "@/shared/superadmin/superadminTypes";
import type { SquareConnectionStatus } from "@/shared/superadmin/squareConnectionTypes";

/**
 * Read-only detail view for a single salon
 * (`/superadmin/salons/[salonId]`, Phase 1D).
 *
 * Sections (top to bottom):
 *   1. Breadcrumb + back link
 *   2. Header: name, slug/id, plan badges, BETA/TEST tags
 *   3. Info card: timezone, currency, phone, brand color, theme
 *   4. Stats grid: staff / services / bookings (this month + 7d)
 *   5. Overrides card (mutation surface — the only writes on this
 *      page, lifted out of the legacy SuperAdminPanel)
 *   6. Release features card (read-only resolved release-flag state —
 *      no writes; mirrors `isReleaseFeatureEnabled` for this salon)
 *   7. Deleted records expander (soft-deleted services / staff)
 *
 * Future (1E impersonation): a "Login as owner" CTA renders above
 * the overrides card. That slot is wired here so 1E only touches
 * one file.
 */
export function SalonDetailView({
  salon,
  squareConnection,
}: {
  salon: SuperAdminSalonDetail;
  squareConnection: SquareConnectionStatus | null;
}) {
  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 md:px-8">
      <nav className="mb-4 text-xs font-medium uppercase tracking-[0.14em] text-nq-muted">
        <Link
          href="/superadmin/salons"
          className="transition-colors hover:text-nq-foreground"
        >
          ← All salons
        </Link>
      </nav>

      <SalonHeader salon={salon} />

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <InfoCard salon={salon} />
        <StatsGrid salon={salon} />
      </div>

      <div className="mt-6 flex flex-col gap-5">
        <ImpersonateButton
          salonId={salon.id}
          salonName={salon.name || salon.slug}
        />
        {squareConnection ? (
          <SquareConnectionCard
            salonId={salon.id}
            salonName={salon.name || salon.slug}
            status={squareConnection}
          />
        ) : null}
        <SalonOverrideCard salon={salon} />
        <SalonReleaseFeaturesCard salon={salon} />
        <DeletedRecordsSection salonId={salon.id} />
      </div>
    </main>
  );
}

const CREATED_FORMATTER = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat("en-US", {
  numeric: "auto",
});

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return CREATED_FORMATTER.format(d);
}

function relativeFromNow(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  const diffMs = d.getTime() - Date.now();
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000));
  if (Math.abs(days) >= 1) return RELATIVE_FORMATTER.format(days, "day");
  const hours = Math.round(diffMs / (60 * 60 * 1000));
  if (Math.abs(hours) >= 1) return RELATIVE_FORMATTER.format(hours, "hour");
  const mins = Math.round(diffMs / (60 * 1000));
  return RELATIVE_FORMATTER.format(mins, "minute");
}

function SalonHeader({ salon }: { salon: SuperAdminSalonDetail }) {
  const effectivePlan = salon.plan_override ?? salon.subscription_plan ?? "free";
  const planIsOverride = salon.plan_override != null;
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-nq-foreground">
            {salon.name || "(unnamed)"}
          </h1>
          {salon.is_beta ? (
            <span className="rounded-full border border-nq-primary/40 bg-nq-primary/10 px-2 py-0.5 text-[10px] font-bold tracking-wide text-nq-primary uppercase">
              BETA
            </span>
          ) : null}
        </div>
        <p className="mt-1 break-all font-mono text-xs text-nq-muted">
          /{salon.slug} · {salon.id}
        </p>
      </div>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-bold tracking-wide uppercase",
          planIsOverride
            ? "border-nq-primary/45 bg-nq-primary/10 text-nq-primary"
            : "border-nq-border/45 bg-nq-bg/45 text-nq-muted",
        )}
      >
        {effectivePlan}
        {planIsOverride ? <span aria-hidden>★</span> : null}
      </span>
    </header>
  );
}

function InfoCard({ salon }: { salon: SuperAdminSalonDetail }) {
  const rows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "Owner phone",
      value: salon.phone ? (
        <span className="tabular-nums">{maskPhonePartial(salon.phone)}</span>
      ) : (
        "—"
      ),
    },
    {
      label: "Timezone",
      value: salon.timezone ?? "—",
    },
    {
      label: "Currency",
      value: salon.currency_code ?? "—",
    },
    {
      label: "Created",
      value: formatDate(salon.created_at),
    },
    {
      label: "Brand color",
      value: salon.brand_color ? (
        <span className="inline-flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-3.5 w-3.5 rounded-full border border-nq-border/60"
            style={{ backgroundColor: salon.brand_color }}
          />
          <span className="font-mono text-xs">{salon.brand_color}</span>
        </span>
      ) : (
        "—"
      ),
    },
    {
      label: "Theme",
      value: salon.theme_mode ?? "—",
    },
  ];

  return (
    <section className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5">
      <h2 className="text-sm font-semibold tracking-tight text-nq-foreground">
        Configuration
      </h2>
      <dl className="mt-3 grid gap-2 text-sm">
        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[100px_1fr] gap-3 border-b border-nq-border/20 pb-2 last:border-b-0 last:pb-0"
          >
            <dt className="text-xs font-medium uppercase tracking-wide text-nq-muted">
              {row.label}
            </dt>
            <dd className="text-nq-foreground">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function StatsGrid({ salon }: { salon: SuperAdminSalonDetail }) {
  const stats: Array<{
    label: string;
    value: React.ReactNode;
    sub?: string;
  }> = [
    {
      label: "Staff",
      value: salon.staff_count,
      sub: "active",
    },
    {
      label: "Services",
      value: salon.services_count,
      sub: "active",
    },
    {
      label: "Bookings",
      value: salon.bookings_this_month,
      sub: "this month",
    },
    {
      label: "Last 7d",
      value: salon.bookings_last_7d,
      sub: "bookings",
    },
  ];

  return (
    <section className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 p-5">
      <h2 className="text-sm font-semibold tracking-tight text-nq-foreground">
        Activity
      </h2>
      <p className="mt-1 text-xs text-nq-muted">
        Last booking created {relativeFromNow(salon.last_booking_created_at)}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-nq-border/30 bg-nq-bg/40 px-3 py-2.5"
          >
            <dt className="text-[10px] font-medium uppercase tracking-wide text-nq-muted">
              {s.label}
            </dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-nq-foreground">
              {s.value}
            </dd>
            {s.sub ? (
              <p className="mt-0.5 text-[10px] text-nq-muted">{s.sub}</p>
            ) : null}
          </div>
        ))}
      </dl>
    </section>
  );
}
