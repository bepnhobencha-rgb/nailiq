"use client";

import * as Sentry from "@sentry/nextjs";
import { Users, X as CloseIcon } from "lucide-react";

/**
 * ReceptionistCenter — performance notes
 * --------------------------------------
 * Memoization
 *   - `gridStaff`, `gridBookings`, `staffNameById`, `densityConfig`,
 *     `detailModel`, `drawerCopy` — all `useMemo`'d so that per-minute
 *     `nowIso` ticks do not rebuild them. `kpiSnapshot` is computed on
 *     the server (`loadReceptionistCenterData`) so the client does not
 *     re-derive it.
 *   - `StaffTimelineGrid` is wrapped in `React.memo` so it skips the
 *     heavy slot-grid + booking-block render when only unrelated parent
 *     state changes (drawer open/close, undo countdown, banner toggles).
 *
 * Known re-render triggers
 *   - `nowIso` ticks every 60s (live now-line). The grid props are
 *     stable so the memo blocks the timeline from re-rendering on the
 *     tick alone, but `BookingBlock` instances re-receive `nowIso`
 *     from the grid for the late-overlay flag derivation.
 *   - Realtime postgres_changes → `reloadCurrentDay()` rebuilds `data`,
 *     which is the legitimate source of truth update.
 *   - Drawer/edit/undo state lives in this component; toggling them
 *     re-renders the shell but the memoized grid skips work.
 *
 * Performance budget targets (per UX_PRINCIPLES §2 rule 11)
 *   - <100 ms perceived response for primary taps and toggles.
 *   - <1 s to usable content after navigation.
 *   - 60 fps on timeline horizontal scroll.
 *   - All Framer Motion uses transform/opacity only — no layout-
 *     triggering properties (width/height/top/left). See
 *     ANIMATION_RULES.md §3.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/shared/lib/supabase/client";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import { BookingDetailDrawer, type BookingDetailDrawerModel } from "./BookingDetailDrawer";
import { ConnectionBanner, type ConnectionState } from "./ConnectionBanner";
import { DateSwitcher } from "./DateSwitcher";
import { DensitySlider } from "./DensitySlider";
import { KPIBar } from "./KPIBar";
import { StaffTimelineGrid, type GridBooking } from "./StaffTimelineGrid";
import { StatusPill } from "./StatusPill";
import { TVModeView } from "./TVModeView";
import { UndoToast } from "./UndoToast";
import { WalkinQueueSidebar, type QueueItem } from "./WalkinQueueSidebar";
import { WeekView, mondayYmdOf, shiftWeek } from "./WeekView";
import { MonthView, firstOfMonth, shiftMonth } from "./MonthView";
import type { BookingsRangeHint } from "@/shared/dashboard/getBookingsForRangeAction";
import type {
  LoadReceptionistCenterError,
  LoadReceptionistCenterResult,
  ReceptionistCenterData,
} from "@/shared/dashboard/loadReceptionistCenterData";
import { loadReceptionistCenterDataAction } from "@/shared/dashboard/loadReceptionistCenterDataAction";
import {
  addWalkinAndAssign,
  addWalkinToQueue,
  assignWalkinToSlot,
  cancelDeskBooking,
  restoreCancelledBooking,
  undoCancelBooking,
  cancelWaitingWalkin,
  undoWalkinAssignment,
} from "@/shared/dashboard/receptionistActions";
import { lookupClientByPhone } from "@/shared/dashboard/lookupClientByPhoneAction";
import { getStaffAvailability } from "@/shared/dashboard/availabilityEngine";
import {
  type UpdateBookingStatusResult,
  updateBookingStatus,
} from "@/shared/dashboard/salonOwnerActions";
import { editBookingAction } from "@/shared/dashboard/editBookingAction";
import { getUserMessages } from "@/shared/i18n/user";
import { checkBookingConflict, type ConflictCheckBooking } from "@/shared/lib/conflictCheck";
import { cn } from "@/shared/lib/cn";
import { cleanPhone, formatPhone } from "@/shared/lib/phoneFormat";
import { formatCurrency } from "@/shared/lib/currencyFormat";
import { maskPhoneDigits } from "@/shared/lib/maskPhone";
import { isWalkinUrgent } from "@/shared/lib/queueUrgency";
import { useQueuePanelOpen } from "@/shared/lib/useQueuePanelOpen";
import { useRushHourMode } from "./useRushHourMode";
import {
  setSoftHold as setSoftHoldAction,
  clearSoftHold as clearSoftHoldAction,
} from "@/shared/dashboard/receptionistActions";
import { logSalonRushEvent } from "@/shared/dashboard/rushHourEvent";
import {
  canCancelBooking,
  canUndoCancel,
  type SalonMemberRole,
} from "@/shared/lib/salonMemberRole";
import { formatInSalonTz, salonDateOffset, salonToday } from "@/shared/lib/salonTime";
import { useSoundAlerts } from "@/shared/lib/useSoundAlerts";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  densityConfigFor,
  type DensityLevel,
} from "@/shared/dashboard/dashboardDensity";
import type { BookingStatus } from "@/shared/types";
import { BookingLimitBanner } from "@/components/dashboard/BookingLimitBanner";
import { PartyCardPanel } from "@/components/receptionist/PartyCardPanel";
import type { PartyCard } from "@/shared/dashboard/loadPartyCardsAction";

export type ReceptionistCenterProps = {
  slug: string;
  /** Server load result (`ok: false` shows localized shell only). */
  initialResult: LoadReceptionistCenterResult;
  /** Caller's `salon_members.role` — gates Edit/Cancel in the booking drawer. */
  viewerRole: SalonMemberRole;
  /** Free-tier monthly booking-cap status. `null` if the loader
   *  couldn't fetch it (transient error — banner stays hidden). */
  bookingLimitStatus?: import("@/shared/dashboard/loadBookingLimitStatus").BookingLimitStatus | null;
  /** Party cards for today + 7 days. Empty array if none or service-role key unavailable. */
  partyCards?: PartyCard[];
};

function loadErrorCopy(
  m: ReturnType<typeof getUserMessages>["receptionist"],
  code: LoadReceptionistCenterError,
) {
  return m.loadError[code];
}

function mutationMessage(
  m: ReturnType<typeof getUserMessages>["receptionist"],
  code: string | undefined,
): string {
  if (!code) return m.actionErrorFallback;
  const row = m.actionErrors[code as keyof typeof m.actionErrors];
  return typeof row === "string" ? row : m.actionErrorFallback;
}

function updateBookingStatusToastMessage(
  m: ReturnType<typeof getUserMessages>["receptionist"],
  res: Extract<UpdateBookingStatusResult, { ok: false }>,
): string {
  switch (res.error) {
    case "unauthorized":
      return mutationMessage(m, "unauthorized");
    case "not_found":
      return mutationMessage(m, "not_found");
    case "invalid_transition":
      return mutationMessage(m, "invalid_transition");
    case "server_error":
      return mutationMessage(m, "server_error");
    default:
      return m.actionErrorFallback;
  }
}

function bookingStatusLabel(messages: ReturnType<typeof getUserMessages>, status: BookingStatus) {
  const d = messages.salonDashboard;
  switch (status) {
    case "pending":
      return d.statusPending;
    case "confirmed":
      return d.statusConfirmed;
    case "in_progress":
      return d.statusInProgress;
    case "completed":
      return d.statusCompleted;
    case "waiting":
      return d.statusWaiting;
    case "cancelled":
      return d.statusCancelled;
    default:
      return status;
  }
}

function conflictRows(bookings: GridBooking[]): ConflictCheckBooking[] {
  return bookings.map((b) => ({
    id: b.id,
    staff_id: b.staff_id,
    start_time_utc: b.start_time_utc,
    end_time_utc: b.end_time_utc,
    status: b.status,
    client_name: b.client_name,
  }));
}

