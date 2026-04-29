"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/shared/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { MobileStack } from "@/components/layout/MobileStack";
import { AddEmailBanner } from "@/components/dashboard/AddEmailBanner";
import { SalonOwnerDashboardMain } from "@/components/dashboard/SalonOwnerDashboardMain";
import {
  nextBookingStatus,
  splitSalonDashboardBookings,
  type SalonOwnerDashboardViewPayload,
} from "@/components/dashboard/salonDashboardFormat";
import {
  loadSalonOwnerDashboard,
  updateBookingStatus,
  type LoadSalonDashboardResult,
  type SalonDashboardBooking,
} from "@/shared/dashboard/salonOwnerActions";
import { getUserMessages } from "@/shared/i18n/user";
import { REG_FLOW_OWNER_RETURNING } from "@/shared/lib/registerSessionKeys";
import { getSiteUrlForClient } from "@/shared/lib/siteUrlClient";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type InitialPayload = Extract<LoadSalonDashboardResult, { ok: true }>;

export function SalonOwnerDashboard({
  slug,
  initial,
}: {
  slug: string;
  initial: InitialPayload;
}) {
  const router = useRouter();
  const { language, setLanguage } = useUserLanguage();
  const t = useMemo(() => getUserMessages(language).salonDashboard, [language]);

  const [data, setData] = useState<InitialPayload>(initial);
  const [loadError, setLoadError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => Date.now());
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const showRecoveryEmailBanner = !data.salon.email?.trim();

  const bookingPath = `/${encodeURIComponent(slug)}`;
  const bookingAbsoluteUrl = useMemo(() => {
    const base = getSiteUrlForClient().replace(/\/$/, "");
    return `${base}${bookingPath}`;
  }, [bookingPath]);

  const refresh = useCallback(async () => {
    setLoadError(false);
    setIsLoading(true);
    const res = await loadSalonOwnerDashboard(slug);
    setIsLoading(false);
    if (!res.ok) {
      if (res.error === "unauthorized") {
        router.replace("/register");
        return;
      }
      setLoadError(true);
      return;
    }
    setData(res);
    setLastUpdatedAt(Date.now());
  }, [router, slug]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- server `initial` from RSC refresh / navigation
    setData(initial);
    setLastUpdatedAt(Date.now());
    setManualRefreshing(false);
  }, [initial]);

  useEffect(() => {
    if (!initial.demoMode || typeof window === "undefined") return;
    window.sessionStorage.removeItem(REG_FLOW_OWNER_RETURNING);
  }, [initial.demoMode]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const salonId = data.salon.id;
    const supabase = createClient();
    const filter = `salon_id=eq.${salonId}`;
    const onBookingChange = () => {
      void refresh();
    };
    const channel = supabase
      .channel(`dashboard-bookings-${salonId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "bookings",
          filter,
        },
        onBookingChange,
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "bookings",
          filter,
        },
        onBookingChange,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [data.salon.id, refresh]);

  const viewData: SalonOwnerDashboardViewPayload = useMemo(() => {
    const split = splitSalonDashboardBookings(data.allBookings);
    return { ...data, ...split };
  }, [data]);

  const upcomingByDay = useMemo(() => {
    if (!viewData.upcoming.length) return [];
    const locale = language === "vi" ? "vi-VN" : "en-US";
    const map = new Map<
      string,
      { label: string; items: SalonDashboardBooking[] }
    >();
    for (const b of viewData.upcoming) {
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
  }, [viewData.upcoming, language]);

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
      const next = nextBookingStatus(booking.status);
      if (!next) return;
      setIsSaving(true);
      const res = await updateBookingStatus(booking.id, next, slug);
      setIsSaving(false);
      if (!res.ok) return;
      await refresh();
    },
    [refresh, slug],
  );

  if (loadError && !isLoading) {
    return (
      <ResponsiveShell>
        <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pt-2">
          <p className="text-center text-base text-nq-error">{t.loadError}</p>
          <Button
            type="button"
            variant="secondary"
            className="mt-4 w-full min-h-11"
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

  return (
    <ResponsiveShell>
      <SalonOwnerDashboardMain
        topSlot={
          showRecoveryEmailBanner ? (
            <AddEmailBanner
              salonSlug={slug}
              onDismiss={() => {
                /* dismiss handled in banner localStorage + hidden state */
              }}
              onEmailAdded={(added) => {
                setData((prev) => ({
                  ...prev,
                  salon: {
                    ...prev.salon,
                    email: added,
                  },
                }));
              }}
            />
          ) : null
        }
        slug={slug}
        demoMode={data.demoMode}
        data={viewData}
        language={language}
        onLanguageChange={setLanguage}
        bookingAbsoluteUrl={bookingAbsoluteUrl}
        copied={copied}
        onCopy={onCopy}
        onOpenBooking={() => {
          if (typeof window !== "undefined") {
            window.open(bookingAbsoluteUrl, "_blank", "noopener,noreferrer");
          }
        }}
        isSaving={isSaving}
        onAdvanceStatus={onAdvanceStatus}
        upcomingByDay={upcomingByDay}
        isLoading={isLoading}
        lastUpdatedAt={lastUpdatedAt}
        onManualRefresh={() => {
          setManualRefreshing(true);
          router.refresh();
        }}
        manualRefreshing={manualRefreshing}
        showDataSkeleton={isLoading || manualRefreshing}
      />
    </ResponsiveShell>
  );
}
