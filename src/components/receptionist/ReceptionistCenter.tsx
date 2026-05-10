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
import type {
  LoadReceptionistCenterError,
  LoadReceptionistCenterResult,
  ReceptionistCenterData,
} from "@/shared/dashboard/loadReceptionistCenterData";
import { loadReceptionistCenterDataAction } from "@/shared/dashboard/loadReceptionistCenterDataAction";
import {
  addWalkinToQueue,
  assignWalkinToSlot,
  cancelDeskBooking,
  cancelWaitingWalkin,
  undoWalkinAssignment,
} from "@/shared/dashboard/receptionistActions";
import {
  type UpdateBookingStatusResult,
  updateBookingStatus,
} from "@/shared/dashboard/salonOwnerActions";
import { getUserMessages } from "@/shared/i18n/user";
import { checkBookingConflict, type ConflictCheckBooking } from "@/shared/lib/conflictCheck";
import { cn } from "@/shared/lib/cn";
import { cleanPhone, formatPhone } from "@/shared/lib/phoneFormat";
import { isWalkinUrgent } from "@/shared/lib/queueUrgency";
import { useQueuePanelOpen } from "@/shared/lib/useQueuePanelOpen";
import {
  canCancelBooking,
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

export type ReceptionistCenterProps = {
  slug: string;
  /** Server load result (`ok: false` shows localized shell only). */
  initialResult: LoadReceptionistCenterResult;
  /** Caller's `salon_members.role` — gates Edit/Cancel in the booking drawer. */
  viewerRole: SalonMemberRole;
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
}: {
  slug: string;
  initialOk: ReceptionistCenterData;
  viewerRole: SalonMemberRole;
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

  // View mode (Day | Week). Resolution order on mount:
  //   1. `?view=week` / `?view=day` URL param wins (sidebar Calendar tab
  //      links here with `?view=week` — we honour the deep link verbatim
  //      AND persist it so a reload from the same URL keeps the choice).
  //   2. localStorage `nailiq-view-mode` from a prior session.
  //   3. Default `day` — the live operational job is the day grid; week
  //      is a planning glance.
  // SSR-safe: state starts at `day`; the URL/localStorage sync runs in
  // an effect after mount.
  const urlViewParam = searchParams?.get("view") ?? null;
  const [viewMode, setViewMode] = useState<"day" | "week">("day");
  useEffect(() => {
    if (typeof window === "undefined") return;
    /* eslint-disable react-hooks/set-state-in-effect -- one-shot hydration from URL or localStorage */
    if (urlViewParam === "week") {
      setViewMode("week");
      window.localStorage.setItem("nailiq-view-mode", "week");
      return;
    }
    if (urlViewParam === "day") {
      setViewMode("day");
      window.localStorage.setItem("nailiq-view-mode", "day");
      return;
    }
    const stored = window.localStorage.getItem("nailiq-view-mode");
    if (stored === "week") setViewMode("week");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [urlViewParam]);
  const onChangeViewMode = useCallback((next: "day" | "week") => {
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

  // `data.staff` already carries the derived `status` / `workload` /
  // `skills` from `loadReceptionistCenterData`'s `enrichStaffRows` — pass
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
        skills: s.skills,
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
          status: b.status,
          source: b.source,
          staff_id: b.staff_id,
          start_time_utc: b.start_time_utc,
          end_time_utc: b.end_time_utc,
          price_cents: b.price_cents ?? null,
          is_vip: b.is_vip,
          has_notes: b.has_notes,
          has_design: b.has_design,
        },
      ];
    });
  }, [data.bookingsForDay]);

  const queueItems: QueueItem[] = data.walkinQueue;

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
  const modules = data.dashboardModules;
  const densityConfig = useMemo(
    () => densityConfigFor(data.dashboardDensity),
    [data.dashboardDensity],
  );

  const onDensityChanged = useCallback((next: DensityLevel) => {
    // Optimistic — slider has already flipped its local state. Reflect
    // the new salon-wide density in the loaded data so downstream
    // components (BookingBlock, StaffTimelineGrid) re-render with the
    // new visual rhythm.
    setData((d) => ({ ...d, dashboardDensity: next }));
  }, []);

  const reloadCurrentDay = useCallback(async () => {
    const ymd = salonDateOffset(timezone, dateOffset, nowIsoRef.current);
    const res = await loadReceptionistCenterDataAction(slug, ymd);
    if (res.ok) {
      setData(res.data);
    } else {
      setShakeMessage(loadErrorCopy(messages.receptionist, res.error));
    }
  }, [slug, timezone, dateOffset, messages.receptionist]);

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
    if (b.client_phone?.trim()) {
      const raw = cleanPhone(b.client_phone);
      telHref = raw.length ? raw : null;
      phoneDisplay = formatPhone(b.client_phone);
      if (!phoneDisplay) phoneDisplay = b.client_phone;
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
    const priceLine =
      data.dashboardModules.revenue_today && totalCents != null
        ? `$${(totalCents / 100).toFixed(2)}`
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
      clientNotes: b.client_notes ?? null,
      serviceName: b.service_name,
      staffName,
      statusLabel: bookingStatusLabel(messages, b.status),
      sourceLabel,
      scheduleLine,
      durationLine,
      priceLine,
      addonServiceName,
      addonDurationLine,
    };
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
      nonePrice: d.none,
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
    const d = messages.receptionist.drawer;
    if (!window.confirm(d.cancelConfirm(b.client_name))) return;

    setDrawerBusy(true);
    try {
      const r = await cancelDeskBooking(slug, {
        salonId: data.salon.id,
        bookingId: id,
      });
      if (!r.ok)
        setShakeMessage(mutationMessage(messages.receptionist, r.error));
      else {
        setDrawerBookingId(null);
        await reloadCurrentDay();
        router.refresh();
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
          skills: s.skills,
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

  return (
    <>
      <div
        data-testid="receptionist-center-loaded"
        className="flex min-h-[100dvh] w-full flex-col bg-nq-bg"
      >
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
                <DensitySlider
                  slug={slug}
                  value={data.dashboardDensity}
                  labels={rcMessages.density}
                  onChanged={onDensityChanged}
                  onError={(msg) => setShakeMessage(msg)}
                />
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
                className="inline-flex overflow-hidden rounded-md border border-nq-border bg-nq-surface text-xs font-medium"
              >
                {(["day", "week"] as const).map((mode) => {
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
              <UserLanguageToggle language={language} onLanguageChange={setLanguage} />
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
              {dayLoading ? (
                <span className="text-xs font-medium text-nq-muted">{rcMessages.loadingDay}</span>
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
            isLoading={dayLoading}
          />
        ) : null}

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

        {viewMode === "week" ? (
          <WeekView
            slug={slug}
            mondayYmd={weekMondayYmd}
            timezone={timezone}
            todayYmd={salonToday(timezone, nowIso)}
            messages={rcMessages.weekView}
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
              isViewingToday && modules.queue_panel && queuePanelOpen
                ? "md:pr-80"
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
              showBookingMetaLine={densityConfig.showMetaLine}
              showBookingTimeRange={densityConfig.showTimeRangeInBlock}
              showStaffSkillBadges={densityConfig.showSkillBadges}
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
            aria-label={rcMessages.queue.title}
            className={cn(
              "fixed inset-y-0 right-0 z-40 w-80 max-w-full",
              "bg-nq-surface border-l border-nq-border/40 shadow-nq-card",
              "transition-transform duration-[var(--duration-nq-base)] ease-[var(--ease-nq-out)]",
              queuePanelOpen ? "translate-x-0" : "translate-x-full",
            )}
          >
            <div className="flex items-center justify-between border-b border-nq-border/40 px-3 py-2">
              <p className="text-sm font-semibold text-nq-foreground">
                {rcMessages.queue.title}
              </p>
              <button
                type="button"
                onClick={() => setQueuePanelOpen(false)}
                aria-label={rcMessages.queue.closePanel}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-nq-border/40 bg-nq-surface/40 text-nq-muted transition-colors hover:bg-nq-surface/80 hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/45"
              >
                <CloseIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="h-[calc(100%-44px)] overflow-y-auto">
              <WalkinQueueSidebar
                assigningId={assigningWalkinId}
                items={queueItems}
                services={data.services.map((s) => ({
                  id: s.id,
                  name: s.name,
                  duration_minutes: s.duration_minutes,
                  price_cents: s.price_cents,
                }))}
                nowIso={nowIso}
                onAddWalkin={onAddWalkin}
                onCancelWalkin={onCancelWalkin}
                onStartAssign={(id) => setAssigningWalkinId(id)}
                onCancelAssign={() => setAssigningWalkinId(null)}
                addFormDisabled={isSetupIncomplete}
                isOffline={isOffline}
                offlineAddDisabledHint={rcMessages.connection.offlineAddDisabled}
                showQuickAdd={modules.quick_add}
                showWaitTime={modules.wait_time}
                showVipIndicator={modules.vip_indicators}
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
                  priorityHigh: rcMessages.queue.priorityHigh,
                  priorityMedium: rcMessages.queue.priorityMedium,
                  priorityLow: rcMessages.queue.priorityLow,
                  partySizeLabel: rcMessages.queue.partySizeLabel,
                  sourceFallback: rcMessages.queue.sourceFallback,
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
        onUndo={() => void undoAssign()}
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

export function ReceptionistCenter({ slug, initialResult, viewerRole }: ReceptionistCenterProps) {
  if (!initialResult.ok) {
    return <ReceptionistGateError code={initialResult.error} />;
  }
  return (
    <ReceptionistCenterInner
      slug={slug}
      initialOk={initialResult.data}
      viewerRole={viewerRole}
    />
  );
}
