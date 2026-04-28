"use client";

import { Button } from "@/components/ui/Button";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import { MobileStack } from "@/components/layout/MobileStack";
import { SalonOwnerStatsSection } from "@/components/dashboard/SalonOwnerStatsSection";
import { SalonOwnerTodayBookings } from "@/components/dashboard/SalonOwnerTodayBookings";
import type { LoadSalonDashboardResult } from "@/shared/dashboard/salonOwnerActions";
import { getUserMessages } from "@/shared/i18n/user";
import { maskPhoneDigits } from "@/shared/lib/maskPhone";
import type { SalonDashboardBooking } from "@/shared/types";

type InitialPayload = Extract<LoadSalonDashboardResult, { ok: true }>;

export function SalonOwnerDashboardMain({
  slug,
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
}: {
  slug: string;
  data: InitialPayload;
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
}) {
  const t = getUserMessages(language).salonDashboard;
  const salonPhoneMasked = maskPhoneDigits(
    String(data.salon.phone ?? "").replace(/\D/g, ""),
  );

  return (
    <MobileStack
      className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pt-2"
      aria-busy={isLoading}
    >
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
        </div>
        <UserLanguageToggle
          language={language}
          onLanguageChange={onLanguageChange}
        />
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

      <SalonOwnerStatsSection data={data} language={language} />

      <SalonOwnerTodayBookings
        items={data.today}
        language={language}
        isSaving={isSaving}
        onAdvanceStatus={onAdvanceStatus}
      />

      <section
        className="mt-8 pb-[max(env(safe-area-inset-bottom),1rem)]"
        aria-label={t.upcomingConfirmed}
      >
        <h2 className="text-lg font-semibold text-nq-foreground">{t.upcomingConfirmed}</h2>
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
                      <span className="min-w-0 flex-1 text-right text-base text-nq-foreground/95">
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
  );
}
