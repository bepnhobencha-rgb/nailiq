"use client";

import { useMemo } from "react";
import Link from "next/link";
import type { OwnerHomeData } from "@/shared/dashboard/loadOwnerHomeDashboardAction";
import { getUserMessages } from "@/shared/i18n/user";
import { formatCurrency, formatCurrencyOrZero } from "@/shared/lib/currencyFormat";
import { cn } from "@/shared/lib/cn";

// ─── Trend badge ────────────────────────────────────────────────────────────

function TrendBadge({
  current,
  previous,
  label,
}: {
  current: number;
  previous: number;
  label: string;
}) {
  if (previous === 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return null;
  const up = pct > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
        up
          ? "bg-nq-success/15 text-nq-success"
          : "bg-nq-error/15 text-nq-error",
      )}
      title={label}
    >
      {up ? "↑" : "↓"} {Math.abs(pct)}%
    </span>
  );
}

// ─── 30-day sparkline ───────────────────────────────────────────────────────

function Sparkline({
  data,
  className,
}: {
  data: Array<{ revenueCents: number }>;
  className?: string;
}) {
  const max = Math.max(...data.map((d) => d.revenueCents), 1);
  const W = 200;
  const H = 44;
  const PAD = 2;

  const pts = data
    .map((d, i) => {
      const x = PAD + (i / Math.max(data.length - 1, 1)) * (W - PAD * 2);
      const y = H - PAD - (d.revenueCents / max) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const fillPts = `${PAD},${H} ${pts} ${W - PAD},${H}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={cn("w-full", className)}
      aria-hidden
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={fillPts} fill="url(#sparkGrad)" className="text-nq-primary" />
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
        strokeLinecap="round"
        className="text-nq-primary"
      />
    </svg>
  );
}

// ─── Section header ─────────────────────────────────────────────────────────

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted/80">
        {subtitle}
      </p>
      <h2 className="text-base font-semibold text-nq-foreground">{title}</h2>
    </div>
  );
}

// ─── Stat card ──────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  badge,
  accent,
  large,
}: {
  label: string;
  value: string | number;
  badge?: React.ReactNode;
  accent?: boolean;
  large?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-2xl border px-4 py-3",
        accent
          ? "border-nq-primary/30 bg-nq-primary/8 ring-1 ring-inset ring-nq-primary/15"
          : "border-nq-border/40 bg-nq-surface/45",
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-nq-muted/80">
        {label}
      </p>
      <p
        className={cn(
          "font-bold tabular-nums leading-none",
          large ? "text-2xl" : "text-xl",
          accent ? "text-nq-primary" : "text-nq-foreground",
        )}
      >
        {value}
      </p>
      {badge ? <div className="mt-0.5">{badge}</div> : null}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export function OwnerHomeDashboard({
  data,
  language,
  slug,
  salonName,
  bookingAbsoluteUrl,
  lastUpdatedLabel,
  onManualRefresh,
  manualRefreshing,
}: {
  data: OwnerHomeData;
  language: "en" | "vi";
  slug: string;
  salonName: string;
  bookingAbsoluteUrl: string;
  lastUpdatedLabel: string;
  onManualRefresh: () => void;
  manualRefreshing: boolean;
}) {
  const messages = getUserMessages(language);
  const th = messages.ownerDashboard.home;
  const cc = data.currencyCode;

  const fmt = useMemo(
    () => (cents: number) => formatCurrencyOrZero(cents, cc),
    [cc],
  );

  const fmtMaybe = useMemo(
    () => (cents: number) => formatCurrency(cents, cc) ?? "—",
    [cc],
  );

  // Week-over-week trend helpers
  const weekRevTrend = (
    <TrendBadge
      current={data.weekRevenueCents}
      previous={data.lastWeekRevenueCents}
      label={th.vsLastWeek}
    />
  );
  const weekBkgTrend = (
    <TrendBadge
      current={data.weekBookings}
      previous={data.lastWeekBookings}
      label={th.vsLastWeek}
    />
  );

  // Date display
  const todayFormatted = useMemo(() => {
    const [y, m, d] = data.todayYmd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(
      language === "vi" ? "vi-VN" : "en-US",
      { weekday: "long", month: "long", day: "numeric" },
    );
  }, [data.todayYmd, language]);

  const noShowPct =
    data.noShowRateThisWeek > 0
      ? `${Math.round(data.noShowRateThisWeek * 100)}%`
      : "0%";

  return (
    <div className="flex flex-col gap-5 pb-8">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted/70">
            {todayFormatted}
          </p>
          <h1 className="mt-0.5 text-2xl font-bold tracking-tight text-nq-foreground lg:text-3xl">
            {salonName}
          </h1>
          <a
            href={bookingAbsoluteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-xs text-nq-primary underline-offset-2 hover:underline"
          >
            {th.bookingLink} ↗
          </a>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 pt-1">
          <p className="text-[11px] tabular-nums text-nq-muted">{lastUpdatedLabel}</p>
          <button
            type="button"
            onClick={onManualRefresh}
            disabled={manualRefreshing}
            className="inline-flex min-h-9 touch-manipulation items-center gap-1 rounded-lg border border-nq-border/45 bg-nq-surface/45 px-2.5 py-1 text-xs font-semibold text-nq-foreground transition-colors hover:bg-nq-surface/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45 disabled:opacity-55"
            aria-busy={manualRefreshing}
          >
            <span
              className={cn(
                "inline-block text-base leading-none",
                manualRefreshing && "animate-spin",
              )}
              aria-hidden
            >
              ↻
            </span>
            {th.refresh}
          </button>
        </div>
      </div>

      {/* ── Minh pending approvals ───────────────────────────────────── */}
      {data.pendingApprovalsCount > 0 ? (
        <Link
          href={`/dashboard/${slug}/ai-manager`}
          className="flex items-center justify-between gap-3 rounded-2xl border border-nq-primary/35 bg-nq-primary/8 px-4 py-3 ring-1 ring-inset ring-nq-primary/15 transition hover:bg-nq-primary/12"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-lg" aria-hidden>🤖</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-nq-foreground">
                {th.minhTitle}
              </p>
              <p className="text-xs text-nq-primary font-medium">
                {th.minhPendingApprovals.replace(
                  "{n}",
                  String(data.pendingApprovalsCount),
                )}
              </p>
            </div>
          </div>
          <span className="shrink-0 rounded-lg bg-nq-primary px-2.5 py-1 text-xs font-semibold text-white">
            {th.minhViewAll}
          </span>
        </Link>
      ) : null}

      {/* ── Today's Pulse ────────────────────────────────────────────── */}
      <section aria-label={th.today}>
        <SectionHeader title={th.today} subtitle={th.todaySubtitle} />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <StatCard
            label={th.totalBookings}
            value={data.todayTotal}
            badge={weekBkgTrend}
            accent={data.todayTotal > 0}
          />
          <StatCard label={th.confirmed} value={data.todayConfirmed} />
          <StatCard label={th.completed} value={data.todayCompleted} />
          <StatCard
            label={th.revenue}
            value={fmt(data.todayRevenueCents)}
            badge={weekRevTrend}
            large
          />
        </div>
        {data.todayNoShows > 0 ? (
          <p className="mt-2 text-[12px] text-nq-error/80">
            ⚠ {th.noShows}: {data.todayNoShows}
          </p>
        ) : null}
      </section>

      {/* ── 30-day Sparkline + Month KPIs ────────────────────────────── */}
      <section aria-label={th.last30Days}>
        <SectionHeader title={th.monthTitle} subtitle={th.last30Days} />
        <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/45 px-4 pb-3 pt-4">
          <div className="mb-3 flex items-end justify-between gap-4">
            <div>
              <p className="text-2xl font-bold tabular-nums text-nq-foreground">
                {fmt(data.monthRevenueCents)}
              </p>
              <p className="mt-0.5 text-xs text-nq-muted">
                {th.monthBookings.replace("{n}", String(data.monthBookings))}
              </p>
            </div>
            <TrendBadge
              current={data.weekRevenueCents}
              previous={data.lastWeekRevenueCents}
              label={th.vsLastWeek}
            />
          </div>
          <div className="h-11 text-nq-primary">
            <Sparkline data={data.dailyRevenue} className="h-full" />
          </div>
          <p className="mt-1 text-[10px] text-nq-muted/60 text-right">
            {data.dailyRevenue[0]?.date} → {data.dailyRevenue[29]?.date}
          </p>
        </div>
      </section>

      {/* ── Top Services + Staff ─────────────────────────────────────── */}
      <section
        aria-label={`${th.topServicesTitle} & ${th.staffTitle}`}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        {/* Top Services */}
        <div>
          <SectionHeader
            title={th.topServicesTitle}
            subtitle={th.thisMonth}
          />
          <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/45 overflow-hidden">
            {data.topServices.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-nq-muted">
                {th.topServicesEmpty}
              </p>
            ) : (
              <ul>
                {data.topServices.map((svc, i) => (
                  <li
                    key={svc.name + i}
                    className={cn(
                      "flex items-center justify-between gap-3 px-4 py-3",
                      i !== 0 && "border-t border-nq-border/25",
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-nq-primary/15 text-[10px] font-bold text-nq-primary">
                        {i + 1}
                      </span>
                      <p className="truncate text-sm font-medium text-nq-foreground">
                        {svc.name}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-semibold tabular-nums text-nq-foreground">
                        {th.bookingsCount.replace("{n}", String(svc.count))}
                      </p>
                      <p className="text-[11px] tabular-nums text-nq-muted">
                        {fmtMaybe(svc.revenueCents)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Staff Leaderboard */}
        <div>
          <SectionHeader title={th.staffTitle} subtitle={th.thisMonth} />
          <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/45 overflow-hidden">
            {data.topStaff.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-nq-muted">
                {th.staffEmpty}
              </p>
            ) : (
              <ul>
                {data.topStaff.map((s, i) => (
                  <li
                    key={s.name + i}
                    className={cn(
                      "flex items-center justify-between gap-3 px-4 py-3",
                      i !== 0 && "border-t border-nq-border/25",
                    )}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-nq-primary/15 text-[10px] font-bold text-nq-primary">
                        {i + 1}
                      </span>
                      <p className="truncate text-sm font-medium text-nq-foreground">
                        {s.name}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-semibold tabular-nums text-nq-foreground">
                        {th.appointments.replace(
                          "{n}",
                          String(s.appointmentCount),
                        )}
                      </p>
                      <p className="text-[11px] tabular-nums text-nq-muted">
                        {fmtMaybe(s.revenueCents)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ── Customer Health + Tomorrow ────────────────────────────────── */}
      <section
        aria-label={`${th.healthTitle} & ${th.tomorrowTitle}`}
        className="grid grid-cols-1 gap-4 sm:grid-cols-2"
      >
        {/* Customer Health */}
        <div>
          <SectionHeader title={th.healthTitle} subtitle={th.thisMonth} />
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/45 px-3 py-3 text-center">
              <p className="text-xl font-bold tabular-nums text-nq-foreground">
                {data.newClientsThisMonth}
              </p>
              <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-nq-muted/80">
                {th.newClients}
              </p>
            </div>
            <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/45 px-3 py-3 text-center">
              <p className="text-xl font-bold tabular-nums text-nq-foreground">
                {data.totalClientsThisMonth}
              </p>
              <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-nq-muted/80">
                {th.clientsServed}
              </p>
            </div>
            <div
              className={cn(
                "rounded-2xl border px-3 py-3 text-center",
                data.noShowRateThisWeek > 0.1
                  ? "border-nq-error/30 bg-nq-error/8"
                  : "border-nq-border/40 bg-nq-surface/45",
              )}
            >
              <p
                className={cn(
                  "text-xl font-bold tabular-nums",
                  data.noShowRateThisWeek > 0.1
                    ? "text-nq-error"
                    : "text-nq-foreground",
                )}
              >
                {noShowPct}
              </p>
              <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-nq-muted/80">
                {th.noShowRate}
              </p>
              <p className="text-[9px] text-nq-muted/60">{th.thisWeek}</p>
            </div>
          </div>
        </div>

        {/* Tomorrow Preview */}
        <div>
          <SectionHeader title={th.tomorrowTitle} />
          {data.tomorrowBookings === 0 ? (
            <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/35 px-4 py-6 text-center">
              <p className="text-sm text-nq-muted">{th.tomorrowEmpty}</p>
            </div>
          ) : (
            <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/45 px-4 py-4">
              <div className="flex items-center gap-3">
                <span className="text-3xl" aria-hidden>
                  📅
                </span>
                <div>
                  <p className="text-xl font-bold tabular-nums text-nq-foreground">
                    {th.tomorrowAppointments.replace(
                      "{n}",
                      String(data.tomorrowBookings),
                    )}
                  </p>
                  <p className="mt-0.5 text-sm text-nq-muted">
                    {th.tomorrowRevenue}:{" "}
                    <span className="font-semibold tabular-nums text-nq-foreground">
                      {fmtMaybe(data.tomorrowRevenueCents)}
                    </span>
                  </p>
                </div>
              </div>
              <Link
                href={`/dashboard/${slug}/center`}
                className="mt-3 block w-full rounded-xl bg-nq-primary/12 px-3 py-2 text-center text-sm font-semibold text-nq-primary transition hover:bg-nq-primary/20"
              >
                {th.openReceptionistCenter} →
              </Link>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
