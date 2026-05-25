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
import { bookingIdsEqual } from "@/shared/lib/bookingIdsEqual";
import { REG_FLOW_OWNER_RETURNING } from "@/shared/lib/registerSessionKeys";
import { getSiteUrlForClient } from "@/shared/lib/siteUrlClient";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";

type InitialPayload = Extract<LoadSalonDashboardResult, { ok: true }>;

export function SalonOwnerDashboard({
  slug,
  initialResult,
}: {
  slug: string;
  initialResult: LoadSalonDashboardResult;
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
    const split = splitSalonDashboardBookings(data.allBookings);
    return { ...data, ...split };
  }, [data]);

  const upcomingByDay = useMemo(() => {
    if (!viewData || !viewData.upcoming.length) return [];
    const locale = language === "vi" ? "vi-VN" : "en-US";
    const map = new Map<
      string,
      { label: string; items: SalonDashboardBooking[] }
    >();
    for (const b of viewData.upcoming) {
      if (b.start_time_utc == null) continue;
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
      .sort((a, b) => {
        const a0 = a[1].items[0]?.start_time_utc;
        const b0 = b[1].items[0]?.start_time_utc;
        if (!a0 || !b0) return 0;
        return new Date(a0).getTime() - new Date(b0).getTime();
      })
      .map(([, v]) => v);
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
        <div className="w-full max-w-[var(--max-nq-mobile)] mx-auto px-4 py-8">
          <p className="mb-1 text-xl font-semibold text-nq-foreground">
            {td.emptySetup.title}
          </p>
          <p className="mb-6 text-sm text-nq-muted">{td.emptySetup.subtitle}</p>
          <SetupChecklist
            salon={{
              services_count: data.setup.services_count,
              staff_count: data.setup.staff_count,
              address: data.salon.address,
              opening_hours: data.salon.opening_hours,
              email: data.salon.email,
            }}
            slug={slug}
            language={language}
          />
        </div>
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
        highlightBookingId={highlightBookingId}
      />
    </ResponsiveShell>
  );
}
