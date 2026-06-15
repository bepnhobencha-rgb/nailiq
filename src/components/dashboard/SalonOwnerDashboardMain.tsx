"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import { MobileStack } from "@/components/layout/MobileStack";
import { SalonOwnerStatsSection } from "@/components/dashboard/SalonOwnerStatsSection";
import { SalonOwnerTodayBookings } from "@/components/dashboard/SalonOwnerTodayBookings";
import { SalonOwnerDashboardSkeleton } from "@/components/dashboard/SalonOwnerDashboardSkeleton";
import { SetupChecklist } from "@/components/dashboard/SetupChecklist";
import { LoyaltyDashboardWidget } from "@/components/dashboard/LoyaltyDashboardWidget";
import { NotificationsRealtimeWidget } from "@/components/dashboard/NotificationsRealtimeWidget";
import type { SalonOwnerDashboardViewPayload } from "@/components/dashboard/salonDashboardFormat";
import { getUserMessages } from "@/shared/i18n/user";
import { maskPhoneDigits } from "@/shared/lib/maskPhone";
import { bookingIdsEqual } from "@/shared/lib/bookingIdsEqual";
import { cn } from "@/shared/lib/cn";
import type { SalonDashboardBooking } from "@/shared/types";

export function SalonOwnerDashboardMain({
  topSlot,
  slug,
  demoMode,
  data,
  language,
  onLanguageChange,
  bookingAbsoluteUrl,
  copied,
  onCopy,
  onOpenBooking,
  isSaving,
  onAdvanceStatus,
  upcomingByDay,
  isLoading,
  lastUpdatedAt,
  onManualRefresh,
  manualRefreshing,
  showDataSkeleton,
  highlightBookingId,
}: {
  topSlot?: ReactNode;
  slug: string;
  demoMode: boolean;
  data: SalonOwnerDashboardViewPayload;
  language: "en" | "vi";
  onLanguageChange: (lang: "en" | "vi") => void;
  bookingAbsoluteUrl: string;
  copied: boolean;
  onCopy: () => void;
  onOpenBooking: () => void;
  isSaving: boolean;
  onAdvanceStatus: (b: SalonDashboardBooking) => void;
  upcomingByDay: { label: string; items: SalonDashboardBooking[] }[];
  isLoading: boolean;
  lastUpdatedAt: number;
  onManualRefresh: () => void;
  manualRefreshing: boolean;
  showDataSkeleton: boolean;
  highlightBookingId?: string | null;
}) {
  const messages = getUserMessages(language);
  const t = messages.salonDashboard;
  const td = messages.ownerDashboard;
  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  // `toLocaleTimeString` formats differently on the server (Node) vs the
  // browser (locale + device TZ), which fails hydration on the upcoming list.
  // Render a placeholder through hydration, then the real time after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe mounted flag
    setMounted(true);
  }, []);

  useEffect(() => {
    const update = () => {
      setElapsedMinutes(
        Math.floor((Date.now() - lastUpdatedAt) / 60_000),
      );
    };
    update();
    const id = window.setInterval(update, 30_000);
    return () => window.clearInterval(id);
  }, [lastUpdatedAt]);

  const lastUpdatedLabel = useMemo(() => {
    const td = getUserMessages(language).salonDashboard;
    const mins = elapsedMinutes;
    if (mins < 1) return td.lastUpdatedJustNow;
    if (mins === 1) return td.lastUpdatedOneMinuteAgo;
    return td.lastUpdatedMinutesAgo.replace("{count}", String(mins));
  }, [language, elapsedMinutes]);

  const profileComplete = data.salon.profile_complete;
  const salonPhoneMasked = maskPhoneDigits(
    String(data.salon.phone ?? "").replace(/\D/g, ""),
  );
  const bookingHref = `/${encodeURIComponent(slug)}`;

  const busy = isLoading || manualRefreshing || showDataSkeleton;

  return (
    <MobileStack
      className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] overflow-visible pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pt-2"
      aria-busy={busy}
    >
      {topSlot}
      {demoMode ? (
        <div
          role="status"
          className="mb-4 rounded-2xl border border-nq-primary/35 bg-nq-primary/12 px-4 py-3 text-center text-sm leading-snug text-nq-foreground"
        >
          <span className="font-semibold uppercase tracking-wide text-nq-primary">
            {td.demoModeBadge}
          </span>
          <span className="block mt-1 text-[13px] text-nq-muted">
            {language === "vi"
              ? "Quyền truy cập qua cookie demo (24 giờ). Không dùng cho salon thật."
              : "Access via demo cookie (24h). Not for production salons."}
          </span>
        </div>
      ) : null}
      {!profileComplete ? (
        <div
          role="status"
          className="mb-4 rounded-2xl border border-nq-primary/30 bg-nq-primary/10 px-4 py-3 text-center text-sm leading-snug text-nq-foreground"
        >
          {td.profileIncomplete}
        </div>
      ) : null}
      {!profileComplete ? (
        <SetupChecklist
          slug={slug}
          language={language}
          salon={{
            services_count: data.setup.services_count,
            staff_count: data.setup.staff_count,
            address: data.salon.address,
            opening_hours: data.salon.opening_hours,
            email: data.salon.email,
          }}
        />
      ) : null}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-nq-muted/80">
            {t.title}
          </p>
          <h1 className="mt-1 text-balance text-2xl font-semibold tracking-tight text-nq-foreground lg:text-3xl">
            {data.salon.name}
          </h1>
          <p className="mt-1 break-all font-mono text-xs text-nq-muted sm:text-sm">
            <span className="text-nq-muted/70">{t.slugLabel}: </span>
            {slug}
          </p>
          <p className="mt-1 text-sm font-medium text-nq-foreground">
            {t.phone}:{" "}
            <span className="tabular-nums text-nq-muted">{salonPhoneMasked}</span>
          </p>
          {profileComplete ? (
            <p className="mt-3 rounded-xl border border-nq-success/35 bg-nq-success/12 px-3 py-2 text-sm font-medium text-nq-success">
              {td.profileComplete}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 pt-1">
          <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
            <p className="max-w-[14rem] text-right text-[11px] tabular-nums leading-snug text-nq-muted sm:max-w-none sm:text-xs">
              {lastUpdatedLabel}
            </p>
            <button
              type="button"
              onClick={onManualRefresh}
              disabled={manualRefreshing}
              className={cn(
                "inline-flex min-h-9 touch-manipulation items-center gap-1 rounded-lg border border-nq-border/45 bg-nq-surface/45 px-2.5 py-1 text-xs font-semibold text-nq-foreground transition-colors hover:bg-nq-surface/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45 disabled:opacity-55",
              )}
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
              {t.refresh}
            </button>
          </div>
          {/* Front Desk / Reports / Settings links removed —
              relocated to the persistent left sidebar app-shell
              (DashboardSidebar) per DASHBOARD_LAYOUT_RULES §9.5
              "sidebar must not duplicate the in-page primary CTA". */}
          <UserLanguageToggle
            language={language}
            onLanguageChange={onLanguageChange}
          />
          {/* Sign out removed — the persistent sidebar account menu owns it
              (same rule as the Front Desk/Settings links above: the shell
              must not duplicate it in the page header). */}
        </div>
      </div>

      <div className="rounded-2xl border border-nq-border/40 bg-nq-surface/45 p-4 ring-1 ring-inset ring-nq-primary/15">
        <p className="text-center text-[11px] font-medium uppercase tracking-wide text-nq-muted">
          {t.bookingPageUrl}
        </p>
        <p className="mt-2 break-all text-center text-base text-nq-muted">
          {bookingAbsoluteUrl}
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            size="lg"
            variant="primary"
            className="w-full min-h-11 min-w-0"
            onClick={onCopy}
          >
            {copied ? t.copied : t.copyLink}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            className="w-full min-h-11 min-w-0"
            onClick={onOpenBooking}
          >
            {t.viewBookingPage}
          </Button>
        </div>
      </div>

      {showDataSkeleton ? (
        <SalonOwnerDashboardSkeleton />
      ) : (
        <>
          <SalonOwnerStatsSection data={data} language={language} />

          <LoyaltyDashboardWidget slug={slug} />

          <NotificationsRealtimeWidget slug={slug} salonId={data.salon.id} />

          <SalonOwnerTodayBookings
            items={data.today}
            language={language}
            bookingHref={bookingHref}
            isSaving={isSaving}
            onAdvanceStatus={onAdvanceStatus}
            highlightBookingId={highlightBookingId}
          />

          <section
            className="mt-8 overflow-visible pb-[max(env(safe-area-inset-bottom),1rem)]"
            aria-label={t.upcomingConfirmed}
          >
            <h2 className="text-lg font-semibold text-nq-foreground">
              {t.upcomingConfirmed}
            </h2>
            {upcomingByDay.length === 0 ? (
              <p className="mt-3 rounded-2xl border border-nq-border/30 bg-nq-surface/35 px-4 py-6 text-center text-base text-nq-muted">
                {t.noUpcoming}
              </p>
            ) : (
              <div className="mt-3 flex flex-col gap-4">
                {upcomingByDay.map((group) => (
                  <div key={group.items[0]?.id ?? group.label}>
                    <p className="text-xs font-semibold uppercase tracking-wide text-nq-primary/90">
                      {group.label}
                    </p>
                    <ul className="mt-2 flex flex-col gap-1.5 overflow-visible">
                      {group.items.map((b) => {
                        const showHighlight = bookingIdsEqual(
                          b.id,
                          highlightBookingId,
                        );
                        return (
                        <li
                          key={b.id}
                          className="relative overflow-visible rounded-xl border border-nq-border/25 bg-nq-surface/35 px-3 py-2"
                        >
                          {showHighlight ? (
                            <span
                              className="nq-new-booking-highlight absolute inset-0 z-0 rounded-xl"
                              aria-hidden
                            />
                          ) : null}
                          <div className="relative z-[1] flex w-full min-w-0 flex-wrap items-baseline justify-between gap-2">
                          <span className="text-sm font-medium tabular-nums text-nq-foreground">
                            {b.start_time_utc && mounted
                              ? new Date(b.start_time_utc).toLocaleTimeString(
                                  "en-US",
                                  { hour: "2-digit", minute: "2-digit" },
                                )
                              : "—"}
                          </span>
                          <span className="min-w-0 flex-1 text-right text-base text-nq-foreground/95">
                            {b.client_name}
                            {b.seat_together ? (
                              <span
                                title={t.seatTogether}
                                aria-label={t.seatTogether}
                                data-testid={`owner-upcoming-seat-together-${b.id}`}
                                className="ml-1 align-middle"
                              >
                                💕
                              </span>
                            ) : null}
                            <span className="text-nq-muted"> · </span>
                            <span className="text-nq-muted">{b.service_name}</span>
                            {b.staff_name ? (
                              <>
                                <span className="text-nq-muted"> · </span>
                                <span className="text-nq-muted">{b.staff_name}</span>
                              </>
                            ) : null}
                          </span>
                          {b.client_notes ? (
                            <p className="mt-1 w-full basis-full text-sm text-nq-muted">
                              <span className="font-medium">{t.clientNotes}: </span>
                              {b.client_notes}
                            </p>
                          ) : null}
                          </div>
                        </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </MobileStack>
  );
}
