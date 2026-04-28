"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { MobileStack } from "@/components/layout/MobileStack";
import {
  loadSalonOwnerDashboard,
  updateBookingStatus,
  type BookingStatus,
  type SalonDashboardBooking,
} from "@/shared/dashboard/salonOwnerActions";
import { getUserMessages } from "@/shared/i18n/user";
import { getRegisterFlow } from "@/shared/lib/registerFlow";
import { getSiteUrlForClient } from "@/shared/lib/siteUrlClient";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import { cn } from "@/shared/lib/cn";

function nextStatusFor(current: BookingStatus): BookingStatus | null {
  if (current === "pending") return "confirmed";
  if (current === "confirmed") return "completed";
  return null;
}

function statusLabel(
  s: BookingStatus,
  t: ReturnType<typeof getUserMessages>["salonDashboard"],
): string {
  if (s === "pending") return t.statusPending;
  if (s === "confirmed") return t.statusConfirmed;
  return t.statusCompleted;
}

function statusStyles(s: BookingStatus): string {
  if (s === "pending") {
    return "border-nq-primary/35 bg-nq-primary/10 text-nq-primary ring-1 ring-nq-primary/25";
  }
  if (s === "confirmed") {
    return "border-nq-info/35 bg-nq-info/10 text-nq-info ring-1 ring-nq-info/25";
  }
  return "border-nq-success/35 bg-nq-success/10 text-nq-success ring-1 ring-nq-success/25";
}

