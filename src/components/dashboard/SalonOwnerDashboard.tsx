"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/shared/lib/supabase/client";
import { SetupToast, type SetupToastPayload } from "@/components/ui/Toast";
import {
  DASHBOARD_BOOKING_SELECT,
  mapDashboardBookingRow,
  type BookingRowDb,
} from "@/shared/dashboard/dashboardBookingMap";
import { Button } from "@/components/ui/Button";
import { ResponsiveShell } from "@/components/layout/ResponsiveShell";
import { MobileStack } from "@/components/layout/MobileStack";
import { AddEmailBanner } from "@/components/dashboard/AddEmailBanner";
import { DashboardEmptyShare } from "@/components/dashboard/DashboardEmptyShare";
import { SetupChecklist } from "@/components/dashboard/SetupChecklist";
import { DashboardPrimaryActions } from "@/components/dashboard/DashboardPrimaryActions";
import { SalonOwnerDashboardMain } from "@/components/dashboard/SalonOwnerDashboardMain";
import {
  nextBookingStatus,
  groupUpcomingBookingsBySalonDay,
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
import { bookingIdsEqual } from "@/shared/lib/bookingIdsEqual";
import { REG_FLOW_OWNER_RETURNING } from "@/shared/lib/registerSessionKeys";
import { getSiteUrlForClient } from "@/shared/lib/siteUrlClient";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { OwnerHomeData } from "@/shared/dashboard/loadOwnerHomeDashboardAction";

type InitialPayload = Extract<LoadSalonDashboardResult, { ok: true }>;

export function SalonOwnerDashboard({
  slug,
  initialResult,
  homeData,
}: {
  slug: string;
  initialResult: LoadSalonDashboardResult;
  homeData: OwnerHomeData | null;
}) {
  const router = useRouter();
  const { language, setLanguage } = useUserLanguage();
  const messages = useMemo(() => getUserMessages(language), [language]);
  const t = messages.salonDashboard;
  const td = messages.ownerDashboard;

  const [data, setData] = useState<InitialPayload | null>(() =>
    initialResult.ok ? initialResult : null,
  );
  const [loadError, setLoadError] = useState(
    () => !initialResult.ok && initialResult.error === "server_error",
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => Date.now());
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [newBookingToast, setNewBookingToast] =
    useState<SetupToastPayload | null>(null);
  const [highlightBookingId, setHighlightBookingId] = useState<string | null>(
    null,
  );
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const salonIdForRealtime = data?.salon.id ?? null;

  // Suppress the banner when the viewer already has *any* email tied to
  // their account — either the per-salon `salons.email` recovery contact OR
  // the auth user's own email (Google OAuth / Supabase email signup land it
  // here). Without this second check, OAuth users were nagged to "add email"
  // even though they already have one — see fix/add-email-banner-oauth.
  // Phone-only OTP users (no auth email, no salon email) still see the banner.
  const showRecoveryEmailBanner =
    !data?.salon.email?.trim() && !data?.viewerEmail?.trim();

  const bookingPath = `/${encodeURIComponent(slug)}`;
  const bookingAbsoluteUrl = useMemo(() => {
    const base = getSiteUrlForClient().replace(/\/$/, "");
    return `${base}${bookingPath}`;
  }, [bookingPath]);

  const refresh = useCallback(async () => {
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
    setLoadError(false);
    setData(res);
    setLastUpdatedAt(Date.now());
  }, [router, slug]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- sync local state with initialResult prop after server reload */
    if (initialResult.ok) {
      setData(initialResult);
      setLoadError(false);
    } else if (initialResult.error === "server_error") {
      setData(null);
      setLoadError(true);
    }
    setLastUpdatedAt(Date.now());
    setManualRefreshing(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initialResult]);

  useEffect(() => {
    if (!initialResult.ok || !initialResult.demoMode || typeof window === "undefined")
      return;
    window.sessionStorage.removeItem(REG_FLOW_OWNER_RETURNING);
  }, [initialResult]);

  useEffect(() => {
    if (!data) return;
    /** Demo cookie dashboard has no Supabase JWT; RLS denies anon SELECT on bookings, so postgres_changes never arrives — poll faster instead. */
    const ms = data.demoMode ? 8_000 : 30_000;
    const id = window.setInterval(() => {
      void refresh();
    }, ms);
    return () => window.clearInterval(id);
  }, [data, data?.demoMode, refresh]);

  useEffect(() => {
    if (!salonIdForRealtime || !data || data.demoMode) return;

    const salonId = salonIdForRealtime;
    const supabase = createClient();
    const filter = `salon_id=eq.${salonId}`;
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const scheduleHighlight = (bookingId: string) => {
      const idNorm = String(bookingId).trim().toLowerCase();
      if (!idNorm) return;
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
      setHighlightBookingId(idNorm);
      highlightTimerRef.current = setTimeout(() => {
        setHighlightBookingId((cur) =>
          cur != null && bookingIdsEqual(cur, idNorm) ? null : cur,
        );
        highlightTimerRef.current = null;
      }, 4500);
    };

    const onInsert = async (payload: { new: Record<string, unknown> }) => {
      const record = payload.new as { id?: string; salon_id?: string };
      if (
        !record.id ||
        !bookingIdsEqual(
          record.salon_id != null ? String(record.salon_id) : null,
          String(salonId),
        )
      ) {
        return;
      }

      const { data: row, error } = await supabase
        .from("bookings")
        .select(DASHBOARD_BOOKING_SELECT)
        .eq("id", record.id)
        .maybeSingle();

      if (error || !row) {
        scheduleHighlight(record.id);
        void refresh();
        return;
      }

      const mapped = mapDashboardBookingRow(row as unknown as BookingRowDb);

      setData((prev) => {
        if (!prev) return prev;
        if (prev.allBookings.some((b) => bookingIdsEqual(b.id, mapped.id))) {
          return prev;
        }
        return {
          ...prev,
          allBookings: [mapped, ...prev.allBookings],
        };
      });
      setLastUpdatedAt(Date.now());
      setNewBookingToast({
        variant: "success",
        message: td.newBookingToast,
      });
      scheduleHighlight(mapped.id);
    };

    const {
      data: { subscription: authSubscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      supabase.realtime.setAuth(session?.access_token ?? null);
    });

    void (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      supabase.realtime.setAuth(session?.access_token ?? null);
      if (cancelled) return;

      const ch = supabase
        .channel(`dashboard-bookings-${salonId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "bookings",
            filter,
          },
          (payload) => {
            void onInsert(payload);
          },
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "bookings",
            filter,
          },
          () => {
            void refresh();
          },
        )
        .subscribe((status, err) => {
          if (
            process.env.NODE_ENV === "development" &&
            (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || err)
          ) {
            console.warn("[SalonOwnerDashboard] bookings realtime:", status, err);
          }
        });

      if (cancelled) {
        void supabase.removeChannel(ch);
        return;
      }
      channel = ch;
    })();

    return () => {
      cancelled = true;
      authSubscription.unsubscribe();
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
      if (channel) {
        void supabase.removeChannel(channel);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- data and td.newBookingToast are intentionally omitted; adding them would cause infinite Realtime subscription churn
  }, [salonIdForRealtime, refresh, data?.demoMode]);

  const viewData: SalonOwnerDashboardViewPayload | null = useMemo(() => {
    if (!data) return null;
    const split = splitSalonDashboardBookings(
      data.allBookings,
      data.salon.timezone,
    );
    return { ...data, ...split };
  }, [data]);

  const upcomingByDay = useMemo(() => {
    if (!viewData || !viewData.upcoming.length) return [];
    const locale = language === "vi" ? "vi-VN" : "en-US";
    return groupUpcomingBookingsBySalonDay(
      viewData.upcoming,
      viewData.salon.timezone,
      locale,
    );
  }, [viewData, language]);

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

  if (loadError) {
    if (!data && isLoading) {
      return (
        <ResponsiveShell>
          <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] flex items-center justify-center pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pt-2">
            <p className="text-center text-base text-nq-muted">
              {td.loadingText}
            </p>
          </MobileStack>
        </ResponsiveShell>
      );
    }
    if (!data || !isLoading) {
      return (
        <ResponsiveShell>
          <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pt-2">
            <p className="text-center text-base text-nq-error">{t.loadError}</p>
            <Button
              type="button"
              variant="secondary"
              className="mt-4 w-full min-h-11"
              disabled={isLoading}
              onClick={() => {
                void refresh();
              }}
            >
              {td.retryText}
            </Button>
          </MobileStack>
        </ResponsiveShell>
      );
    }
  }

  if (!data || !viewData) {
    return null;
  }

  // State 1: setup incomplete (not demo mode) — show onboarding checklist
  const isSetupIncomplete = !data.salon.profile_complete && !data.demoMode;
  // State 2: setup done but no bookings yet (not demo mode) — show share UI
  const isZeroBookings =
    data.salon.profile_complete &&
    data.allBookings.length === 0 &&
    !data.demoMode;

  if (isSetupIncomplete) {
    return (
      <ResponsiveShell>
        <MobileStack className="min-h-[100dvh] w-full max-w-[var(--max-nq-mobile)] gap-6 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pt-2">
          <header className="pt-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-primary">
              {language === "vi" ? "Bắt đầu với NailIQ" : "Start with NailIQ"}
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-nq-foreground">
              {data.salon.name ?? slug}
            </h1>
            <p className="mt-1 text-sm leading-relaxed text-nq-muted">
              {language === "vi"
                ? "Dùng ngay các việc hằng ngày. Hoàn tất thiết lập bên dưới khi bạn sẵn sàng."
                : "Use the daily tools now. Finish the setup below when you are ready."}
            </p>
          </header>

          <DashboardPrimaryActions slug={slug} language={language} />

          <section aria-labelledby="dashboard-setup-title">
            <div className="mb-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-nq-muted/75">
                {language === "vi" ? "Thiết lập một lần" : "One-time setup"}
              </p>
              <h2
                id="dashboard-setup-title"
                className="text-lg font-semibold text-nq-foreground"
              >
                {td.emptySetup.title}
              </h2>
              <p className="mt-1 text-sm text-nq-muted">{td.emptySetup.subtitle}</p>
            </div>
            <SetupChecklist
              salon={{
                services_count: data.setup.services_count,
                staff_count: data.setup.staff_count,
                address: data.salon.address,
                opening_hours: data.salon.opening_hours,
                email: data.salon.email,
                vertical: data.salon.vertical,
              }}
              slug={slug}
              language={language}
              viewerEmail={data.viewerEmail}
            />
          </section>
        </MobileStack>
      </ResponsiveShell>
    );
  }

  if (isZeroBookings) {
    return (
      <ResponsiveShell>
        <DashboardEmptyShare
          salonName={data.salon.name ?? slug}
          bookingUrl={bookingAbsoluteUrl}
          copied={copied}
          onCopy={onCopy}
          language={language}
          slug={slug}
        />
      </ResponsiveShell>
    );
  }

  return (
    <ResponsiveShell>
      <SetupToast
        toast={newBookingToast}
        onDismiss={() => setNewBookingToast(null)}
      />
      <SalonOwnerDashboardMain
        homeData={homeData}
        topSlot={
          showRecoveryEmailBanner ? (
            <AddEmailBanner
              salonSlug={slug}
              language={language}
              onDismiss={() => {
                /* dismiss handled in banner localStorage + hidden state */
              }}
              onEmailAdded={(added) => {
                setData((prev) =>
                  prev
                    ? {
                        ...prev,
                        salon: {
                          ...prev.salon,
                          email: added,
                        },
                      }
                    : prev,
                );
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