function serviceSlotMinutes(
  serviceId: string,
  services: ReceptionistCenterData["services"],
): number | null {
  const sid = String(serviceId ?? "").trim().toLowerCase();
  const s = services.find((row) => String(row.id ?? "").trim().toLowerCase() === sid);
  if (!s) return null;
  const dRaw = Number(s.duration_minutes);
  const bRaw = Number(s.buffer_minutes);
  const d = Number.isFinite(dRaw) ? Math.round(dRaw) : 0;
  const buf = Number.isFinite(bRaw) ? Math.round(bRaw) : 0;
  const total = d + buf;
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** Catalog duration (+ buffer); falls back to queue row join when FK row is missing/stale client-side. */
function walkinEffectiveSpanMinutes(
  qi: QueueItem,
  services: ReceptionistCenterData["services"],
): number | null {
  const catalog = serviceSlotMinutes(qi.service_id, services);
  if (catalog !== null && catalog >= 1) return catalog;

  const rowDur = qi.service_duration_minutes;
  if (Number.isFinite(rowDur)) {
    const rounded = Math.round(rowDur);
    if (rounded >= 1) return rounded;
  }

  return null;
}

type UndoToastState = {
  bookingId: string;
  headline: string;
  detailLine: string;
  secondsRemaining: number;
  /** "assign" = undo walkin assignment; "cancel" = undo booking cancel */
  type: "assign" | "cancel";
};

function ReceptionistGateError({ code }: { code: LoadReceptionistCenterError }) {
  const { language, setLanguage } = useUserLanguage();
  const messages = useMemo(() => getUserMessages(language), [language]);

  return (
    <div className="mx-auto flex max-w-[var(--max-nq-mobile)] flex-col gap-4 px-[var(--pad-nq-section-mobile)] py-10 text-center text-sm">
      <p className="text-nq-error">{loadErrorCopy(messages.receptionist, code)}</p>
      <div className="flex justify-center">
        <UserLanguageToggle language={language} onLanguageChange={setLanguage} />
      </div>
    </div>
  );
}

function ReceptionistCenterInner({
  slug,
  initialOk,
  viewerRole,
  bookingLimitStatus,
  partyCards,
}: {
  slug: string;
  initialOk: ReceptionistCenterData;
  viewerRole: SalonMemberRole;
  bookingLimitStatus: import("@/shared/dashboard/loadBookingLimitStatus").BookingLimitStatus | null;
  partyCards: PartyCard[];
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { language, setLanguage } = useUserLanguage();
  const messages = useMemo(() => getUserMessages(language), [language]);

  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  const nowIsoRef = useRef(nowIso);
  /* Sync ref via effect (not during render) so reloadCurrentDay's callback
     can read the latest value without including nowIso in its deps. */
  useEffect(() => {
    nowIsoRef.current = nowIso;
  });

  useEffect(() => {
    const tick = window.setInterval(() => {
      setNowIso(new Date().toISOString());
    }, 60_000);
    return () => window.clearInterval(tick);
  }, []);

  const [overloadedStaff, setOverloadedStaff] = useState<
    Array<{ name: string; queueAhead: number }>
  >([]);

  const [data, setData] = useState<ReceptionistCenterData>(() => ({
    ...initialOk,
    selectedDate: initialOk.selectedDate,
    dashboardModules: initialOk.dashboardModules,
  }));

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync local data when initialOk reloads from server
    setData({ ...initialOk, selectedDate: initialOk.selectedDate });
  }, [initialOk]);

  const [dateOffset, setDateOffset] = useState<-1 | 0 | 1>(0);

  // View mode (Day | Week | Month). Resolution order on mount:
  //   1. `?view=week` / `?view=day` / `?view=month` URL param wins (sidebar
  //      Calendar tab links here with `?view=week` — we honour the deep link
  //      verbatim AND persist it so a reload from the same URL keeps the choice).
  //   2. localStorage `nailiq-view-mode` from a prior session.
  //   3. Default `day` — the live operational job is the day grid; week/month
  //      are planning glances.
  // SSR-safe: state starts at `day`; the URL/localStorage sync runs in
  // an effect after mount.
  const urlViewParam = searchParams?.get("view") ?? null;
  const [viewMode, setViewMode] = useState<"day" | "week" | "month">("day");
  useEffect(() => {
    if (typeof window === "undefined") return;
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot hydration from URL or localStorage */
    if (urlViewParam === "week") {
      setViewMode("week");
      window.localStorage.setItem("nailiq-view-mode", "week");
      return;
    }
    if (urlViewParam === "month") {
      setViewMode("month");
      window.localStorage.setItem("nailiq-view-mode", "month");
      return;
    }
    if (urlViewParam === "day") {
      setViewMode("day");
      window.localStorage.setItem("nailiq-view-mode", "day");
      return;
    }
    const stored = window.localStorage.getItem("nailiq-view-mode");
    if (stored === "week") setViewMode("week");
    else if (stored === "month") setViewMode("month");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [urlViewParam]);
  const onChangeViewMode = useCallback((next: "day" | "week" | "month") => {
    setViewMode(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem("nailiq-view-mode", next);
    }
  }, []);

  // Week-view anchor (Monday of the visible week). Derived initially from
  // today's salon date so first paint shows the current week.
  const initialMondayYmd = useMemo(
    () => mondayYmdOf(salonToday(initialOk.salon.timezone)),
    [initialOk.salon.timezone],
  );
  const [weekMondayYmd, setWeekMondayYmd] = useState(initialMondayYmd);

  // Month-view anchor (YYYY-MM-01 of the visible month). Starts on the
  // current month so first paint is always the present month.
  const initialMonthFirstYmd = useMemo(
    () => firstOfMonth(salonToday(initialOk.salon.timezone)),
    [initialOk.salon.timezone],
  );
  const [monthFirstYmd, setMonthFirstYmd] = useState(initialMonthFirstYmd);

  useEffect(() => {
    const tz = data.salon.timezone;
    const today = salonDateOffset(tz, 0, nowIso);
    /* eslint-disable react-hooks/set-state-in-effect -- reactive reconciliation of dateOffset against (selectedDate, today) */
    if (data.selectedDate === today) {
      setDateOffset(0);
    } else {
      const yesterday = salonDateOffset(tz, -1, nowIso);
      const tomorrow = salonDateOffset(tz, 1, nowIso);
      if (data.selectedDate === yesterday) setDateOffset(-1);
      else if (data.selectedDate === tomorrow) setDateOffset(1);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data.salon.timezone, data.selectedDate, nowIso]);

  const [assigningWalkinId, setAssigningWalkinId] = useState<string | null>(null);
  const [dayLoading, setDayLoading] = useState(false);

  const [drawerBookingId, setDrawerBookingId] = useState<string | null>(null);

  // E2E hydration signal: renders only after the first client-side effect,
  // confirming React has fully hydrated and all event handlers are registered.
  // Used by gotoReceptionistCenter in e2e/receptionist-center/helpers.ts.
  const [rcHydrated, setRcHydrated] = useState(false);
  useEffect(() => {
    setRcHydrated(true);
  }, []);

  const [undoState, setUndoState] = useState<UndoToastState | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  const undoVisible = undoState !== null;

  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null) window.clearInterval(undoTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (undoTimerRef.current !== null) window.clearInterval(undoTimerRef.current);
    undoTimerRef.current = null;
    if (!undoState) return;

    undoTimerRef.current = window.setInterval(() => {
      setUndoState((prev) => {
        if (!prev) return null;
        const next = prev.secondsRemaining - 1;
        if (next <= 0) return null;
        return { ...prev, secondsRemaining: next };
      });
    }, 1000);

    return () => {
      if (undoTimerRef.current !== null) window.clearInterval(undoTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ARCHITECTURE_LOCK: intentionally keyed on undoVisible (boolean) not undoState object; prevents timer restart on secondsRemaining ticks
  }, [undoVisible]);

  const [shakeMessage, setShakeMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!shakeMessage) return;
    const t = window.setTimeout(() => setShakeMessage(null), 2400);
    return () => window.clearTimeout(t);
  }, [shakeMessage]);

  /** Increments when receptionist taps "Now" — grid smooth-scrolls to current slot. */
  const [jumpToNowTrigger, setJumpToNowTrigger] = useState(0);

  // Sidebar Walk-in Queue tab links to /center#queue. Honour the hash on
  // mount by smooth-scrolling the queue panel into view. Wrapped in
  // requestAnimationFrame so layout has settled (the queue is mounted
  // conditionally on `viewMode === "day" && modules.queue_panel`). Only
  // runs once on mount; subsequent in-app navigations that change the
  // hash are user-driven and need no extra handling here.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#queue") return;
    const raf = window.requestAnimationFrame(() => {
      const el = document.getElementById("queue");
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(raf);
  }, []);

  const [drawerBusy, setDrawerBusy] = useState(false);

  // Realtime connection-state machine. Default 'connected' — assume
  // online until the Supabase channel subscribe-callback flips us to
  // 'reconnecting' (CHANNEL_ERROR / TIMED_OUT) or 'offline' (CLOSED).
  // The polling-fallback path (no session) keeps this 'connected' since
  // 8s polling is operationally fresh enough to act on; only the
  // realtime channel actually transitions through these states.
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connected");
  const isOffline = connectionState !== "connected";

  // Sound alerts (Web Audio, generated tones only). Hook is a no-op
  // when `dashboard_modules.sound_alerts` is off; honors browser
  // autoplay policy via lazy AudioContext + first-gesture unlock.
  const { playAlert, isUnlocked: isSoundUnlocked } = useSoundAlerts(data.dashboardModules);

  const staffNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of data.staff) {
      map.set(s.id, s.name);
    }
    return map;
  }, [data.staff]);

  // `data.staff` already carries the derived `status` / `workload`
  // from `loadReceptionistCenterData`'s `enrichStaffRows` — pass
  // through verbatim. Status dot replaces the prior custom busy-ring, so
  // the local `busyStaffIds` set is no longer needed here.
  const gridStaff = useMemo(
    () =>
      data.staff.map((s) => ({
        id: s.id,
        name: s.name,
        job_role: s.job_role,
        status: s.status,
        workload: s.workload,
      })),
    [data.staff],
  );

  const gridBookings: GridBooking[] = useMemo(() => {
    return data.bookingsForDay.flatMap((b): GridBooking[] => {
      if (
        b.status !== "pending" &&
        b.status !== "confirmed" &&
        b.status !== "in_progress" &&
        b.status !== "completed"
      ) {
        return [];
      }
      return [
        {
          id: b.id,
          client_name: b.client_name,
          service_name: b.service_name,
          service_id: b.service_id,
          status: b.status,
          source: b.source,
          source_channel: b.source_channel,
          staff_id: b.staff_id,
          start_time_utc: b.start_time_utc,
          end_time_utc: b.end_time_utc,
          price_cents: b.price_cents ?? null,
          is_vip: b.is_vip,
          has_notes: b.has_notes,
          has_design: b.has_design,
          has_staff_request: b.has_staff_request,
          group_id: b.group_id,
        },
      ];
    });
  }, [data.bookingsForDay]);

  const queueItems: QueueItem[] = data.walkinQueue;

  // Overload signals — refresh whenever the queue length changes (or
  // every minute via nowIso). Service-id agnostic snapshot so the
  // engine returns every active staff member's overload status.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const r = await getStaffAvailability(slug, null);
        if (cancelled || !r.ok) return;
        setOverloadedStaff(
          r.staff
            // Only count staff who actually have walk-ins queued ahead —
            // bookingsNext2h alone (no walk-ins) should not trigger overload banners.
            .filter((s) => s.overloaded && s.queueAhead > 0)
            .map((s) => ({ name: s.staffName, queueAhead: s.queueAhead })),
        );
      } catch {
        /* swallow — banner is non-critical */
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [slug, nowIso, queueItems.length]);

  const inProgressToday = data.bookingsForDay.filter((b) => b.status === "in_progress").length;

  // Walk-in slide-over toggle state — see DASHBOARD_LAYOUT_RULES §11.
  // The hook handles the auto-open contract (waiting > 0 → open
  // unless the user explicitly closed in this session).
  const queueWaitingCount = queueItems.length;
  const queueUrgentCount = useMemo(() => {
    let n = 0;
    for (const q of queueItems) {
      if (
        isWalkinUrgent({
          joinedQueueAtIso: q.joined_queue_at,
          staffRequestNote: q.staff_request_note,
          nowIso,
        })
      ) {
        n += 1;
      }
    }
    return n;
  }, [queueItems, nowIso]);
  const {
    open: queuePanelOpen,
    setOpen: setQueuePanelOpen,
    toggle: toggleQueuePanel,
  } = useQueuePanelOpen(queueWaitingCount);

  const rush = useRushHourMode({
    queueLength: queueWaitingCount,
    overloadedStaffCount: overloadedStaff.length,
  });

  // Auto-open queue panel on rush activation. The panel hook already
  // handles the "user dismissed" contract, so we only force-open on
  // the leading edge.
  const prevRushActiveRef = useRef(false);
  useEffect(() => {
    if (rush.active && !prevRushActiveRef.current) {
      setQueuePanelOpen(true);
      void logSalonRushEvent(slug, data.salon.id, "rush_hour_started", {
        queueLength: queueWaitingCount,
        overloadedStaffCount: overloadedStaff.length,
      });
    } else if (!rush.active && prevRushActiveRef.current) {
      void logSalonRushEvent(slug, data.salon.id, "rush_hour_ended", {
        queueLength: queueWaitingCount,
      });
    }
    prevRushActiveRef.current = rush.active;
  }, [
    rush.active,
    setQueuePanelOpen,
    slug,
    data.salon.id,
    queueWaitingCount,
    overloadedStaff.length,
  ]);

  const onSetSoftHold = async (bookingId: string, minutes: number) => {
    const r = await setSoftHoldAction(slug, {
      salonId: data.salon.id,
      bookingId,
      minutes,
    });
    if (!r.ok) {
      setShakeMessage(mutationMessage(messages.receptionist, r.error));
      return { ok: false, error: r.error };
    }
    // eslint-disable-next-line react-hooks/immutability -- ARCHITECTURE_LOCK: reloadCurrentDay is declared below via useCallback; hoisting order is intentional
    await reloadCurrentDay();
    router.refresh();
    return { ok: true, holdUntilIso: r.holdUntilIso };
  };

  const onClearSoftHold = async (bookingId: string) => {
    const r = await clearSoftHoldAction(slug, {
      salonId: data.salon.id,
      bookingId,
      reason: "returned",
    });
    if (!r.ok) {
      setShakeMessage(mutationMessage(messages.receptionist, r.error));
      return { ok: false, error: r.error };
    }
    await reloadCurrentDay();
    router.refresh();
    return { ok: true };
  };

  // Auto-expire sweep — minute tick checks the queue for any held
  // rows whose hold has passed, then clears them server-side. Each
  // clear logs a `soft_hold_expired` event and surfaces a notice
  // on the receptionist's status line.
  useEffect(() => {
    const expired = queueItems.filter((q) => {
      if (!q.soft_hold_until) return false;
      const ms = Date.parse(q.soft_hold_until);
      return Number.isFinite(ms) && ms <= Date.parse(nowIso);
    });
    if (expired.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const q of expired) {
        if (cancelled) break;
        await clearSoftHoldAction(slug, {
          salonId: data.salon.id,
          bookingId: q.id,
          reason: "expired",
        });
        if (!cancelled) {
          setShakeMessage(
            messages.receptionist.queue.softHoldExpiredNotice.replace(
              "{name}",
              q.client_name,
            ),
          );
        }
      }
      if (!cancelled) {
        await reloadCurrentDay();
        router.refresh();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nowIso ticks every minute, queueItems changes on reload
  }, [nowIso]);

  const assignedSlot =
    assigningWalkinId !== null
      ? (() => {
          const qi = queueItems.find((x) => x.id === assigningWalkinId);
          const span = qi ? walkinEffectiveSpanMinutes(qi, data.services) : null;
          return qi !== undefined && span !== null && qi.client_name.trim().length
            ? {
                queueItemId: qi.id,
                clientName: qi.client_name.trim(),
                serviceDurationMinutes: span,
              }
            : null;
        })()
      : null;

  const timezone = data.salon.timezone;
  const isViewingToday = data.selectedDate === salonToday(timezone, nowIso);

  /**
   * Pre-resolved hint for WeekView / MonthView.
   * Lets getBookingsForRangeAction skip the 3-call getDashboardWriteClient
   * chain (getUser → salon_members → salons) and instead run the membership
   * check and the bookings query in parallel — cutting ~2 round-trips per
   * week/month navigation event.
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- data.salon.id and timezone are stable refs (come from the same immutable salon row)
  const calendarHint = useMemo<BookingsRangeHint>(
    () => ({ salonId: data.salon.id, timezone }),
    // Re-memoize only when the salon id or timezone actually changes
    // (should never happen mid-session, but guards against future hot-reload).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.salon.id, timezone],
  );
  const modules = data.dashboardModules;
  // Rush mode forces density to "simple" so the desk renders with
  // the highest-contrast / lowest-noise rhythm. We override the
  // visual config without persisting back to the salon — when rush
  // clears, density returns to the user's saved choice.
  const effectiveDensity = rush.active ? "simple" : data.dashboardDensity;
  const densityConfig = useMemo(
    () => densityConfigFor(effectiveDensity),
    [effectiveDensity],
  );

  const onDensityChanged = useCallback((next: DensityLevel) => {
    // Optimistic — slider has already flipped its local state. Reflect
    // the new salon-wide density in the loaded data so downstream
    // components (BookingBlock, StaffTimelineGrid) re-render with the
    // new visual rhythm.
    setData((d) => ({ ...d, dashboardDensity: next }));
  }, []);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- ARCHITECTURE_LOCK: memoization could not be preserved; used by handlers declared earlier in component scope
  const reloadCurrentDay = useCallback(async () => {
    const ymd = salonDateOffset(timezone, dateOffset, nowIsoRef.current);
    const res = await loadReceptionistCenterDataAction(slug, ymd);
    if (res.ok) {
      setData(res.data);
    } else {
      setShakeMessage(loadErrorCopy(messages.receptionist, res.error));
    }
  }, [slug, timezone, dateOffset, messages.receptionist]);

  /**
   * Called when a booking chip is clicked from Week or Month view.
   * Loads that day's data (so the drawer's `openDrawerBooking` lookup
   * finds the booking in `data.bookingsForDay`), then opens the drawer.
   */
  const onBookingClickFromCalendar = useCallback(
    async (bookingId: string, ymd: string) => {
      setDayLoading(true);
      const res = await loadReceptionistCenterDataAction(slug, ymd);
      setDayLoading(false);
      if (res.ok) {
        setData(res.data);
        setDrawerBookingId(bookingId);
      } else {
        setShakeMessage(loadErrorCopy(messages.receptionist, res.error));
      }
    },
    [slug, messages.receptionist],
  );

  const onWalkinAssignSlot = async (staffId: string, slotStartUtc: string) => {
    const assignBookingId = assigningWalkinId;
    if (!assignBookingId || assignedSlot === null) return;
    const qi = queueItems.find((x) => x.id === assignBookingId);
    const spanMinutes = qi ? walkinEffectiveSpanMinutes(qi, data.services) : null;
    if (!qi || spanMinutes === null || spanMinutes < 1) {
      setShakeMessage(messages.receptionist.actionErrorFallback);
      return;
    }

    const startMs = Date.parse(slotStartUtc);
    if (Number.isNaN(startMs)) return;
    const endUtcIso = new Date(startMs + spanMinutes * 60_000).toISOString();

    const hit = checkBookingConflict({
      staffId,
      startUtcIso: slotStartUtc,
      endUtcIso: endUtcIso,
      existingBookings: conflictRows(gridBookings),
    });
    if (hit !== null) {
      const line = messages.receptionist.grid.conflictWith(hit.client_name);
      setShakeMessage(line);
      return;
    }

    const res = await assignWalkinToSlot(slug, {
      salonId: data.salon.id,
      bookingId: assignBookingId,
      staffId,
      slotStartUtc,
    });
    if (!res.ok) {
      setShakeMessage(mutationMessage(messages.receptionist, res.error));
      return;
    }

    const staffName = staffNameById.get(staffId)?.trim() || messages.receptionist.drawer.none;
    const svcName = qi.service_name?.trim() || messages.receptionist.drawer.none;
    const headline = `${messages.receptionist.undo.assignedPrefix} ${qi.client_name.trim()} ${messages.receptionist.undo.assignedMiddle} ${staffName}`;
    const startLabel = formatInSalonTz(slotStartUtc, timezone, "time");
    const detailLine = `${startLabel} · ${svcName}`;

    setAssigningWalkinId(null);
    setUndoState({
      bookingId: assignBookingId,
      headline,
      detailLine,
      secondsRemaining: 5,
      type: "assign",
    });
    await reloadCurrentDay();
    router.refresh();
  };

  const undoAssign = async () => {
    if (!undoState) return;
    const res = await undoWalkinAssignment(slug, {
      salonId: data.salon.id,
      bookingId: undoState.bookingId,
    });
    if (!res.ok) {
      setShakeMessage(
        res.error === "already_started"
          ? messages.receptionist.undo.undoFailed
          : mutationMessage(messages.receptionist, res.error),
      );
    }
    setUndoState(null);
    await reloadCurrentDay();
    router.refresh();
  };

  const undoCancel = async () => {
    if (!undoState) return;
    const res = await undoCancelBooking(slug, {
      salonId: data.salon.id,
      bookingId: undoState.bookingId,
    });
    if (!res.ok) {
      setShakeMessage(mutationMessage(messages.receptionist, res.error));
    }
    setUndoState(null);
    await reloadCurrentDay();
    router.refresh();
  };

  const onUndoToastUndo = undoState?.type === "cancel" ? undoCancel : undoAssign;

  useEffect(() => {
    if (typeof window === "undefined") return;

    let cancelled = false;
    const supabase = createClient();

    const cleanupPromise = (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return undefined;

      if (!session) {
        const pollInterval = window.setInterval(() => {
          if (!cancelled) void reloadCurrentDay();
        }, 8000);
        return () => {
          window.clearInterval(pollInterval);
        };
      }

      supabase.realtime.setAuth(session.access_token);

      const {
        data: { subscription: authSubscription },
      } = supabase.auth.onAuthStateChange((_event, newSession) => {
        supabase.realtime.setAuth(newSession?.access_token ?? null);
      });

      const filter = `salon_id=eq.${data.salon.id}`;
      const ch = supabase
        .channel(`receptionist-center-${data.salon.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "bookings",
            filter,
          },
          () => {
            if (!cancelled) void reloadCurrentDay();
          },
        )
        .subscribe((status, err) => {
          // Map Supabase realtime status → operational connection state.
          // SUBSCRIBED is the healthy steady-state; CHANNEL_ERROR /
          // TIMED_OUT both mean "trying to recover" → reconnecting;
          // CLOSED is the terminal disconnect → offline. `setState`
          // from useState is stable so this is closure-safe.
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            setConnectionState("connected");
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setConnectionState("reconnecting");
          } else if (status === "CLOSED") {
            setConnectionState("offline");
          }
          if (
            status === "CHANNEL_ERROR" ||
            status === "TIMED_OUT" ||
            status === "CLOSED"
          ) {
            // Production telemetry: realtime subscription health
            // tells us about Supabase realtime degradations affecting
            // the desk. Captured as a warning event (not exception)
            // since the polling fallback / banner already keeps the
            // user productive.
            Sentry.captureEvent({
              message: `realtime subscription ${status.toLowerCase()}`,
              level: status === "CLOSED" ? "warning" : "info",
              tags: {
                "nailiq.event": "realtime_subscription_failure",
                "nailiq.surface": "receptionist_center",
                "nailiq.realtime_status": status,
              },
              extra: {
                salonId: data.salon.id,
                err: err ? String(err) : null,
              },
            });
          }
          if (
            process.env.NODE_ENV === "development" &&
            (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || err)
          ) {
            console.warn("[ReceptionistCenter realtime]", status, err);
          }
        });

      if (cancelled) {
        authSubscription.unsubscribe();
        void supabase.removeChannel(ch);
        return undefined;
      }

      return () => {
        authSubscription.unsubscribe();
        void supabase.removeChannel(ch);
      };
    })();

    return () => {
      cancelled = true;
      void cleanupPromise.then((cleanup) => {
        cleanup?.();
      });
    };
  }, [data.salon.id, reloadCurrentDay]);

  /**
   * Sound-alert change detector. Three triggers:
   *   - `vip_arrival` — a walk-in row appears whose id we haven't
   *     seen before AND whose `walkin_source === "vip"`. Takes
   *     precedence over `new_walkin` (warm chime > generic two-tone)
   *     so receptionists hear the VIP cue distinctly.
   *   - `new_walkin` — walkin queue length increases AND no VIP
   *     arrival fired this tick. Dedupe-by-length avoids re-firing
   *     when the same walk-ins reload.
   *   - `overdue_booking` — an `in_progress` booking whose end_time
   *     is now in the past, fired ONCE per booking id (set-tracked).
   *
   * Initial render seeds the seen-sets without firing alerts so the
   * first paint after a reload doesn't dump every existing late /
   * VIP entry as a chord. Module gate is checked inside `playAlert`;
   * effect always runs so the seen-sets stay current even when
   * audio is off (toggling on later doesn't replay history).
   */
  const hasSoundInitedRef = useRef(false);
  const prevWalkinCountRef = useRef(0);
  const seenVipIdsRef = useRef<Set<string>>(new Set());
  const seenLateIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const queueLength = data.walkinQueue.length;
    const nowMs = Date.parse(nowIso);

    if (!hasSoundInitedRef.current) {
      // Seed only — no alerts on initial mount / reload.
      for (const q of data.walkinQueue) {
        if (q.walkin_source === "vip") seenVipIdsRef.current.add(q.id);
      }
      for (const b of data.bookingsForDay) {
        const endMs = Date.parse(b.end_time_utc);
        if (
          b.status === "in_progress" &&
          Number.isFinite(endMs) &&
          endMs < nowMs
        ) {
          seenLateIdsRef.current.add(b.id);
        }
      }
      prevWalkinCountRef.current = queueLength;
      hasSoundInitedRef.current = true;
      return;
    }

    // VIP arrivals (precedence over plain new_walkin).
    let firedVip = false;
    for (const q of data.walkinQueue) {
      if (q.walkin_source === "vip" && !seenVipIdsRef.current.has(q.id)) {
        seenVipIdsRef.current.add(q.id);
        playAlert("vip_arrival");
        firedVip = true;
      }
    }

    // Plain new walk-in (only when no VIP fired this tick).
    if (!firedVip && queueLength > prevWalkinCountRef.current) {
      playAlert("new_walkin");
    }
    prevWalkinCountRef.current = queueLength;

    // Newly overdue bookings.
    for (const b of data.bookingsForDay) {
      if (b.status !== "in_progress") continue;
      const endMs = Date.parse(b.end_time_utc);
      if (!Number.isFinite(endMs) || endMs >= nowMs) continue;
      if (seenLateIdsRef.current.has(b.id)) continue;
      seenLateIdsRef.current.add(b.id);
      playAlert("overdue_booking");
    }
  }, [data.walkinQueue, data.bookingsForDay, nowIso, playAlert]);

  const detailModel = useMemo((): BookingDetailDrawerModel | null => {
    const id = drawerBookingId;
    if (!id) return null;
    const b = data.bookingsForDay.find((x) => x.id === id);
    if (!b) return null;

    const staffName = staffNameById.get(b.staff_id) ?? messages.receptionist.drawer.none;

    let telHref: string | null = null;
    let phoneDisplay: string | null = null;
    let phoneMasked: string | null = null;
    if (b.client_phone?.trim()) {
      const raw = cleanPhone(b.client_phone);
      telHref = raw.length ? raw : null;
      phoneDisplay = formatPhone(b.client_phone);
      if (!phoneDisplay) phoneDisplay = b.client_phone;
      // P0.8 — last-4 mask used as the drawer's default display.
      // Drives the `phoneRevealed=false` render path.
      phoneMasked = maskPhoneDigits(b.client_phone);
    }

    const dateStr = formatInSalonTz(b.start_time_utc, timezone, "date");
    const t0 = formatInSalonTz(b.start_time_utc, timezone, "time");
    const timeSep = messages.receptionist.drawer.scheduleTimeRangeSep;
    const mainDurMin = Math.max(
      0,
      Math.round(Number(b.service_duration_minutes ?? 0)),
    );
    const mainBufMin = Math.max(
      0,
      Math.round(Number(b.service_buffer_minutes ?? 0)),
    );
    const addonDurMin = Math.max(
      0,
      Math.round(Number(b.addon_duration_minutes ?? 0)),
    );
    const addonBufMin = Math.max(
      0,
      Math.round(Number(b.addon_buffer_minutes ?? 0)),
    );
    // Total span = main service + main buffer + addon service + addon buffer.
    // Used for the schedule "ends at" recompute and the duration row.
    const durMin = mainDurMin + addonDurMin;
    const bufMin = mainBufMin + addonBufMin;

    const startMs = Date.parse(b.start_time_utc);
    const serviceEndIso =
      Number.isFinite(startMs) && durMin > 0
        ? new Date(startMs + durMin * 60_000).toISOString()
        : b.end_time_utc;

    let scheduleLine: string;
    if (bufMin > 0 && durMin > 0 && Number.isFinite(startMs)) {
      const svcEndLabel = formatInSalonTz(serviceEndIso, timezone, "time");
      const bufferSeg = messages.receptionist.drawer.bufferNote.replace(
        "{n}",
        String(bufMin),
      );
      scheduleLine = `${dateStr} · ${t0}${timeSep}${svcEndLabel} • ${bufferSeg}`;
    } else {
      const t1 = formatInSalonTz(b.end_time_utc, timezone, "time");
      scheduleLine = `${dateStr} · ${t0}${timeSep}${t1}`;
    }

    const durationLine = messages.receptionist.drawer.durationMinutes.replace(
      "{n}",
      String(durMin),
    );

    // Sum main + addon prices. Use 0 fallbacks so a booking with only an
    // addon price still renders. Returns null only when both are missing.
    const mainCents =
      b.price_cents != null && Number.isFinite(b.price_cents)
        ? Number(b.price_cents)
        : null;
    const addonCents =
      b.addon_price_cents != null && Number.isFinite(b.addon_price_cents)
        ? Number(b.addon_price_cents)
        : null;
    const totalCents =
      mainCents != null || addonCents != null
        ? (mainCents ?? 0) + (addonCents ?? 0)
        : null;
    // P0.2 — render in the salon's configured currency rather than a
    // hardcoded "$". formatCurrency returns null for null/NaN cents
    // so the existing "no price" path still works.
    // Per-booking price in the drawer is operational data receptionists
    // need regardless of the revenue_today KPI module toggle — the
    // module gates the daily total bar, not the per-booking price line.
    const priceLine =
      totalCents != null
        ? formatCurrency(totalCents, data.salon.currencyCode)
        : null;

    const addonServiceName = b.addon_service_name?.trim()
      ? b.addon_service_name.trim()
      : null;
    const addonDurationLine =
      addonServiceName && addonDurMin > 0
        ? messages.receptionist.drawer.durationMinutes.replace(
            "{n}",
            String(addonDurMin),
          )
        : null;

    const sourceLabel =
      b.source === "walkin"
        ? messages.receptionist.drawer.sourceWalkin
        : messages.receptionist.drawer.sourceAppointment;

    return {
      clientName: b.client_name,
      telHref,
      phoneDisplay,
      phoneMasked,
      clientNotes: b.client_notes ?? null,
      serviceName: b.service_name,
      staffName,
      status: b.status,
      statusLabel: bookingStatusLabel(messages, b.status),
      sourceLabel,
      // Reuse the timeline-chip flag — same server-derived signal,
      // same heart icon meaning. Drives the "Khách yêu cầu thợ này"
      // line under the source label.
      staffRequestedByClient: b.has_staff_request,
      scheduleLine,
      durationLine,
      priceLine,
      addonServiceName,
      addonDurationLine,
      verificationMethod: b.verification_method ?? null,
      smsFailedAt: b.sms_confirmation_failed_at ?? null,
      noShowRiskScore: b.no_show_risk_score ?? null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ARCHITECTURE_LOCK: data.salon.currencyCode is intentionally omitted; it never changes within a session and adding it would cause memo churn
  }, [
    drawerBookingId,
    data.bookingsForDay,
    data.dashboardModules.revenue_today,
    staffNameById,
    messages,
    timezone,
  ]);

  const openDrawerBooking = drawerBookingId
    ? data.bookingsForDay.find((x) => x.id === drawerBookingId)
    : null;

  const drawerCopy = useMemo(() => {
    const d = messages.receptionist.drawer;
    return {
      title: d.title,
      closeAria: d.closeAria,
      sectionGuest: messages.salonDashboard.client,
      sectionService: messages.salonDashboard.service,
      sectionStaff: messages.salonDashboard.salonStaffLabel,
      sectionWhen: d.scheduleSection,
      sectionStatus: d.statusSection,
      sectionNotes: messages.salonDashboard.clientNotes,
      sectionPrice: d.priceSection,
      sectionAddon: d.sectionAddon,
      noNotes: d.noNotesHint,
      callGuest: d.callGuest,
      callGuestShort: d.callGuestShort,
      phoneSection: d.phoneSection,
      revealPhone: d.revealPhone,
      hidePhone: d.hidePhone,
      nonePrice: d.none,
      // Same string as the walk-in add form's checkbox — single
      // source of truth for the "khách yêu cầu thợ này" copy across
      // the entire receptionist surface.
      staffRequestedByClient:
        messages.receptionist.queue.addForm.staffRequestedByClient,
    };
  }, [messages]);

  const onDateSwitchChange = async (next: -1 | 0 | 1) => {
    if (!timezone || dayLoading) return;
    const snapshot = dateOffset;
    setDateOffset(next);
    setDayLoading(true);
    setAssigningWalkinId(null);
    setUndoState(null);
    const ymd = salonDateOffset(timezone, next, nowIso);
    const res = await loadReceptionistCenterDataAction(slug, ymd);
    setDayLoading(false);
    if (!res.ok) {
      setDateOffset(snapshot);
      setShakeMessage(loadErrorCopy(messages.receptionist, res.error));
      return;
    }
    setData(res.data);
  };

  const onAddWalkin = async (input: {
    clientName: string;
    clientPhone: string;
    serviceId: string;
    staffRequestNote: string | null;
    staffRequestedByClient?: boolean;
    walkinSource?: import("@/shared/types").QueueSource | null;
    walkinPriority?: import("@/shared/types").QueuePriority | null;
    walkinRequestTags?: string[];
  }) => {
    const r = await addWalkinToQueue(slug, {
      salonId: data.salon.id,
      clientName: input.clientName,
      clientPhone: input.clientPhone,
      serviceId: input.serviceId,
      staffRequestNote: input.staffRequestNote ?? undefined,
      staffRequestedByClient: input.staffRequestedByClient === true,
      walkinSource: input.walkinSource ?? null,
      walkinPriority: input.walkinPriority ?? null,
      walkinRequestTags: input.walkinRequestTags ?? null,
    });
    if (!r.ok) {
      return {
        ok: false as const,
        error: mutationMessage(messages.receptionist, r.error),
      };
    }
    await reloadCurrentDay();
    router.refresh();
    return { ok: true as const };
  };

  const onAddAndAssign = async (input: {
    clientName: string;
    clientPhone: string;
    serviceId: string;
    staffId: string;
    startAtIso: string;
    staffRequestedByClient: boolean;
    walkinSource: import("@/shared/types").QueueSource | null;
    walkinPriority: import("@/shared/types").QueuePriority | null;
    walkinRequestTags: string[];
  }) => {
    const r = await addWalkinAndAssign(slug, {
      salonId: data.salon.id,
      clientName: input.clientName,
      clientPhone: input.clientPhone,
      serviceId: input.serviceId,
      staffId: input.staffId,
      startAtIso: input.startAtIso,
      staffRequestedByClient: input.staffRequestedByClient,
      walkinSource: input.walkinSource,
      walkinPriority: input.walkinPriority,
      walkinRequestTags: input.walkinRequestTags,
    });
    if (!r.ok) {
      return {
        ok: false as const,
        error: mutationMessage(messages.receptionist, r.error),
      };
    }
    await reloadCurrentDay();
    router.refresh();
    return { ok: true as const };
  };

  const onCancelWalkin = async (bookingId: string) => {
    const r = await cancelWaitingWalkin(slug, {
      salonId: data.salon.id,
      bookingId,
    });
    if (!r.ok) setShakeMessage(mutationMessage(messages.receptionist, r.error));
    else {
      await reloadCurrentDay();
      router.refresh();
    }
  };

  const onDrawerPrimaryAction = async () => {
    const id = drawerBookingId;
    if (!id) return;
    const b = data.bookingsForDay.find((x) => x.id === id);
    if (
      !b ||
      !(
        b.status === "pending" ||
        b.status === "confirmed" ||
        b.status === "in_progress"
      )
    )
      return;

    const nextStatus: BookingStatus =
      b.status === "pending" || b.status === "confirmed"
        ? "in_progress"
        : "completed";

    setDrawerBusy(true);
    try {
      const r = await updateBookingStatus(id, nextStatus, slug);
      if (!r.ok) {
        setShakeMessage(
          updateBookingStatusToastMessage(messages.receptionist, r),
        );
        return;
      }
      setDrawerBookingId(null);
      await reloadCurrentDay();
      router.refresh();
    } finally {
      setDrawerBusy(false);
    }
  };

  const onDrawerCancelBooking = async () => {
    const id = drawerBookingId;
    if (!id) return;
    const b = data.bookingsForDay.find((x) => x.id === id);
    if (
      !b ||
      !(b.status === "pending" || b.status === "confirmed" || b.status === "in_progress")
    )
      return;

    setDrawerBusy(true);
    try {
      const r = await cancelDeskBooking(slug, {
        salonId: data.salon.id,
        bookingId: id,
      });
      if (!r.ok) {
        setShakeMessage(mutationMessage(messages.receptionist, r.error));
      } else {
        // Close drawer and reload grid first so booking disappears
        setDrawerBookingId(null);
        await reloadCurrentDay();
        router.refresh();

        // Show undo toast — user can restore within 8s
        const u = messages.receptionist.undo;
        const startLabel = b.start_time_utc
          ? formatInSalonTz(b.start_time_utc, timezone, "time")
          : "";
        const svcName = b.service_name?.trim() || messages.receptionist.drawer.none;
        setUndoState({
          bookingId: id,
          headline: `${u.cancelledPrefix} ${b.client_name.trim()}`,
          detailLine: [startLabel, svcName].filter(Boolean).join(" · "),
          secondsRemaining: 8,
          type: "cancel",
        });
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  const rcMessages = messages.receptionist;

  // TV Mode preset → full-screen read-only display per
  // `DASHBOARD_LAYOUT_RULES.md` §3. Bypasses the three-zone shell
  // entirely; receptionists exit via the corner button which writes
  // `dashboard_preset = 'reception'` and reloads via realtime.
  if (data.dashboardPreset === "tv") {
    return (
      <TVModeView
        slug={slug}
        salonName={data.salon.name}
        staff={data.staff.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
        }))}
        bookingsForDay={data.bookingsForDay.map((b) => ({
          id: b.id,
          staff_id: b.staff_id,
          client_name: b.client_name,
          service_name: b.service_name,
          status: b.status,
        }))}
        walkinQueue={data.walkinQueue.map((q) => ({
          id: q.id,
          joined_queue_at: q.joined_queue_at,
        }))}
        nowIso={nowIso}
        timezone={timezone}
        messages={rcMessages}
      />
    );
  }

  const isSetupIncomplete =
    data.services.length === 0 || data.staff.length === 0;

  const setupCtaPath =
    data.services.length === 0
      ? `/dashboard/${encodeURIComponent(slug)}/setup/services`
      : `/dashboard/${encodeURIComponent(slug)}/setup/staff`;

  const drawerPrimaryAction =
    openDrawerBooking?.status === "pending" ||
    openDrawerBooking?.status === "confirmed"
      ? {
          label: rcMessages.drawer.startService,
          busy: drawerBusy,
          onPress: () => void onDrawerPrimaryAction(),
        }
      : openDrawerBooking?.status === "in_progress"
        ? {
            label: rcMessages.drawer.markComplete,
            busy: drawerBusy,
            onPress: () => void onDrawerPrimaryAction(),
          }
        : undefined;

  const drawerCancelAction =
    openDrawerBooking &&
    canCancelBooking(viewerRole) &&
    (openDrawerBooking.status === "pending" ||
      openDrawerBooking.status === "confirmed" ||
      openDrawerBooking.status === "in_progress")
      ? {
          label: rcMessages.drawer.cancelBooking,
          busy: drawerBusy,
          onPress: () => void onDrawerCancelBooking(),
        }
      : undefined;

  const onDrawerRestoreBooking = async () => {
    const id = drawerBookingId;
    if (!id) return;
    const b = data.bookingsForDay.find((x) => x.id === id);
    if (!b || b.status !== "cancelled") return;
    const d = messages.receptionist.drawer;
    if (!window.confirm(d.restoreConfirm(b.client_name))) return;

    setDrawerBusy(true);
    try {
      const r = await restoreCancelledBooking(slug, {
        salonId: data.salon.id,
        bookingId: id,
      });
      if (!r.ok) {
        const msg =
          r.error === "slot_conflict"
            ? d.restoreConflict
            : r.error === "booking_in_past"
              ? d.restorePast
              : mutationMessage(messages.receptionist, r.error);
        setShakeMessage(msg);
      } else {
        setDrawerBookingId(null);
        await reloadCurrentDay();
        router.refresh();
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  const drawerRestoreAction =
    openDrawerBooking &&
    canUndoCancel(viewerRole) &&
    openDrawerBooking.status === "cancelled" &&
    new Date(openDrawerBooking.start_time_utc).getTime() > Date.now() + 60_000
      ? {
          label: rcMessages.drawer.restoreBooking,
          busy: drawerBusy,
          onPress: () => void onDrawerRestoreBooking(),
        }
      : undefined;

  return (
    <>
      <div
        data-testid="receptionist-center-loaded"
        data-rush-mode={rush.active ? "on" : "off"}
        className={cn(
          "flex min-h-[100dvh] w-full flex-col bg-nq-bg",
          rush.active && "[&_[data-rush-fade]]:opacity-50",
        )}
      >
        {/* Hydration signal for E2E: only rendered after React useEffect fires. */}
        {rcHydrated && <span data-testid="rc-hydrated" aria-hidden="true" style={{ display: "none" }} />}
        {bookingLimitStatus && !bookingLimitStatus.isUnlimited ? (
          <div className="shrink-0 border-b border-nq-border/30 px-[var(--pad-nq-section-mobile)] py-2 md:px-6">
            <div className="mx-auto w-full max-w-[var(--max-nq-desktop)]">
              <BookingLimitBanner
                slug={slug}
                status={bookingLimitStatus}
                copy={rcMessages.bookingLimitBanner}
              />
            </div>
          </div>
        ) : null}
        {rush.active ? (
          <div
            data-testid="receptionist-rush-banner"
            role="status"
            className="shrink-0 border-b border-amber-500/45 bg-amber-400/15 px-[var(--pad-nq-section-mobile)] py-2 md:px-6"
          >
            <div className="mx-auto flex w-full max-w-[var(--max-nq-desktop)] items-center justify-between gap-2">
              <p className="text-sm font-semibold text-amber-800">
                {rcMessages.rushHour.bannerLabel.replace(
                  "{n}",
                  String(queueWaitingCount),
                )}
              </p>
              <button
                type="button"
                onClick={() => rush.setDismissed(true)}
                className="text-xs font-semibold text-amber-800/80 hover:text-amber-900"
                data-testid="receptionist-rush-banner-dismiss"
              >
                {rcMessages.rushHour.dismiss}
              </button>
            </div>
          </div>
        ) : null}
        <header className="shrink-0 border-b border-nq-muted/20 bg-nq-surface/90 px-[var(--pad-nq-section-mobile)] py-3 backdrop-blur-sm md:px-6">
          <div className="mx-auto flex w-full max-w-[var(--max-nq-desktop)] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 gap-y-2">
                <Link
                  href={`/dashboard/${encodeURIComponent(slug)}`}
                  className="truncate text-[13px] font-medium text-nq-primary hover:text-nq-primary/85"
                >
                  ← {rcMessages.navOwnerDashboard}
                </Link>
                <h1 className="truncate text-lg font-semibold text-nq-foreground md:text-xl">
                  {rcMessages.title}
                </h1>
              </div>
              <p className="truncate text-xs text-nq-muted md:text-sm">{data.salon.name}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {isViewingToday && modules.kpi_bar ? (
                <StatusPill
                  waitingCount={queueItems.length}
                  inProgressCount={inProgressToday}
                  labelWaiting={rcMessages.statusPill.waitingLabel}
                  labelInProgress={rcMessages.statusPill.inProgressLabel}
                />
              ) : null}
              {/*
               * Role-adaptive badge in the top bar. owner sees an
               * explicit "Owner view" affordance so the receptionist
               * UI's surfaces (revenue tile, customize chrome) don't
               * surprise; nail_tech sees a quieter "Tech view" tag so
               * they understand they're on a read-mostly mode.
               * `senior` shows nothing — matches PERMISSION_MATRIX §2
               * "senior runs the desk without alteration" — no
               * decoration needed. Pairs colored Badge variant with
               * text label per COLOR_TOKENS §5 (no hue-only encoding).
               */}
              {viewerRole === "owner" ? (
                <Badge
                  data-testid="role-badge-owner"
                  variant="info"
                  state="subtle"
                  size="sm"
                >
                  {rcMessages.roleBadge.ownerView}
                </Badge>
              ) : viewerRole === "nail_tech" ? (
                <Badge
                  data-testid="role-badge-nail-tech"
                  variant="neutral"
                  state="subtle"
                  size="sm"
                >
                  {rcMessages.roleBadge.nailTechView}
                </Badge>
              ) : null}
              {/*
               * Sound-unlock hint. Only renders when sound_alerts is
               * on AND the AudioContext hasn't yet been resumed by a
               * user gesture. Disappears the moment any tap/keystroke
               * unlocks audio. Static span (no motion) — UX_PRINCIPLES
               * §1 calm-by-default; the hint is informational, not a
               * call to action. Title attribute carries the localized
               * "click anywhere to enable" copy; the icon itself
               * pairs with `aria-label` so screen readers narrate
               * the state.
               */}
              {modules.sound_alerts && !isSoundUnlocked ? (
                <span
                  data-testid="sound-locked-hint"
                  role="status"
                  aria-label={rcMessages.soundUnlockHint}
                  title={rcMessages.soundUnlockHint}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-nq-muted/30 bg-nq-bg text-sm leading-none text-nq-muted"
                >
                  🔇
                </span>
              ) : null}
              {/*
               * Density slider: hidden for nail_tech since the server
               * action is owner-only and showing a visibly disabled
               * control adds chrome a tech doesn't need. Owner +
               * senior still see it (senior gets the forbidden toast
               * if they try to change — visible-but-locked path). PM
               * follow-up: introduce personal-vs-salon-wide split
               * per PERMISSION_MATRIX §3 to give senior write access
               * to a personal density.
               */}
              {viewerRole !== "nail_tech" ? (
                <span data-rush-fade>
                  <DensitySlider
                    slug={slug}
                    value={data.dashboardDensity}
                    labels={rcMessages.density}
                    onChanged={onDensityChanged}
                    onError={(msg) => setShakeMessage(msg)}
                  />
                </span>
              ) : null}
              {/* Day / Week view-mode toggle. Day is the live desk job;
                  Week is a read-only planning glance per
                  DASHBOARD_LAYOUT_RULES §3. Pair color with text label
                  per COLOR_TOKENS §5 — selected state uses the gold
                  family because this is a navigational commitment, not
                  a status. */}
              <div
                role="tablist"
                aria-label={rcMessages.viewMode.ariaLabel}
                data-testid="view-mode-toggle"
                data-rush-fade
                className="inline-flex overflow-hidden rounded-md border border-nq-border bg-nq-surface text-xs font-medium"
              >
                {(["day", "week", "month"] as const).map((mode) => {
                  const active = viewMode === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      data-testid={`view-mode-${mode}`}
                      onClick={() => onChangeViewMode(mode)}
                      className={cn(
                        "px-2.5 py-1 transition-colors",
                        active
                          ? "bg-nq-primary/15 text-nq-primary"
                          : "text-nq-muted hover:text-nq-foreground",
                      )}
                    >
                      {rcMessages.viewMode[mode]}
                    </button>
                  );
                })}
              </div>
              {/*
               * Prominent "+ Walk-in" CTA (P1 desk feedback: the queue
               * toggle alone wasn't an obvious "add a walk-in" entry).
               * Gold primary = the single high-commitment forward action
               * in the desk header (COLOR_TOKENS §6). Opens the queue
               * slide-over, which renders the quick-add form at its top.
               * Gated to the surfaces where adding is actually possible:
               * today's day view with the queue + quick-add modules on.
               */}
              {isViewingToday &&
              viewMode === "day" &&
              modules.queue_panel &&
              modules.quick_add ? (
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="header-add-walkin"
                  onClick={() => setQueuePanelOpen(true)}
                >
                  {rcMessages.queue.addWalkinCta}
                </Button>
              ) : null}
              {/*
               * Walk-in queue slide-over toggle. See
               * DASHBOARD_LAYOUT_RULES §11.3. Hidden when the queue
               * module is off (the slide-over wouldn't render anyway,
               * so don't surface a button that does nothing). Badge
               * color tracks operational urgency: red when any walk-in
               * is overdue, gold when ≥1 waiting but none urgent, no
               * badge when empty.
               */}
              {modules.queue_panel ? (
                <button
                  type="button"
                  onClick={toggleQueuePanel}
                  aria-label={rcMessages.queue.title}
                  aria-pressed={queuePanelOpen}
                  data-testid="queue-panel-toggle"
                  className={cn(
                    "relative inline-flex min-h-9 touch-manipulation items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45",
                    queuePanelOpen
                      ? "border-nq-primary/40 bg-nq-primary/15 text-nq-primary"
                      : "border-nq-border bg-nq-surface text-nq-muted hover:text-nq-foreground",
                  )}
                >
                  <Users className="h-4 w-4" aria-hidden />
                  <span className="hidden sm:inline">
                    {rcMessages.queue.toggleShort}
                  </span>
                  {queueWaitingCount > 0 ? (
                    <span
                      data-testid="queue-panel-toggle-badge"
                      className={cn(
                        "ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none",
                        queueUrgentCount > 0
                          ? "bg-nq-error text-nq-foreground"
                          : "bg-nq-primary text-nq-bg",
                      )}
                    >
                      {queueWaitingCount}
                    </span>
                  ) : null}
                </button>
              ) : null}
              <span data-rush-fade>
                <UserLanguageToggle
                  language={language}
                  onLanguageChange={setLanguage}
                />
              </span>
            </div>
          </div>
          <div
            className={cn(
              "mx-auto mt-3 flex w-full max-w-[var(--max-nq-desktop)] flex-wrap items-center gap-y-2",
              dayLoading && "pointer-events-none opacity-60",
            )}
            aria-busy={dayLoading}
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <DateSwitcher
                selectedOffset={dateOffset}
                onChange={(next) => void onDateSwitchChange(next)}
                labels={rcMessages.dateSwitcher}
              />
              {/*
                * Subtle pulse-dot replaces the prior "Loading day..."
                * text. QA reported the text "lingered too long" — really
                * the abrupt show/hide flickered + the bare text gave no
                * visual continuity with the date-switcher's
                * `pointer-events-none opacity-60` cue. The dot pulses
                * via existing motion tokens and `animate-pulse` so it
                * reads as a calm in-progress signal; full text stays
                * reachable as the aria-label for screen readers.
                */}
              {dayLoading ? (
                <span
                  role="status"
                  aria-label={rcMessages.loadingDay}
                  className="inline-flex items-center gap-1.5 text-xs text-nq-muted"
                >
                  <span
                    aria-hidden
                    className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-nq-primary/80"
                  />
                </span>
              ) : null}
            </div>
            {isViewingToday ? (
              <button
                type="button"
                data-testid="jump-to-now"
                onClick={() => setJumpToNowTrigger((n) => n + 1)}
                className="shrink-0 rounded-full border border-nq-primary/35 bg-nq-primary/10 px-2.5 py-1 text-xs font-medium text-nq-primary transition hover:bg-nq-primary/[0.16] active:scale-[0.98] motion-reduce:active:scale-100"
              >
                {rcMessages.jumpToNow}
              </button>
            ) : null}
          </div>
        </header>

        {/*
         * Connection-state banner — mounted directly below the desk
         * header so the receptionist sees stale-data warnings before
         * scanning the timeline. Renders nothing when connected; when
         * reconnecting/offline, occupies a thin strip above the KPI
         * band. Layout-stable: AnimatePresence handles enter/exit so
         * the timeline geometry settles without a hard jump.
         */}
        <ConnectionBanner state={connectionState} labels={rcMessages.connection} />

        {/*
         * KPI band per `docs/DASHBOARD_LAYOUT_RULES.md` §5: top summary
         * band sits **above** the three-zone row, the grid shrinks
         * vertically by the band's height, and horizontal three-zone
         * allocation does not change. Today-only — KPIs reference live
         * "now" semantics (Coming up 30m, Overdue, Next available) so
         * historical/future date views must not pretend they are live.
         */}
        {isViewingToday && modules.kpi_bar ? (
          <KPIBar
            snapshot={data.kpiSnapshot}
            // Revenue tile composes the salon module gate AND a role
            // gate. PERMISSION_MATRIX §3 lists revenue as Partial for
            // all roles — module-gated for owner/senior, deny for
            // nail_tech (the matrix's nail_tech "No" on financial
            // exports + "Partial — read-only glimpses" on summaries).
            // Conservative deny on tech surface; owner/senior obey
            // the salon's existing module toggle.
            showRevenue={modules.revenue_today && viewerRole !== "nail_tech"}
            messages={rcMessages.kpiBar}
            currencyCode={data.salon.currencyCode}
            isLoading={dayLoading}
          />
        ) : null}

        {/* Party Card Panel — upcoming group bookings with party links.
            Rendered as a shrink-0 strip so the three-zone grid below
            adjusts its height automatically. Always mounted so its own
            empty state is reachable and the refresh control can surface
            newly-created party cards without a full page reload. */}
        <PartyCardPanel
          initialCards={partyCards}
          slug={slug}
          currencyCode={data.salon.currencyCode}
        />

        {modules.alerts && isSetupIncomplete ? (
          <div
            data-testid="setup-incomplete-banner"
            className="border-l-4 border-nq-warning bg-nq-warning/10 px-[var(--pad-nq-section-mobile)] py-4 md:px-6"
          >
            <div className="mx-auto w-full max-w-[var(--max-nq-desktop)]">
              <p className="font-semibold text-nq-foreground">
                {rcMessages.setupIncompleteBanner.title}
              </p>
              <p className="mt-1 text-sm text-nq-muted">
                {rcMessages.setupIncompleteBanner.message}
              </p>
              <Link
                href={setupCtaPath}
                className="mt-3 inline-block text-sm font-medium text-nq-primary hover:text-nq-primary/85"
              >
                {rcMessages.setupIncompleteBanner.cta}
              </Link>
            </div>
          </div>
        ) : null}

        {viewMode === "month" ? (
          <MonthView
            slug={slug}
            firstYmd={monthFirstYmd}
            timezone={timezone}
            todayYmd={salonToday(timezone, nowIso)}
            messages={rcMessages.monthView}
            hint={calendarHint}
            onDayClick={(ymd) => {
              // Switch to Day view for the tapped date.
              onChangeViewMode("day");
              const tz = timezone;
              const today = salonToday(tz, nowIso);
              const yesterday = salonDateOffset(tz, -1, nowIso);
              const tomorrow = salonDateOffset(tz, 1, nowIso);
              if (ymd === today) {
                void onDateSwitchChange(0);
              } else if (ymd === yesterday) {
                void onDateSwitchChange(-1);
              } else if (ymd === tomorrow) {
                void onDateSwitchChange(1);
              } else {
                void (async () => {
                  setDayLoading(true);
                  const res = await loadReceptionistCenterDataAction(slug, ymd);
                  setDayLoading(false);
                  if (res.ok) setData(res.data);
                  else setShakeMessage(loadErrorCopy(rcMessages, res.error));
                })();
              }
            }}
            onBookingClick={(bookingId, ymd) =>
              void onBookingClickFromCalendar(bookingId, ymd)
            }
            onPrevMonth={() => setMonthFirstYmd((m) => shiftMonth(m, -1))}
            onThisMonth={() =>
              setMonthFirstYmd(firstOfMonth(salonToday(timezone, nowIso)))
            }
            onNextMonth={() => setMonthFirstYmd((m) => shiftMonth(m, 1))}
          />
        ) : viewMode === "week" ? (
          <WeekView
            slug={slug}
            mondayYmd={weekMondayYmd}
            timezone={timezone}
            todayYmd={salonToday(timezone, nowIso)}
            messages={rcMessages.weekView}
            hint={calendarHint}
            onDayClick={(ymd) => {
              // Tapping a day flips back to Day view and (when the day
              // is yesterday/today/tomorrow) slots into the existing
              // dateOffset machinery; out-of-range days fall back to
              // today since DateSwitcher only models -1/0/+1.
              onChangeViewMode("day");
              const tz = timezone;
              const today = salonToday(tz, nowIso);
              const yesterday = salonDateOffset(tz, -1, nowIso);
              const tomorrow = salonDateOffset(tz, 1, nowIso);
              if (ymd === today) {
                void onDateSwitchChange(0);
              } else if (ymd === yesterday) {
                void onDateSwitchChange(-1);
              } else if (ymd === tomorrow) {
                void onDateSwitchChange(1);
              } else {
                // Day is outside the ±1 window — load that exact day
                // by directly calling the loader; dateOffset gets
                // reconciled by the existing reactive effect on
                // `data.selectedDate`.
                void (async () => {
                  setDayLoading(true);
                  const res = await loadReceptionistCenterDataAction(slug, ymd);
                  setDayLoading(false);
                  if (res.ok) setData(res.data);
                  else setShakeMessage(loadErrorCopy(rcMessages, res.error));
                })();
              }
            }}
            onBookingClick={(bookingId, ymd) =>
              void onBookingClickFromCalendar(bookingId, ymd)
            }
            onPrevWeek={() => setWeekMondayYmd((m) => shiftWeek(m, -1))}
            onThisWeek={() =>
              setWeekMondayYmd(mondayYmdOf(salonToday(timezone, nowIso)))
            }
            onNextWeek={() => setWeekMondayYmd((m) => shiftWeek(m, 1))}
          />
        ) : (
        <div
          // Day-view body now full-width on every viewport. The walk-in
          // queue moved into a fixed slide-over (DASHBOARD_LAYOUT_RULES
          // §11) so the timeline owns the row. When the slide-over is
          // open AND the viewport is md+, we add right-padding equal to
          // the panel width (320px) so the grid shrinks to make room
          // instead of being covered by the panel.
          className="mx-auto flex h-full min-h-[min(100dvh-8rem,48rem)] w-full flex-1 flex-col gap-0"
        >
          <section
            className={cn(
              "flex min-h-[min(50dvh,28rem)] min-w-0 flex-1 flex-col border-t border-nq-muted/20",
              "transition-[padding-right] duration-[var(--duration-nq-base)] ease-[var(--ease-nq-out)]",
              // Arbitrary value (`md:pr-[20rem]`) instead of `md:pr-80`
              // so Tailwind always emits the rule even if the static
              // utility hash changes between versions. Same 320px.
              isViewingToday && modules.queue_panel && queuePanelOpen
                ? "md:pr-[20rem]"
                : "",
            )}
          >
            <StaffTimelineGrid
              staff={gridStaff}
              bookings={gridBookings}
              assigning={assignedSlot}
              selectedDate={data.selectedDate}
              timezone={timezone}
              nowIso={nowIso}
              isViewingToday={isViewingToday}
              jumpToNowTrigger={jumpToNowTrigger}
              existingBookings={gridBookings}
              onBookingClick={(id) => setDrawerBookingId(id)}
              onSlotClick={(staffId, utc) => void onWalkinAssignSlot(staffId, utc)}
              onRescheduleBooking={async (bookingId, newStaffId, newStartUtc) => {
                const booking = data.bookingsForDay.find((b) => b.id === bookingId);
                if (!booking) return { ok: false, error: "not_found" };
                const result = await editBookingAction(slug, {
                  salonId: data.salon.id,
                  bookingId,
                  newStartTimeUtc: newStartUtc,
                  newStaffId,
                  newServiceId: booking.service_id,
                  newAddonServiceId: booking.addon_service_id ?? null,
                });
                if (result.ok) {
                  router.refresh();
                  return { ok: true };
                }
                return { ok: false, error: result.error };
              }}
              labels={{
                formatTimeLabel: (utcIso: string) => formatInSalonTz(utcIso, timezone, "shortTime"),
                conflictWith: rcMessages.grid.conflictWith,
                overflowMessage: rcMessages.grid.overflowMessage,
                bookingIcon: rcMessages.grid.bookingIcon,
              }}
              showStaffPerformanceDetail={modules.staff_performance}
              showTimelineHeatmap={modules.timeline_heatmap}
              showBookingPrices={modules.revenue_today && densityConfig.showPriceInBlock}
              showWalkinAccent={modules.vip_indicators}
              currencyCode={data.salon.currencyCode}
              showBookingMetaLine={densityConfig.showMetaLine}
              showBookingTimeRange={densityConfig.showTimeRangeInBlock}
              bookingBlockMinHeightPx={densityConfig.bookingBlockMinHeight}
              timeSlotMinutesVisualHint={densityConfig.timeSlotMinutes}
            />
          </section>
        </div>
        )}
      </div>

      {/*
       * Walk-in slide-over. Mounted at the receptionist root so its
       * fixed positioning is relative to the viewport. Only renders
       * on the day view (the queue is a "today" concept) and only
       * when the salon's queue_panel module is enabled. On mobile, a
       * backdrop appears beneath the panel and click-to-close.
       */}
      {viewMode === "day" && isViewingToday && modules.queue_panel ? (
        <>
          {/* Mobile backdrop — md:hidden so desktop just flexes the
              grid via pr-80 instead of dimming the rest of the desk. */}
          {queuePanelOpen ? (
            <button
              type="button"
              aria-hidden
              tabIndex={-1}
              onClick={() => setQueuePanelOpen(false)}
              className="md:hidden fixed inset-0 z-30 bg-nq-bg/60"
              data-testid="queue-panel-backdrop"
            />
          ) : null}

          <aside
            data-testid="queue-panel-slideover"
            aria-hidden={!queuePanelOpen}
            inert={!queuePanelOpen}
            aria-label={rcMessages.queue.title}
            className={cn(
              // Flex column so the header is shrink-0 and the body
              // owns the remaining vertical space — replaces the old
              // brittle `h-[calc(100%-44px)]` (would break the moment
              // the header wrapped to two lines).
              // overflow-x-hidden contains any wide form input
              // (priority select, request-tag chips) that might
              // otherwise visually escape the 320px panel.
              "fixed inset-y-0 right-0 z-40 flex w-80 max-w-full flex-col",
              "overflow-x-hidden",
              "bg-nq-surface border-l border-nq-border/40 shadow-nq-card",
              "transition-transform duration-[var(--duration-nq-base)] ease-[var(--ease-nq-out)]",
              queuePanelOpen ? "translate-x-0" : "translate-x-full",
            )}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-nq-border/40 px-3 py-2">
              <p className="min-w-0 truncate text-sm font-semibold text-nq-foreground">
                {rcMessages.queue.title}
              </p>
              <button
                type="button"
                onClick={() => setQueuePanelOpen(false)}
                aria-label={rcMessages.queue.closePanel}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-nq-border/40 bg-nq-surface/40 text-nq-muted transition-colors hover:bg-nq-surface/80 hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
              >
                <CloseIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <WalkinQueueSidebar
                assigningId={assigningWalkinId}
                items={queueItems}
                services={data.services.map((s) => ({
                  id: s.id,
                  name: s.name,
                  duration_minutes: s.duration_minutes,
                  price_cents: s.price_cents,
                }))}
                currency={data.salon.currencyCode}
                nowIso={nowIso}
                onAddWalkin={onAddWalkin}
                onAddAndAssign={onAddAndAssign}
                autoAssignEnabled={data.salon.walkinAutoAssign}
                onPhoneLookup={(phone) => lookupClientByPhone(slug, phone)}
                onCheckAvailability={
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- ARCHITECTURE_LOCK: staffId from prop not used; availability checked per-service not per-staff
                  ({ staffId: _staffId, serviceId }) =>
                  getStaffAvailability(slug, serviceId)
                }
                staffOptions={data.staff.map((s) => ({
                  id: s.id,
                  name: s.name,
                }))}
                overloadedStaff={overloadedStaff}
                onSetSoftHold={onSetSoftHold}
                onClearSoftHold={onClearSoftHold}
                rushMode={rush.active}
                waitLinkBaseUrl={
                  typeof window !== "undefined" ? window.location.origin : ""
                }
                waitLinkSalonSlug={slug}
                onCancelWalkin={onCancelWalkin}
                onStartAssign={(id) => setAssigningWalkinId(id)}
                onCancelAssign={() => setAssigningWalkinId(null)}
                addFormDisabled={isSetupIncomplete}
                isOffline={isOffline}
                offlineAddDisabledHint={rcMessages.connection.offlineAddDisabled}
                showQuickAdd={modules.quick_add}
                showWaitTime={modules.wait_time}
                showVipIndicator={modules.vip_indicators}
                compact={effectiveDensity === "simple"}
                queueDisplayMode={data.salon.queueDisplayMode}
                popularServiceIds={data.popularServiceIds}
                popularServicesLabel={rcMessages.popularServices.label}
                labels={{
                  title: rcMessages.queue.title,
                  emptyMessage: rcMessages.queue.emptyMessage,
                  cancelButton: rcMessages.queue.cancelButton,
                  assignButton: rcMessages.queue.assignButton,
                  urgentBadge: rcMessages.queue.urgentBadge,
                  waitingHint: rcMessages.queue.waitingHint,
                  minutesAgo: rcMessages.queue.minutesAgo,
                  sortLabel: rcMessages.queue.sortLabel,
                  sortFifo: rcMessages.queue.sortFifo,
                  sortLongestWait: rcMessages.queue.sortLongestWait,
                  sortCustom: rcMessages.queue.sortCustom,
                  avgWait: rcMessages.queue.avgWait,
                  priorityHigh: rcMessages.queue.priorityHigh,
                  priorityMedium: rcMessages.queue.priorityMedium,
                  priorityLow: rcMessages.queue.priorityLow,
                  partySizeLabel: rcMessages.queue.partySizeLabel,
                  sourceFallback: rcMessages.queue.sourceFallback,
                  waitHeroSuffix: rcMessages.queue.waitHeroSuffix,
                  vipAria: rcMessages.queue.vipAria,
                  readyAroundShort: rcMessages.queue.readyAroundShort,
                  requestedByClientLine:
                    rcMessages.queue.requestedByClientLine,
                  overloadBanner: rcMessages.queue.overloadBanner,
                  overloadBannerDismiss:
                    rcMessages.queue.overloadBannerDismiss,
                  softHoldButton: rcMessages.queue.softHoldButton,
                  softHoldClear: rcMessages.queue.softHoldClear,
                  softHoldLabel: rcMessages.queue.softHoldLabel,
                  softHoldCountdown: rcMessages.queue.softHoldCountdown,
                  waitLinkButton: rcMessages.queue.waitLinkButton,
                  waitLinkModal: rcMessages.queue.waitLinkModal,
                  addForm: {
                    ...rcMessages.queue.addForm,
                    invalidPhone: rcMessages.walkin.invalidPhone,
                    phoneRequired: rcMessages.walkin.phoneRequired,
                    nameRequired: rcMessages.walkin.nameRequired,
                    nameTooLong: rcMessages.walkin.nameTooLong,
                    invalidNameChars: rcMessages.walkin.invalidNameChars,
                  },
                }}
              />
            </div>
          </aside>
        </>
      ) : null}

      {shakeMessage !== null ? (
        <output
          data-testid="desk-action-message"
          className={cn(
            "fixed top-14 left-1/2 z-[55] max-w-[min(100vw-2rem,24rem)] -translate-x-1/2",
            "rounded-xl border border-nq-error/60 bg-nq-error/25 px-4 py-3 text-center text-xs font-semibold text-nq-foreground shadow-nq-card",
          )}
          aria-live="assertive"
        >
          {shakeMessage}
        </output>
      ) : null}

      <UndoToast
        open={undoState !== null}
        message={undoState?.headline ?? ""}
        detail={undoState?.detailLine ?? ""}
        secondsRemaining={undoState?.secondsRemaining ?? 0}
        showCountdown
        labelUndo={rcMessages.undo.undo}
        onUndo={() => void onUndoToastUndo()}
        onDismiss={() => setUndoState(null)}
      />

      <BookingDetailDrawer
        open={drawerBookingId !== null && detailModel !== null}
        model={detailModel}
        onClose={() => setDrawerBookingId(null)}
        copy={drawerCopy}
        viewerRole={viewerRole}
        isOffline={isOffline}
        offlineEditDisabledHint={rcMessages.connection.offlineEditDisabled}
        primaryAction={drawerPrimaryAction}
        cancelAction={drawerCancelAction}
        restoreAction={drawerRestoreAction}
        deskEdit={
          openDrawerBooking
            ? {
                slug,
                salonId: data.salon.id,
                booking: {
                  id: openDrawerBooking.id,
                  client_name: openDrawerBooking.client_name,
                  client_phone: openDrawerBooking.client_phone,
                  client_notes: openDrawerBooking.client_notes,
                  start_time_utc: openDrawerBooking.start_time_utc,
                  end_time_utc: openDrawerBooking.end_time_utc,
                  status: openDrawerBooking.status,
                  source: openDrawerBooking.source,
                  service_name: openDrawerBooking.service_name,
                  staff_name: staffNameById.get(openDrawerBooking.staff_id) ?? null,
                  price_cents: openDrawerBooking.price_cents ?? 0,
                  staff_id: openDrawerBooking.staff_id,
                  service_id: openDrawerBooking.service_id,
                  addon_service_id: openDrawerBooking.addon_service_id,
                  addon_service_name: openDrawerBooking.addon_service_name,
                  addon_duration_minutes: openDrawerBooking.addon_duration_minutes,
                  addon_buffer_minutes: openDrawerBooking.addon_buffer_minutes,
                  addon_price_cents: openDrawerBooking.addon_price_cents,
                  verification_method: openDrawerBooking.verification_method ?? null,
                  sms_confirmation_sent_at: openDrawerBooking.sms_confirmation_sent_at ?? null,
                  sms_confirmation_failed_at: openDrawerBooking.sms_confirmation_failed_at ?? null,
                  no_show_risk_score: openDrawerBooking.no_show_risk_score ?? null,
                },
                staff: data.staff.map((s) => ({ id: s.id, name: s.name })),
                services: data.services.map((s) => ({
                  id: s.id,
                  name: s.name,
                  price_cents: s.price_cents,
                  duration_minutes: s.duration_minutes,
                  buffer_minutes: s.buffer_minutes,
                })),
                capabilityRows: data.capabilityRows,
                dayYmd: data.selectedDate,
                timezone,
                rcMessages,
                currency: data.salon.currencyCode,
                onBookingUpdated: async () => {
                  await reloadCurrentDay();
                  router.refresh();
                },
              }
            : undefined
        }
      />
    </>
  );
}

export function ReceptionistCenter({
  slug,
  initialResult,
  viewerRole,
  bookingLimitStatus,
  partyCards,
}: ReceptionistCenterProps) {
  if (!initialResult.ok) {
    return <ReceptionistGateError code={initialResult.error} />;
  }
  return (
    <ReceptionistCenterInner
      slug={slug}
      initialOk={initialResult.data}
      viewerRole={viewerRole}
      bookingLimitStatus={bookingLimitStatus ?? null}
      partyCards={partyCards ?? []}
    />
  );
}
