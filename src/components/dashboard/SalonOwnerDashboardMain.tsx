"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import { MobileStack } from "@/components/layout/MobileStack";
import { SalonOwnerDashboardSkeleton } from "@/components/dashboard/SalonOwnerDashboardSkeleton";
import { SetupChecklist } from "@/components/dashboard/SetupChecklist";
import { LoyaltyDashboardWidget } from "@/components/dashboard/LoyaltyDashboardWidget";
import { OwnerHomeDashboard } from "@/components/dashboard/OwnerHomeDashboard";
import type { SalonOwnerDashboardViewPayload } from "@/components/dashboard/salonDashboardFormat";
import { getUserMessages } from "@/shared/i18n/user";
import type { OwnerHomeData } from "@/shared/dashboard/loadOwnerHomeDashboardAction";
import { cn } from "@/shared/lib/cn";

export function SalonOwnerDashboardMain({
  topSlot,
  slug,
  demoMode,
  data,
  language,
  onLanguageChange,
  bookingAbsoluteUrl,
  isLoading,
  lastUpdatedAt,
  onManualRefresh,
  manualRefreshing,
  showDataSkeleton,
  homeData,
}: {
  topSlot?: ReactNode;
  slug: string;
  demoMode: boolean;
  data: SalonOwnerDashboardViewPayload;
  language: "en" | "vi";
  onLanguageChange: (lang: "en" | "vi") => void;
  bookingAbsoluteUrl: string;
  isLoading: boolean;
  lastUpdatedAt: number;
  onManualRefresh: () => void;
  manualRefreshing: boolean;
  showDataSkeleton: boolean;
  homeData: OwnerHomeData | null;
}) {
  const messages = getUserMessages(language);
  const t = messages.salonDashboard;
  const td = messages.ownerDashboard;
  const [elapsedMinutes, setElapsedMinutes] = useState(0);

  useEffect(() => {
    const update = () => {
      setElapsedMinutes(Math.floor((Date.now() - lastUpdatedAt) / 60_000));
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
          viewerEmail={data.viewerEmail}
        />
      ) : null}

      {/* Language toggle lives in the corner — no longer inside the header block */}
      <div className={cn("flex justify-end", !profileComplete ? "mt-4" : "mt-1")}>
        <UserLanguageToggle language={language} onLanguageChange={onLanguageChange} />
      </div>

      {showDataSkeleton ? (
        <SalonOwnerDashboardSkeleton />
      ) : homeData ? (
        <>
          <OwnerHomeDashboard
            data={homeData}
            language={language}
            slug={slug}
            salonName={data.salon.name ?? slug}
            bookingAbsoluteUrl={bookingAbsoluteUrl}
            lastUpdatedLabel={lastUpdatedLabel}
            onManualRefresh={onManualRefresh}
            manualRefreshing={manualRefreshing}
          />
          <LoyaltyDashboardWidget slug={slug} />
        </>
      ) : (
        /* homeData unavailable (permissions or server error) — render a clean
           header with the old stats section so the page is never broken. */
        <>
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-nq-muted/80">
                {t.title}
              </p>
              <h1 className="mt-1 text-balance text-2xl font-semibold tracking-tight text-nq-foreground lg:text-3xl">
                {data.salon.name}
              </h1>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2 pt-1">
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
          </div>
          <LoyaltyDashboardWidget slug={slug} />
        </>
      )}
    </MobileStack>
  );
}