function formatMoney(cents: number, lang: "en" | "vi"): string {
  const amount = cents / 100;
  return new Intl.NumberFormat(lang === "vi" ? "vi-VN" : "en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

export function SalonOwnerDashboard({ slug }: { slug: string }) {
  const router = useRouter();
  const { language, setLanguage } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).salonDashboard, [language]);

  const [ownerPhone, setOwnerPhone] = useState<string | null>(null);
  const [data, setData] = useState<{
    salon: { id: string; name: string; slug: string };
    today: SalonDashboardBooking[];
    upcoming: SalonDashboardBooking[];
    stats: {
      totalToday: number;
      pending: number;
      confirmed: number;
      completed: number;
      revenueCents: number;
    };
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [copied, setCopied] = useState(false);

  const bookingPath = `/${encodeURIComponent(slug)}`;
  const bookingAbsoluteUrl = useMemo(() => {
    const base = getSiteUrlForClient().replace(/\/$/, "");
    return `${base}${bookingPath}`;
  }, [bookingPath]);

  useEffect(() => {
    const flow = getRegisterFlow();
    if (!flow.phone || !flow.verified) {
      router.replace("/register");
      return;
    }
    setOwnerPhone(flow.phone);
  }, [router]);

  const refresh = useCallback(async () => {
    if (!ownerPhone) return;
    setLoadError(false);
    setIsLoading(true);
    const res = await loadSalonOwnerDashboard(slug, ownerPhone);
    setIsLoading(false);
    if (!res.ok) {
      if (res.error === "unauthorized") {
        router.replace("/register");
        return;
      }
      setLoadError(true);
      return;
    }
    setData({
      salon: res.salon,
      today: res.today,
      upcoming: res.upcoming,
      stats: res.stats,
    });
  }, [ownerPhone, router, slug]);

  useEffect(() => {
    if (!ownerPhone) return;
    void refresh();
  }, [ownerPhone, refresh]);

  const upcomingByDay = useMemo(() => {
    if (!data?.upcoming.length) return [];
    const locale = language === "vi" ? "vi-VN" : "en-US";
    const map = new Map<
      string,
      { label: string; items: SalonDashboardBooking[] }
    >();
    for (const b of data.upcoming) {
      const d = new Date(b.start_time_utc);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const label = d.toLocaleDateString(locale, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      const group = map.get(key);
      if (group) {
        group.items.push(b);
      } else {
        map.set(key, { label, items: [b] });
      }
    }
    return [...map.entries()]
      .sort(
        (a, b) =>
          new Date(a[1].items[0].start_time_utc).getTime() -
          new Date(b[1].items[0].start_time_utc).getTime(),
      )
      .map(([, v]) => v);
  }, [data?.upcoming, language]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(bookingAbsoluteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }, [bookingAbsoluteUrl]);

  const onAdvanceStatus = useCallback(
    async (booking: SalonDashboardBooking) => {
      const next = nextStatusFor(booking.status);
      if (!next || !ownerPhone) return;
      setIsSaving(true);
      const res = await updateBookingStatus(booking.id, next, slug, ownerPhone);
      setIsSaving(false);
      if (!res.ok) return;
      await refresh();
    },
    [ownerPhone, refresh, slug],
  );

  if (!ownerPhone) {
    return (
      <ResponsiveShell>
        <MobileStack className="w-full max-w-[var(--max-nq-mobile)] pb-safe">
          <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 px-4 py-8 text-center text-sm text-nq-muted">
            {t.loading}
          </div>
        </MobileStack>
      </ResponsiveShell>
    );
  }

  if (loadError && !isLoading) {
    return (
      <ResponsiveShell>
        <MobileStack className="w-full max-w-[var(--max-nq-mobile)] pb-safe">
          <p className="text-center text-sm text-nq-error">{t.loadError}</p>
          <Button
            type="button"
            variant="secondary"
            className="mt-4 w-full"
            onClick={() => {
              void refresh();
            }}
          >
            {language === "vi" ? "Thử lại" : "Try again"}
          </Button>
        </MobileStack>
      </ResponsiveShell>
    );
  }

  if (!data || isLoading) {
    return (
      <ResponsiveShell>
        <MobileStack className="w-full max-w-[var(--max-nq-mobile)] pb-safe">
          <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/40 px-4 py-8 text-center text-sm text-nq-muted">
            {t.loading}
          </div>
        </MobileStack>
      </ResponsiveShell>
    );
  }

  return (
    <ResponsiveShell>
      <MobileStack className="w-full max-w-[var(--max-nq-mobile)] pb-safe sm:pt-2">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-nq-muted/80">
              {t.title}
            </p>
            <h1 className="mt-1 text-balance text-xl font-bold tracking-tight text-nq-foreground sm:text-2xl">
              {data.salon.name}
            </h1>
            <p className="mt-1 break-all font-mono text-xs text-nq-muted sm:text-sm">
              <span className="text-nq-muted/70">{t.slugLabel}: </span>
              {slug}
            </p>
          </div>
          <UserLanguageToggle language={language} onLanguageChange={setLanguage} />
        </div>

        <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/45 p-4 ring-1 ring-inset ring-nq-primary/15">
          <p className="text-center text-[11px] font-medium uppercase tracking-wide text-nq-muted">
            {t.bookingPageUrl}
          </p>
          <p className="mt-2 break-all text-center text-sm text-nq-foreground/95">
            {bookingAbsoluteUrl}
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              size="lg"
              variant="primary"
              className="w-full min-w-0"
              onClick={onCopy}
            >
              {copied ? t.copied : t.copyLink}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="secondary"
              className="w-full min-w-0"
              onClick={() =>
                window.open(bookingAbsoluteUrl, "_blank", "noopener,noreferrer")
              }
            >
              {t.viewBookingPage}
            </Button>
          </div>
        </div>

        <section className="mt-6" aria-label={t.todaySummary}>
          <h2 className="text-sm font-semibold text-nq-foreground">
            {t.todaySummary}
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            <StatPill label={t.totalToday} value={String(data.stats.totalToday)} />
            <StatPill label={t.pending} value={String(data.stats.pending)} accent="gold" />
            <StatPill
              label={t.confirmed}
              value={String(data.stats.confirmed)}
              accent="blue"
              className="sm:col-span-1"
            />
            <StatPill
              label={t.completed}
              value={String(data.stats.completed)}
              accent="green"
            />
            <div className="col-span-2 rounded-2xl border border-nq-border/35 bg-nq-surface/40 px-3 py-3 sm:col-span-3">
              <p className="text-[11px] font-medium text-nq-muted">{t.estRevenue}</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums text-nq-primary">
                {formatMoney(data.stats.revenueCents, language)}
              </p>
            </div>
          </div>
        </section>

        <section className="mt-8" aria-label={t.todayAppointments}>
          <h2 className="text-sm font-semibold text-nq-foreground">
            {t.todayAppointments}
          </h2>
          <ul className="mt-3 flex flex-col gap-2">
            {data.today.length === 0 ? (
              <li className="rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-6 text-center text-sm text-nq-muted">
                {t.noBookingsToday}
              </li>
            ) : (
              data.today.map((b) => (
                <li
                  key={b.id}
                  className={cn(
                    "rounded-2xl border px-4 py-3",
                    statusStyles(b.status),
                  )}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold tabular-nums text-nq-foreground">
                      {new Date(b.start_time_utc).toLocaleTimeString(
                        language === "vi" ? "vi-VN" : "en-US",
                        { hour: "numeric", minute: "2-digit" },
                      )}
                    </p>
                    <span className="rounded-full border border-current/30 px-2 py-0.5 text-[11px] font-medium">
                      {statusLabel(b.status, t)}
                    </span>
                  </div>
                  <p className="mt-2 text-[15px] font-medium text-nq-foreground">
                    {b.client_name}
                  </p>
                  <p className="text-sm text-nq-muted">
                    {t.phone}: {b.client_phone}
                  </p>
                  <p className="mt-1 text-sm text-nq-muted">
                    {t.service}: {b.service_name}
                  </p>
                  {nextStatusFor(b.status) ? (
                    <Button
                      type="button"
                      variant="secondary"
                      size="lg"
                      className="mt-3 w-full border-nq-border/50"
                      disabled={isSaving}
                      onClick={() => onAdvanceStatus(b)}
                    >
                      {t.advanceStatus}
                    </Button>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </section>

        <section className="mt-8 pb-4" aria-label={t.upcomingConfirmed}>
          <h2 className="text-sm font-semibold text-nq-foreground">
            {t.upcomingConfirmed}
          </h2>
          {upcomingByDay.length === 0 ? (
            <p className="mt-3 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-6 text-center text-sm text-nq-muted">
              {t.noUpcoming}
            </p>
          ) : (
            <div className="mt-3 flex flex-col gap-4">
              {upcomingByDay.map((group) => (
                <div key={group.items[0]?.id ?? group.label}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-nq-primary/90">
                    {group.label}
                  </p>
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {group.items.map((b) => (
                      <li
                        key={b.id}
                        className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-nq-border/25 bg-nq-surface/35 px-3 py-2"
                      >
                        <span className="text-sm font-medium tabular-nums text-nq-foreground">
                          {new Date(b.start_time_utc).toLocaleTimeString(
                            language === "vi" ? "vi-VN" : "en-US",
                            { hour: "numeric", minute: "2-digit" },
                          )}
                        </span>
                        <span className="min-w-0 flex-1 text-right text-sm text-nq-foreground/95">
                          {b.client_name}
                          <span className="text-nq-muted"> · </span>
                          <span className="text-nq-muted">{b.service_name}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      </MobileStack>
    </ResponsiveShell>
  );
}

function StatPill({
  label,
  value,
  accent,
  className,
}: {
  label: string;
  value: string;
  accent?: "gold" | "blue" | "green";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-nq-border/35 bg-nq-surface/40 px-3 py-3",
        accent === "gold" && "ring-1 ring-nq-primary/20",
        accent === "blue" && "ring-1 ring-nq-info/20",
        accent === "green" && "ring-1 ring-nq-success/20",
        className,
      )}
    >
      <p className="text-[11px] font-medium text-nq-muted">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-xl font-semibold tabular-nums",
          !accent && "text-nq-foreground",
          accent === "gold" && "text-nq-primary",
          accent === "blue" && "text-nq-info",
          accent === "green" && "text-nq-success",
        )}
      >
        {value}
      </p>
    </div>
  );
}
