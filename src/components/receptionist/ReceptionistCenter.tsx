"use client";

import * as Sentry from "@sentry/nextjs";
import { Users } from "lucide-react";

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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createClient } from "@/shared/lib/supabase/client";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import {
  BookingDetailDrawer,
  type BookingDetailDrawerModel,
} from "./BookingDetailDrawer";
import { ConnectionBanner, type ConnectionState } from "./ConnectionBanner";
import { DateSwitcher } from "./DateSwitcher";
import { ViewedDateChip } from "./ViewedDateChip";
import { DensitySlider } from "./DensitySlider";
import { KPIBar } from "./KPIBar";
import { BasicCockpit } from "./BasicCockpit";
import { useBasicMode } from "@/shared/dashboard/useBasicMode";
import type {
  CockpitInputs,
  CockpitLabels,
} from "@/shared/dashboard/basicModeCockpit";
import { StaffTimelineGrid, type GridBooking } from "./StaffTimelineGrid";
import { StatusPill } from "./StatusPill";
import { TVModeView } from "./TVModeView";
import { UndoToast } from "./UndoToast";
import { WalkinQueueSidebar, type QueueItem } from "./WalkinQueueSidebar";
import { OnlineWaitlistPanel } from "./OnlineWaitlistPanel";
import { WeekView, mondayYmdOf, shiftWeek } from "./WeekView";
import { MonthView, firstOfMonth, shiftMonth } from "./MonthView";
import VerticalDayView from "./VerticalDayView";
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
  cancelDeskGroup,
  restoreCancelledBooking,
  approveWixBooking,
  declineWixBooking,
  markNoShowBooking,
  undoNoShowBooking,
  setBookingFinalPrice,
  undoCancelBooking,
  cancelWaitingWalkin,
  undoWalkinAssignment,
  chargeNoShowFeeManual,
  waiveNoShowFee,
  deskClaimPartySlotAction,
} from "@/shared/dashboard/receptionistActions";
import { lookupClientByPhone } from "@/shared/dashboard/lookupClientByPhoneAction";
import { defaultNotifyOn } from "@/shared/dashboard/staffNotificationSettings";
import {
  NotifyCustomerPanel,
  type NotifyChannels,
} from "./NotifyCustomerPanel";
import { resolveCustomerLocale } from "@/shared/notifications/resolveCustomerLocale";
import { buildStaffActionSms } from "@/shared/notifications/staffActionMessages";
import { getStaffAvailability } from "@/shared/dashboard/availabilityEngine";
import {
  type UpdateBookingStatusResult,
  updateBookingStatus,
} from "@/shared/dashboard/salonOwnerActions";
import { editBookingAction } from "@/shared/dashboard/editBookingAction";
import { getUserMessages } from "@/shared/i18n/user";
import {
  checkBookingConflict,
  type ConflictCheckBooking,
} from "@/shared/lib/conflictCheck";
import { cn } from "@/shared/lib/cn";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
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
  canChangeBookingStatus,
  canMarkNoShow,
  canEditBooking,
  canUndoCancel,
  type SalonMemberRole,
} from "@/shared/lib/salonMemberRole";
import {
  formatInSalonTz,
  salonDateOffset,
  salonNowMinutes,
  salonToday,
  salonYmdOfUtc,
} from "@/shared/lib/salonTime";
import { useSoundAlerts } from "@/shared/lib/useSoundAlerts";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import {
  densityConfigFor,
  type DensityLevel,
} from "@/shared/dashboard/dashboardDensity";
import type { BookingStatus } from "@/shared/types";
import {
  DEFAULT_DRC_ACCENT,
  DEFAULT_DRC_BG,
  deriveDrcPalette,
  drcPaletteToCssVars,
} from "@/shared/lib/drcTheme";
import { DrcThemePicker } from "@/components/receptionist/DrcThemePicker";
import { BookingLimitBanner } from "@/components/dashboard/BookingLimitBanner";
import { PartyCardPanel } from "@/components/receptionist/PartyCardPanel";
import { AttentionChipBar } from "@/components/receptionist/AttentionChipBar";
import { NailiqSuggestionBar } from "@/components/receptionist/NailiqSuggestionBar";
import { DailyBriefCard } from "@/components/receptionist/DailyBriefCard";
import DeskBookingForm from "@/components/receptionist/DeskBookingForm";
import DeskGroupForm from "@/components/receptionist/DeskGroupForm";
import type { PartyCard } from "@/shared/dashboard/loadPartyCardsAction";
import { ClientProfile360Drawer } from "@/components/dashboard/ClientProfile360Drawer";
import {
  loadBookingCustomerContext,
  type BookingCustomerContext,
} from "@/shared/dashboard/loadBookingCustomerContextAction";

// Values that only exist on the client. Read through useSyncExternalStore so
// the server render and the first client render agree (no hydration mismatch)
// and React swaps the real value in once hydration completes — no effect
// writing state back on mount.
const noopSubscribe = () => () => {};
const getHydratedSnapshot = () => true;
const getServerFalseSnapshot = () => false;
const getWindowOrigin = () => window.location.origin;
const getServerEmptySnapshot = () => "";

export type ReceptionistCenterProps = {
  slug: string;
  /** Server load result (`ok: false` shows localized shell only). */
  initialResult: LoadReceptionistCenterResult;
  /** Caller's `salon_members.role` — gates Edit/Cancel in the booking drawer. */
  viewerRole: SalonMemberRole;
  /** Free-tier monthly booking-cap status. `null` if the loader
   *  couldn't fetch it (transient error — banner stays hidden). */
  bookingLimitStatus?:
    | import("@/shared/dashboard/loadBookingLimitStatus").BookingLimitStatus
    | null;
  /** Party cards for today + 7 days. Empty array if none or service-role key unavailable. */
  partyCards?: PartyCard[];
  /** Release flag `group_booking` (PR2). When false, the party-card strip is
   *  not rendered. Defaults to `true` so callers that don't resolve the flag
   *  are unaffected; the center page always passes the resolved value. */
  groupBookingEnabled?: boolean;
  /** Release flag `tv_mode` (PR2). When false, the TV-preset full-screen view
   *  is not taken even if `dashboard_preset === "tv"`. Defaults to `true`. */
  tvModeEnabled?: boolean;
  /** Owner-chosen DRC accent hex color (saved in feature_flags.drc_accent_color). */
  accentColor?: string | null;
  bgColor?: string | null;
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

function bookingStatusLabel(
  messages: ReturnType<typeof getUserMessages>,
  status: BookingStatus,
) {
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
  const sid = String(serviceId ?? "")
    .trim()
    .toLowerCase();
  const s = services.find(
    (row) =>
      String(row.id ?? "")
        .trim()
        .toLowerCase() === sid,
  );
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

function ReceptionistGateError({
  code,
}: {
  code: LoadReceptionistCenterError;
}) {
  const { language, setLanguage } = useUserLanguage();
  const messages = useMemo(() => getUserMessages(language), [language]);

  return (
    <div className="mx-auto flex max-w-[var(--max-nq-mobile)] flex-col gap-4 px-[var(--pad-nq-section-mobile)] py-10 text-center text-sm">
      <p className="text-nq-error">
        {loadErrorCopy(messages.receptionist, code)}
      </p>
      <div className="flex justify-center">
        <UserLanguageToggle
          language={language}
          onLanguageChange={setLanguage}
        />
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
  groupBookingEnabled,
  tvModeEnabled,
  accentColor,
  bgColor,
}: {
  slug: string;
  initialOk: ReceptionistCenterData;
  viewerRole: SalonMemberRole;
  bookingLimitStatus:
    | import("@/shared/dashboard/loadBookingLimitStatus").BookingLimitStatus
    | null;
  partyCards: PartyCard[];
  groupBookingEnabled: boolean;
  tvModeEnabled: boolean;
  accentColor: string | null;
  bgColor: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { language, setLanguage } = useUserLanguage();
  const messages = useMemo(() => getUserMessages(language), [language]);

  // DRC accent color theme — owner-chosen, saved in feature_flags.drc_accent_color.
  // useState for optimistic updates: picker updates immediately, server action saves async.
  const [drcAccent, setDrcAccent] = useState(accentColor ?? DEFAULT_DRC_ACCENT);
  const [drcBg, setDrcBg] = useState(bgColor ?? DEFAULT_DRC_BG);
  const drcCssVars = useMemo(
    () => drcPaletteToCssVars(deriveDrcPalette(drcAccent, drcBg)),
    [drcAccent, drcBg],
  );

  // Hoist --drc-page-bg to <html> so the sidebar (outside DRC's subtree)
  // can tint itself to match. Cleared on unmount so other pages are unaffected.
  useEffect(() => {
    document.documentElement.style.setProperty("--drc-page-bg", drcBg);
    return () => {
      document.documentElement.style.removeProperty("--drc-page-bg");
    };
  }, [drcBg]);

  // Empty-string initial value so SSR and client hydration produce the same
  // output (same pattern as `originBaseUrl` below). Initialising with
  // `new Date().toISOString()` makes the server-render timestamp differ from
  // the client hydration timestamp → React #418 mismatch on overdue overlays,
  // today-badge, and the now-line. After mount the useEffect sets the real time
  // immediately, then ticks every minute as before.
  const [nowIso, setNowIso] = useState<string>("");
  const nowIsoRef = useRef(nowIso);
  /* Sync ref via effect (not during render) so reloadCurrentDay's callback
     can read the latest value without including nowIso in its deps. */
  useEffect(() => {
    nowIsoRef.current = nowIso;
  });

  useEffect(() => {
    const update = () => setNowIso(new Date().toISOString());
    update(); // Populate immediately after hydration — then tick every minute.
    const tick = window.setInterval(update, 60_000);
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

  // Wall-clock of the last successful server sync (initial SSR load, then
  // every fresh refetch). Surfaced in the disconnect banner as "last updated";
  // that banner is hidden while connected, so the empty SSR value does not
  // participate in hydration.
  const [lastSyncedIso, setLastSyncedIso] = useState(nowIso);
  const markSynced = useCallback(() => {
    setLastSyncedIso(new Date().toISOString());
  }, [setLastSyncedIso]);

  // The day the user is actually viewing — the source of truth for reloads.
  const viewedYmdRef = useRef(data.selectedDate);
  useEffect(() => {
    viewedYmdRef.current = data.selectedDate;
  }, [data.selectedDate]);

  useEffect(() => {
    // Only adopt server-provided data when it's for the day the user is viewing.
    // A revalidatePath() / router.refresh() re-runs the loader for its DEFAULT
    // day (today); without this guard it would yank the grid back to today after
    // acting on a future day (drag-reschedule, edit, etc.). When the server day
    // differs, keep the viewed day — reloadCurrentDay already refreshed it.
    if (initialOk.selectedDate === viewedYmdRef.current) {
      setData({ ...initialOk, selectedDate: initialOk.selectedDate });
      setLastSyncedIso(new Date().toISOString());
    }
  }, [initialOk]);

  const [dateOffset, setDateOffset] = useState<-1 | 0 | 1>(0);

  // Detect mobile viewport for the VerticalDayView swap (< 640 px).
  // Defaults false (server + first render → desktop grid); effect flips it
  // after hydration so there's no SSR/client mismatch.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

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
      // Reset page scroll so the new view's content is visible from the top.
      // Month/week calendars can be taller than the viewport on mobile;
      // without this, switching to Day view leaves the user looking at
      // empty space below the grid.
      window.scrollTo({ top: 0, behavior: "instant" });
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
    const today = salonDateOffset(tz, 0, nowIso || undefined);
    /* eslint-disable react-hooks/set-state-in-effect -- reactive reconciliation of dateOffset against (selectedDate, today) */
    if (data.selectedDate === today) {
      setDateOffset(0);
    } else {
      const yesterday = salonDateOffset(tz, -1, nowIso || undefined);
      const tomorrow = salonDateOffset(tz, 1, nowIso || undefined);
      if (data.selectedDate === yesterday) setDateOffset(-1);
      else if (data.selectedDate === tomorrow) setDateOffset(1);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [data.salon.timezone, data.selectedDate, nowIso]);

  const [assigningWalkinId, setAssigningWalkinId] = useState<string | null>(
    null,
  );
  const [dayLoading, setDayLoading] = useState(false);

  const [drawerBookingId, setDrawerBookingId] = useState<string | null>(null);
  // Every open of the booking drawer is its own session. Anything fetched for
  // the drawer is keyed on this, so reopening the same booking starts from
  // loading again instead of rendering what the previous open had cached —
  // stale allergies or usual-staff after the record was just edited.
  // Open through openBookingDrawer only, never setDrawerBookingId directly.
  const [drawerOpenRevision, setDrawerOpenRevision] = useState(0);
  const openBookingDrawer = useCallback((bookingId: string) => {
    setDrawerOpenRevision((n) => n + 1);
    setDrawerBookingId(bookingId);
  }, []);
  const closeBookingDrawer = useCallback(() => {
    setDrawerBookingId(null);
  }, []);

  // Customer 360 profile drawer — opened from the booking detail drawer's
  // "Profile & history" button. Keyed by the guest's phone.
  const [open360Phone, setOpen360Phone] = useState<string | null>(null);

  // Lazy "customer launchpad" context (creator / allergies / return cadence)
  // for the open booking. `undefined` = loading, `null` = unavailable.
  // Tagged with every argument the request was made with, so `undefined`
  // (loading) falls out of "what is on screen has no answer yet" rather than
  // being written back from the effect. The drawer session revision is what
  // makes reopening the same booking a fresh load instead of a cache hit.
  const customerContextKey = drawerBookingId
    ? JSON.stringify([slug, drawerBookingId, drawerOpenRevision])
    : null;
  const [fetchedCustomerContext, setFetchedCustomerContext] = useState<{
    key: string;
    context: BookingCustomerContext | null;
  } | null>(null);
  const customerContext: BookingCustomerContext | null | undefined =
    customerContextKey && fetchedCustomerContext?.key === customerContextKey
      ? fetchedCustomerContext.context
      : undefined;
  useEffect(() => {
    const id = drawerBookingId;
    if (!id || !customerContextKey) return;
    const requestKey = customerContextKey;
    let cancelled = false;
    void loadBookingCustomerContext(slug, id)
      .then((res) => {
        if (cancelled) return;
        setFetchedCustomerContext({
          key: requestKey,
          context: res.ok ? res.context : null,
        });
      })
      .catch(() => {
        // The action itself rejected — settle as unavailable so the launchpad
        // stops showing its loading state forever.
        if (!cancelled) setFetchedCustomerContext({ key: requestKey, context: null });
      });
    return () => {
      cancelled = true;
    };
  }, [drawerBookingId, slug, customerContextKey]);

  // Deep-link `?booking=<id>` (e.g. Coco's "open this appointment" link): open
  // that booking's detail drawer once on mount. The page already loaded the
  // matching `?date`, so the booking is in this day's data. One-shot via a ref
  // so closing the drawer doesn't immediately re-open it.
  const urlBookingParam = searchParams?.get("booking") ?? null;
  const didOpenUrlBookingRef = useRef(false);
  useEffect(() => {
    if (didOpenUrlBookingRef.current || !urlBookingParam) return;
    if (data.bookingsForDay.some((b) => b.id === urlBookingParam)) {
      didOpenUrlBookingRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot deep-link open
      openBookingDrawer(urlBookingParam);
    }
  }, [urlBookingParam, data.bookingsForDay, openBookingDrawer]);

  // E2E hydration signal: renders only after the first client-side effect,
  // confirming React has fully hydrated and all event handlers are registered.
  // Used by gotoReceptionistCenter in e2e/receptionist-center/helpers.ts.
  const rcHydrated = useSyncExternalStore(
    noopSubscribe,
    getHydratedSnapshot,
    getServerFalseSnapshot,
  );

  const [undoState, setUndoState] = useState<UndoToastState | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  const undoVisible = undoState !== null;

  // Transient error toast (e.g. a drag-to-reschedule rejected by the server —
  // past date, slot conflict). Auto-clears so it never lingers.
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const errorToastTimerRef = useRef<number | null>(null);
  const showErrorToast = useCallback((message: string) => {
    setErrorToast(message);
    if (errorToastTimerRef.current)
      window.clearTimeout(errorToastTimerRef.current);
    errorToastTimerRef.current = window.setTimeout(
      () => setErrorToast(null),
      4500,
    );
  }, []);
  useEffect(
    () => () => {
      if (errorToastTimerRef.current)
        window.clearTimeout(errorToastTimerRef.current);
    },
    [],
  );

  // Bumped on every booking mutation (via reloadCurrentDay, which every
  // mutation + realtime change funnels through). Week/Month views include it
  // in their fetch deps so they refetch after a cancel/reschedule done from
  // their own drawer — otherwise a booking cancelled while in Week view lingers
  // in that view's local cache (its deps never changed). (QA #5.)
  const [calendarRefreshNonce, setCalendarRefreshNonce] = useState(0);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current !== null)
        window.clearInterval(undoTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (undoTimerRef.current !== null)
      window.clearInterval(undoTimerRef.current);
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
      if (undoTimerRef.current !== null)
        window.clearInterval(undoTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ARCHITECTURE_LOCK: intentionally keyed on undoVisible (boolean) not undoState object; prevents timer restart on secondsRemaining ticks
  }, [undoVisible]);

  const [shakeMessage, setShakeMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!shakeMessage) return;
    // 5s, not 2.4s: shakeMessage carries actionable errors ("Conflict with
    // {name}", assign failures) the receptionist must read to understand why an
    // action didn't land. 2.4s flashed too fast to read — and to assert in E2E.
    const t = window.setTimeout(() => setShakeMessage(null), 5000);
    return () => window.clearTimeout(t);
  }, [shakeMessage]);

  /** Increments when receptionist taps "Now" — grid smooth-scrolls to current slot. */
  const [jumpToNowTrigger, setJumpToNowTrigger] = useState(0);

  // Sidebar "Hàng chờ" (clock) tab deep-links to /center#queue. The effect that
  // OPENS the panel for that hash lives just after useQueuePanelOpen below (it
  // needs setQueuePanelOpen). The old version only scrolled, and only on mount,
  // so re-clicking the tab while already on the page did nothing.

  const [drawerBusy, setDrawerBusy] = useState(false);
  // No-show fee charge/waive modal — shown when a no-show'd booking has a Square
  // card on file (declared here, above the TV-mode early return, so the hook
  // order is stable). The charge/waive decision is wired in `triggerMarkNoShow`.
  const [noShowChargeModal, setNoShowChargeModal] = useState<{
    bookingId: string;
    feeCents: number;
  } | null>(null);
  // Pending desk-cancel that hit a paid deposit → ask refund-or-keep first.
  const [depositCancel, setDepositCancel] = useState<{
    id: string;
    amountCents: number;
  } | null>(null);
  // Cancel-confirm with the "notify the customer?" panel (non-deposit path).
  const [notifyCancel, setNotifyCancel] = useState<{ id: string } | null>(null);
  // For a booking that is one member of a party, the cancel modal lets the staff
  // choose to cancel just this person or the whole party. Default: just this one.
  const [cancelScope, setCancelScope] = useState<"this" | "whole">("this");
  const [notifyCancelChannels, setNotifyCancelChannels] =
    useState<NotifyChannels>({
      sms: false,
      email: false,
    });

  // Realtime connection-state machine. Default 'connected' — assume
  // online until the Supabase channel subscribe-callback flips us to
  // 'reconnecting' (CHANNEL_ERROR / TIMED_OUT) or 'offline' (CLOSED).
  // The polling-fallback path (no session) keeps this 'connected' since
  // 8s polling is operationally fresh enough to act on; only the
  // realtime channel actually transitions through these states.
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connected");
  const isOffline = connectionState !== "connected";

  // Origin for guest wait-link buttons. Read AFTER mount (not during render):
  // deriving it from `window.location.origin` inline made the server render ""
  // (button hidden) while the client rendered the origin (button shown),
  // throwing a React #418 hydration mismatch on any queued walk-in. Empty on
  // the server + first client render (match), populated on mount.
  const originBaseUrl = useSyncExternalStore(
    noopSubscribe,
    getWindowOrigin,
    getServerEmptySnapshot,
  );

  // Sound alerts (Web Audio, generated tones only). Hook is a no-op
  // when `dashboard_modules.sound_alerts` is off; honors browser
  // autoplay policy via lazy AudioContext + first-gesture unlock.
  const { playAlert, isUnlocked: isSoundUnlocked } = useSoundAlerts(
    data.dashboardModules,
  );

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
          seat_together: b.seat_together === true,
          addon_count: b.addons?.length ?? 0,
          no_show_count: b.client_no_show_count ?? 0,
          no_show_risk_score: b.no_show_risk_score ?? null,
          buffer_minutes: b.service_buffer_minutes,
          noshow_card_id: b.noshow_card_id ?? null,
          noshow_fee_cents: b.noshow_fee_cents ?? null,
          noshow_charge_status: b.noshow_charge_status ?? null,
          resource_name: b.resource_name ?? null,
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

  const inProgressToday = data.bookingsForDay.filter(
    (b) => b.status === "in_progress",
  ).length;

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

  // Bumped by the header "+ Walk-in" action to focus the add form on open —
  // makes that button a distinct ADD action vs the "Hàng chờ" list toggle.
  const [addFocusNonce, setAddFocusNonce] = useState(0);
  // Desk "New appointment" modal — books a phone-in customer for a future date.
  const [deskBookingOpen, setDeskBookingOpen] = useState(false);
  // Prefill for the desk form when opened by clicking an empty grid slot
  // (staff + day + time). Null when opened via the header button (blank form).
  const [deskPrefill, setDeskPrefill] = useState<{
    staffId?: string;
    ymd?: string;
    slotLabel?: string;
    /** Click coords → the form opens as a card anchored at the clicked cell. */
    anchor?: { x: number; y: number };
    /** Customer prefill for one-tap rebook from the booking drawer. */
    phone?: string;
    name?: string;
    serviceId?: string;
  } | null>(null);
  // Desk group booking — gated on the per-salon `group_booking` flag (same
  // flag the PartyCardPanel uses). Mounts DeskGroupForm which reuses the
  // public group scheduler + submit engine end-to-end.
  const [deskGroupOpen, setDeskGroupOpen] = useState(false);
  const openWalkinAdd = useCallback(() => {
    setQueuePanelOpen(true);
    setAddFocusNonce((n) => n + 1);
  }, [setQueuePanelOpen]);

  // Create a real appointment from a claimed waitlist entry — reuse the
  // desk-prefill mechanism (same as onRebookNext): open the existing
  // DeskBookingForm prefilled so staff confirm time/staff and book. Shared by
  // the waitlist panel (in the queue drawer) and the attention-chip dropdown.
  const createBookingFromClaim = useCallback(
    (entry: {
      phone: string;
      clientName: string;
      serviceId: string;
      bookingDate: string;
      preferredSlotLabel: string | null;
      offeredStaffId: string | null;
    }) => {
      setDeskPrefill({
        phone: entry.phone || undefined,
        name: entry.clientName || undefined,
        serviceId: entry.serviceId || undefined,
        ymd: entry.bookingDate || undefined,
        // The customer's preferred time ("3:30 PM") — the form auto-selects it
        // IF still free, else shows the open times so staff pick another. Saves
        // re-typing; staff just assign a tech and confirm.
        slotLabel: entry.preferredSlotLabel || undefined,
        // Prefill the freed tech when the slot carried one — matches what the
        // flag-on auto-book path would have assigned (manual parity).
        staffId: entry.offeredStaffId || undefined,
      });
      setDeskBookingOpen(true);
    },
    [],
  );

  // Open the queue panel when the sidebar "Hàng chờ" (clock) tab deep-links to
  // #queue — on mount AND on every hashchange (so re-clicking while already on
  // the page works). The hash is cleared after handling so the next click
  // re-fires hashchange.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const openFromHash = () => {
      if (window.location.hash !== "#queue") return;
      setQueuePanelOpen(true);
      window.requestAnimationFrame(() => {
        document
          .getElementById("queue")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    };
    const raf = window.requestAnimationFrame(openFromHash); // mount (keeps setState out of the effect body)
    window.addEventListener("hashchange", openFromHash);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("hashchange", openFromHash);
    };
  }, [setQueuePanelOpen]);

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
          const span = qi
            ? walkinEffectiveSpanMinutes(qi, data.services)
            : null;
          return qi !== undefined &&
            span !== null &&
            qi.client_name.trim().length
            ? {
                queueItemId: qi.id,
                clientName: qi.client_name.trim(),
                serviceDurationMinutes: span,
              }
            : null;
        })()
      : null;

  const timezone = data.salon.timezone;
  const isViewingToday = data.selectedDate === salonToday(timezone, nowIso || undefined);

  // "Needs attention" strip (today only): bookings that are past their start but
  // still un-started (overdue → 1-tap no-show / arrived) + today's no-shows
  // (1-tap undo for a late guest). Both reuse handleMarkNoShow / handleUndoNoShow.
  const attentionNowMs = Date.parse(nowIso);
  const attentionOverdue =
    isViewingToday && canMarkNoShow(viewerRole)
      ? data.bookingsForDay.filter(
          (b) =>
            b.status === "confirmed" &&
            Date.parse(b.start_time_utc) < attentionNowMs,
        )
      : [];
  const noShowsTodayList =
    isViewingToday && canMarkNoShow(viewerRole) ? data.noShowsToday : [];
  const attentionRemovedLabel = language === "vi" ? "[Đã xoá]" : "[Removed]";

  // ── Basic Mode (per-device Front Desk Cockpit) ──────────────────
  // Lightweight view toggle (localStorage). Default off → Balanced/Advanced
  // views are unchanged for everyone who never opts in. Only active on the
  // live "today + day" board where the cockpit's now-semantics make sense.
  // When the salon has `basic_mode_forced`, FRONT-DESK roles (receptionist /
  // nail_tech / senior) start locked in Basic Mode. Management roles
  // (owner / admin) are never forced — they keep the full board and can still
  // opt into Basic via the toggle. Keeps managers' analytics/controls available
  // even on a receptionist-simplified salon.
  const isManagerRole = viewerRole === "owner" || viewerRole === "admin";
  const { basicMode, toggleBasicMode, isForced } = useBasicMode(
    data.salon.basicModeForced && !isManagerRole,
  );
  // Basic Mode never renders the heavy party-card strip by default — the
  // actionable case surfaces as a compact cockpit alert. Clicking that
  // alert's "Open party bookings" reveals the full cards on demand.
  const [partyRevealed, setPartyRevealed] = useState(false);

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
    // Reload the day the user is actually viewing — NOT one derived from
    // dateOffset (which only spans yesterday/today/tomorrow, so a date-picked
    // day or any offset drift would reload the wrong day, snapping to today).
    const ymd = viewedYmdRef.current;
    const res = await loadReceptionistCenterDataAction(slug, ymd);
    if (res.ok) {
      setData(res.data);
      markSynced();
    } else {
      setShakeMessage(loadErrorCopy(messages.receptionist, res.error));
    }
    // Keep Week/Month views in sync with this mutation (QA #5).
    setCalendarRefreshNonce((n) => n + 1);
  }, [slug, messages.receptionist, markSynced]);

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
        markSynced();
        openBookingDrawer(bookingId);
      } else {
        setShakeMessage(loadErrorCopy(messages.receptionist, res.error));
      }
    },
    [slug, messages.receptionist, markSynced, openBookingDrawer],
  );

  const onWalkinAssignSlot = async (staffId: string, slotStartUtc: string) => {
    const assignBookingId = assigningWalkinId;
    if (!assignBookingId || assignedSlot === null) return;
    const qi = queueItems.find((x) => x.id === assignBookingId);
    const spanMinutes = qi
      ? walkinEffectiveSpanMinutes(qi, data.services)
      : null;
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

    const staffName =
      staffNameById.get(staffId)?.trim() || messages.receptionist.drawer.none;
    const svcName =
      qi.service_name?.trim() || messages.receptionist.drawer.none;
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
    // undoCancelBooking restores the booking AND flips the queued cancel
    // notification to 'cancelled' server-side, so the customer is never texted.
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

  const onUndoToastUndo =
    undoState?.type === "cancel" ? undoCancel : undoAssign;

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
        // No session = JWT expired/missing. Fall back to 8-second polling so the
        // board stays fresh if the server can still validate (rare SSR cookie timing).
        // Catch any "unexpected response" rejections (middleware redirect when JWT
        // truly expired) and hard-redirect to /login so they don't bubble as unhandled
        // rejections into error_logs or crash the error boundary.
        const pollInterval = window.setInterval(() => {
          if (!cancelled) {
            void reloadCurrentDay().catch(() => {
              if (!cancelled) window.location.href = "/login";
            });
          }
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

    const staffName =
      staffNameById.get(b.staff_id) ?? messages.receptionist.drawer.none;

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

    // Legacy `addon_*` columns only carry the FIRST add-on; with multiple
    // add-ons the recomputed span is short. The booking's stored end_time_utc
    // is the source of truth (it already includes every sequential add-on),
    // so for multi-add-on bookings derive the span straight from it.
    const hasMultiAddon = (b.addons?.length ?? 0) > 1;
    const endMsReal = Date.parse(b.end_time_utc);
    const realSpanMin =
      Number.isFinite(startMs) && Number.isFinite(endMsReal)
        ? Math.max(0, Math.round((endMsReal - startMs) / 60_000))
        : durMin + bufMin;

    let scheduleLine: string;
    if (hasMultiAddon) {
      // Show the true occupied window (start → real end) — accurate regardless
      // of how many add-ons extend the booking.
      const t1 = formatInSalonTz(b.end_time_utc, timezone, "time");
      scheduleLine = `${dateStr} · ${t0}${timeSep}${t1}`;
    } else if (bufMin > 0 && durMin > 0 && Number.isFinite(startMs)) {
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
      String(hasMultiAddon ? realSpanMin : durMin),
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

    // Checkout summary: when a deposit was paid, show it + the balance the
    // receptionist still charges on the Square POS (price − deposit).
    const depositPaidCents =
      b.deposit_status === "paid" ? (b.deposit_amount_cents ?? 0) : 0;
    const depositPaidLine =
      depositPaidCents > 0
        ? formatCurrency(depositPaidCents, data.salon.currencyCode)
        : null;
    const remainingLine =
      depositPaidCents > 0 && totalCents != null
        ? formatCurrency(
            Math.max(0, totalCents - depositPaidCents),
            data.salon.currencyCode,
          )
        : null;
    // Awaiting-deposit: a link was sent but not yet paid → the slot is held as
    // "Chờ cọc", not a firm "Xác nhận". Surfaced as its own badge in the drawer.
    const depositAwaitingLine =
      b.deposit_status === "required" && (b.deposit_amount_cents ?? 0) > 0
        ? formatCurrency(b.deposit_amount_cents ?? 0, data.salon.currencyCode)
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

    // "Book ở đâu" — friendly label for the granular origin channel
    // (online | desk | walkin | wix | square | voice | phone | appointment).
    // Falls back to null for legacy rows so the drawer can show sourceLabel.
    const channelLabel = ((): string | null => {
      switch (b.source_channel) {
        case "online":
          return language === "vi" ? "🌐 Khách đặt online" : "🌐 Online booking";
        case "desk":
          return language === "vi" ? "🧑‍💼 Lễ tân đặt tại quầy" : "🧑‍💼 Front desk";
        case "walkin":
          return language === "vi" ? "🚶 Khách vãng lai" : "🚶 Walk-in";
        case "wix":
          return "🔗 Wix";
        case "square":
          return "⬛ Square";
        case "voice":
          return language === "vi" ? "📞 Tổng đài AI" : "📞 Voice AI";
        case "phone":
          return language === "vi" ? "📞 Gọi điện thoại" : "📞 Phone";
        case "appointment":
          return language === "vi" ? "📅 Hẹn trước" : "📅 Appointment";
        default:
          return null;
      }
    })();

    // "Khi nào book" — when the booking was created, in salon tz.
    const bookedAtLine = b.created_at
      ? formatInSalonTz(b.created_at, timezone, "datetime")
      : null;

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
      channelLabel,
      bookedAtLine,
      // Reuse the timeline-chip flag — same server-derived signal,
      // same heart icon meaning. Drives the "Khách yêu cầu thợ này"
      // line under the source label.
      staffRequestedByClient: b.has_staff_request,
      scheduleLine,
      durationLine,
      priceLine,
      addonServiceName,
      addonDurationLine,
      // Full itemized add-on list (multi-add-on). Each carries a short
      // timing label so the therapist knows during-vs-after at a glance.
      addons:
        b.addons && b.addons.length > 0
          ? b.addons.map((a) => ({
              name: a.name,
              price_cents: a.price_cents,
              timingLabel: a.concurrent
                ? language === "vi"
                  ? "cùng lúc"
                  : "during"
                : language === "vi"
                  ? `làm sau · +${a.duration_minutes}′`
                  : `after · +${a.duration_minutes}m`,
            }))
          : addonServiceName
            ? [
                {
                  name: addonServiceName,
                  price_cents: addonCents,
                  timingLabel: null,
                },
              ]
            : [],
      verificationMethod: b.verification_method ?? null,
      smsFailedAt: b.sms_confirmation_failed_at ?? null,
      noShowRiskScore: b.no_show_risk_score ?? null,
      noShowHistoryCount: b.client_no_show_count ?? 0,
      depositStatus: b.deposit_status ?? null,
      depositPaidLine,
      remainingLine,
      depositAwaitingLine,
      // Square deposits config (stable per session, like currencyCode) + the
      // dashboard language so the desk can request + text a deposit link.
      depositsEnabled: data.salon.depositsEnabled,
      // No-show card-on-file (charge only on no-show) — surface the protection
      // at the desk. Data already loaded on the booking row.
      cardOnFile: !!b.noshow_card_id,
      noshowCardRequired: b.noshow_card_required === true,
      noshowFeeLine:
        b.noshow_fee_cents != null
          ? formatCurrency(b.noshow_fee_cents, data.salon.currencyCode)
          : null,
      language,
      // Party/group composition — the drawer lazily loads the members when set.
      groupId: b.group_id ?? null,
      seatTogether: b.seat_together === true,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ARCHITECTURE_LOCK: data.salon.currencyCode is intentionally omitted; it never changes within a session and adding it would cause memo churn
  }, [
    drawerBookingId,
    data.bookingsForDay,
    data.dashboardModules.revenue_today,
    staffNameById,
    messages,
    timezone,
    language,
  ]);

  const openDrawerBooking = drawerBookingId
    ? data.bookingsForDay.find((x) => x.id === drawerBookingId)
    : null;

  const drawerCopy = useMemo(() => {
    const d = messages.receptionist.drawer;
    return {
      title: d.title,
      closeAria: d.closeAria,
      removedGuest: messages.receptionist.removedGuest,
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
      groupSectionTitle: d.groupSectionTitle,
      groupOrganizedBy: d.groupOrganizedBy,
      groupOrganizerBadge: d.groupOrganizerBadge,
      groupSeatTogether: d.groupSeatTogether,
      viewPartyCard: d.viewPartyCard,
    };
  }, [messages]);

  const onDateSwitchChange = async (next: -1 | 0 | 1) => {
    if (!timezone || dayLoading) return;
    const snapshot = dateOffset;
    setDateOffset(next);
    setDayLoading(true);
    setAssigningWalkinId(null);
    setUndoState(null);
    const ymd = salonDateOffset(timezone, next, nowIso || undefined);
    const res = await loadReceptionistCenterDataAction(slug, ymd);
    setDayLoading(false);
    if (!res.ok) {
      setDateOffset(snapshot);
      setShakeMessage(loadErrorCopy(messages.receptionist, res.error));
      return;
    }
    setData(res.data);
    markSynced();
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
      closeBookingDrawer();
      await reloadCurrentDay();
      router.refresh();
    } finally {
      setDrawerBusy(false);
    }
  };

  // Cancel EVERY active member of a party in one go (group-aware cancel). Mirrors
  // the single-booking path but hits cancelDeskGroup; no 8s undo (a bulk restore
  // isn't offered — same as the PartyCardPanel group cancel).
  const doCancelGroup = async (
    groupId: string,
    notifyChannels?: NotifyChannels,
  ) => {
    const notifyChannelsResolved =
      notifyChannels ??
      (defaultNotifyOn(data.salon.staffNotificationSettings, "cancel")
        ? {
            sms: data.salon.staffNotificationSettings.channels.sms,
            email: data.salon.staffNotificationSettings.channels.email,
          }
        : { sms: false, email: false });

    setDrawerBusy(true);
    try {
      const r = await cancelDeskGroup(slug, {
        salonId: data.salon.id,
        groupId,
        notify: notifyChannelsResolved,
      });
      if (!r.ok) {
        setShakeMessage(mutationMessage(messages.receptionist, r.error));
      } else {
        // Whole party cancelled — close the drawer and reload; the grid visibly
        // empties every member's slot, which is its own confirmation.
        closeBookingDrawer();
        await reloadCurrentDay();
        router.refresh();
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  const doCancelBooking = async (
    id: string,
    refundDeposit: boolean,
    notifyChannels?: NotifyChannels,
  ) => {
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

    // Notify channels for the cancel — explicit panel choice, else the salon's
    // smart per-event default (the deposit path has no panel). The server
    // ENQUEUES this with a 20s grace; hitting Undo cancels the queued send.
    const notifyChannelsResolved =
      notifyChannels ??
      (defaultNotifyOn(data.salon.staffNotificationSettings, "cancel")
        ? {
            sms: data.salon.staffNotificationSettings.channels.sms,
            email: data.salon.staffNotificationSettings.channels.email,
          }
        : { sms: false, email: false });

    setDrawerBusy(true);
    try {
      const r = await cancelDeskBooking(slug, {
        salonId: data.salon.id,
        bookingId: id,
        refundDeposit,
        notify: notifyChannelsResolved,
      });
      if (!r.ok) {
        setShakeMessage(mutationMessage(messages.receptionist, r.error));
      } else {
        if (refundDeposit && r.depositRefunded === false) {
          setShakeMessage(
            `Đã huỷ. Hoàn cọc chưa xong (${r.depositRefundError ?? "lỗi"}) — hoàn tay trong Square.`,
          );
        }
        // Close drawer and reload grid first so booking disappears
        closeBookingDrawer();
        await reloadCurrentDay();
        router.refresh();

        // Undo toast (8s). Skipped after a refund — a returned deposit isn't
        // re-collected by restoring, so undo would leave booking + no deposit.
        // Undo also cancels the queued cancel notification server-side.
        if (!refundDeposit) {
          const u = messages.receptionist.undo;
          const startLabel = b.start_time_utc
            ? formatInSalonTz(b.start_time_utc, timezone, "time")
            : "";
          const svcName =
            b.service_name?.trim() || messages.receptionist.drawer.none;
          setUndoState({
            bookingId: id,
            headline: `${u.cancelledPrefix} ${displayCustomerName(b.client_name, messages.receptionist.removedGuest)}`,
            detailLine: [startLabel, svcName].filter(Boolean).join(" · "),
            secondsRemaining: 8,
            type: "cancel",
          });
        }
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  const onDrawerCancelBooking = () => {
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
    // A paid Square deposit forces a refund-or-keep decision before cancelling.
    if (b.deposit_status === "paid" && (b.deposit_amount_cents ?? 0) > 0) {
      setDepositCancel({ id, amountCents: b.deposit_amount_cents ?? 0 });
      return;
    }
    // Otherwise open the cancel-confirm with the "notify the customer?" panel,
    // pre-checked per the salon's smart per-event default for cancel.
    const settings = data.salon.staffNotificationSettings;
    const on = defaultNotifyOn(settings, "cancel");
    setNotifyCancelChannels({
      sms: on && settings.channels.sms,
      email: on && settings.channels.email,
    });
    setCancelScope("this");
    setNotifyCancel({ id });
  };

  const rcMessages = messages.receptionist;

  // Navigate to an arbitrary YYYY-MM-DD (used by VerticalDayView swipe gesture).
  // Slots into the existing ±1 date-offset machinery for yesterday/today/tomorrow;
  // falls back to a direct loader call for other dates (same pattern as week/month
  // onDayClick handlers).
  const navigateToYmd = useCallback(
    async (ymd: string) => {
      const tz = timezone;
      const today = salonToday(tz, nowIso || undefined);
      const yesterday = salonDateOffset(tz, -1, nowIso || undefined);
      const tomorrow = salonDateOffset(tz, 1, nowIso || undefined);
      if (ymd === today) {
        await onDateSwitchChange(0);
      } else if (ymd === yesterday) {
        await onDateSwitchChange(-1);
      } else if (ymd === tomorrow) {
        await onDateSwitchChange(1);
      } else {
        setDayLoading(true);
        const res = await loadReceptionistCenterDataAction(slug, ymd);
        setDayLoading(false);
        if (res.ok) {
          setData(res.data);
          markSynced();
        } else {
          setShakeMessage(loadErrorCopy(rcMessages, res.error));
        }
      }
    },
    [timezone, nowIso, onDateSwitchChange, slug, markSynced, rcMessages],
  );

  // TV Mode preset → full-screen read-only display per
  // `DASHBOARD_LAYOUT_RULES.md` §3. Bypasses the three-zone shell
  // entirely; receptionists exit via the corner button which writes
  // `dashboard_preset = 'reception'` and reloads via realtime.
  // Release flag `tv_mode` (PR2): when OFF, ignore the TV preset and fall
  // through to the normal board (the surface is Beta / not yet GA).
  if (tvModeEnabled && data.dashboardPreset === "tv") {
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

  // ── Basic Mode cockpit data (deterministic; display-only) ───────
  const basicModeActive = basicMode && isViewingToday && viewMode === "day";

  // ── Groups summary for the AttentionChipBar "Groups" chip ───────────
  // Non-basic modes surface upcoming parties through the chip bar's dropdown
  // (the inline strip is gone). Basic Mode keeps its cockpit reveal, so the
  // chip's groups affordance is suppressed there. "Unconfirmed" = unclaimed
  // slots + pending change requests across non-expired parties.
  const activeParties = (partyCards ?? []).filter((c) => !c.expired);
  const showGroupsChip = groupBookingEnabled && !basicModeActive;
  const groupSummary =
    showGroupsChip && activeParties.length > 0
      ? {
          active: activeParties.length,
          unconfirmed: activeParties.reduce(
            (n, c) => n + c.pendingCount + c.pendingChangeRequestCount,
            0,
          ),
        }
      : null;

  // ── Online-waitlist summary for the AttentionChipBar "Chờ chỗ" chip ──
  // Glanceable so staff never miss it (the panel itself lives at the bottom
  // of the Hàng chờ drawer, which is easy to overlook). `claimed` drives a
  // pulsing "N cần tạo lịch" badge — those customers grabbed a slot and need
  // a real appointment created.
  const waitlistSummary =
    data.onlineWaitlist.length > 0
      ? {
          total: data.onlineWaitlist.length,
          claimed: data.onlineWaitlist.filter((w) => w.status === "claimed")
            .length,
        }
      : null;

  // Available staff (operational, not a risk state) — used by the Now Bar
  // "Available staff" card (shows a name) and the walk-in nudge.
  const availableStaffList = data.staff.filter((s) => s.status === "available");
  const availableStaffCount = availableStaffList.length;
  const availableStaffName = availableStaffList[0]?.name?.trim() || null;
  // Now Bar tile shows WHO is free, not just one name — list up to 2 full names
  // then "+N" so a fully-free salon doesn't misleadingly read a single tech
  // (QA ReTest2). Cap at 2 (not 3) + an explicit "+N" so three long names don't
  // overflow the fixed-width tile and clip mid-word ("Tuor…").
  const availableStaffNames = availableStaffList
    .map((s) => s.name?.trim())
    .filter((n): n is string => !!n);
  const availableStaffLabel =
    availableStaffNames.length === 0
      ? null
      : availableStaffNames.length <= 2
        ? availableStaffNames.join(", ")
        : `${availableStaffNames.slice(0, 2).join(", ")} +${availableStaffNames.length - 2}`;

  // Longest CURRENT wait among queued guests (minutes) — drives the long-wait
  // Next Action + Critical Alert. Computed from queue join times vs "now".
  const nowMsForWait = Date.parse(nowIso);
  const longestWaitMinutes = (() => {
    let max: number | null = null;
    for (const q of data.walkinQueue) {
      const joined = q.joined_queue_at ? Date.parse(q.joined_queue_at) : NaN;
      if (!Number.isFinite(joined)) continue;
      const mins = Math.floor((nowMsForWait - joined) / 60_000);
      if (mins > (max ?? -1)) max = mins;
    }
    return max;
  })();

  // Overdue desk bookings (in_progress past their end time). The earliest one
  // is the target for the overdue alert's "Open booking" action + named copy.
  const overdueBookings = data.bookingsForDay
    .filter(
      (b) =>
        b.status === "in_progress" &&
        b.end_time_utc != null &&
        Date.parse(b.end_time_utc) < nowMsForWait,
    )
    .sort((a, b) => a.start_time_utc.localeCompare(b.start_time_utc));
  const firstOverdue = overdueBookings[0] ?? null;
  const firstOverdueId = firstOverdue?.id ?? null;
  const firstOverdueName = firstOverdue?.client_name?.trim() || null;
  const firstOverdueTimeLabel = firstOverdue
    ? formatInSalonTz(firstOverdue.start_time_utc, timezone, "time")
    : null;

  // Confirmed bookings past their start time but not yet started/arrived (the
  // AttentionChipBar "Overdue — not started" set). The Now Bar's queue-only
  // "Waiting" tile misses these, so feed them to the cockpit as a Critical
  // Alert — otherwise a scheduled guest sitting unattended reads as "no one
  // waiting" (QA ReceptionistCenter ReTest2). Today-only (cockpit is today).
  const notStartedBookings = isViewingToday
    ? data.bookingsForDay
        .filter(
          (b) =>
            b.status === "confirmed" &&
            Date.parse(b.start_time_utc) < nowMsForWait,
        )
        .sort((a, b) => a.start_time_utc.localeCompare(b.start_time_utc))
    : [];
  const firstNotStarted = notStartedBookings[0] ?? null;
  const firstNotStartedId = firstNotStarted?.id ?? null;
  const firstNotStartedName = firstNotStarted?.client_name?.trim() || null;
  const firstNotStartedTimeLabel = firstNotStarted
    ? formatInSalonTz(firstNotStarted.start_time_utc, timezone, "time")
    : null;

  // Today's soonest party with UNCONFIRMED (unclaimed) guests — drives the
  // clearer party alert ("Today {time} group: {name}/{n} not confirmed") and
  // its focus-the-group action. Restricted to today so the "today" copy is
  // accurate and operationally relevant for the front desk.
  // `nowIso` is "" during the SSR pass (deliberate — avoids a React #418
  // hydration mismatch on the live timestamp). `formatInSalonTz` throws on an
  // empty ISO, so skip this today-only alert until the client populates the
  // real time after mount. Without the guard, SSR crashes with
  // "salonTime: invalid ISO string" → React #419 (the whole Center fails to
  // render). The alert is meaningless without "now" anyway, and the client
  // re-renders immediately once nowIso ticks in.
  const todaySalonDate = nowIso ? formatInSalonTz(nowIso, timezone, "date") : "";
  const pendingPartyCard = !nowIso
    ? null
    : (partyCards ?? [])
        .filter(
          (c) =>
            !c.expired &&
            c.pendingCount > 0 &&
            c.groupStartUtcIso &&
            formatInSalonTz(c.groupStartUtcIso, timezone, "date") ===
              todaySalonDate,
        )
        .sort((a, b) =>
          a.groupStartUtcIso.localeCompare(b.groupStartUtcIso),
        )[0] ?? null;
  const pendingPartyGroupId = pendingPartyCard?.groupId ?? null;
  // Use organizer name so the alert reads "Sarah's party · 2pm: 1 slot unclaimed"
  // rather than the anonymous "Guest 2 hasn't confirmed" which gives no context.
  const pendingPartyOrganizerName = pendingPartyCard?.organizerName ?? null;

  const cockpitInputs: CockpitInputs = {
    waitingCount: data.kpiSnapshot.waitingCount,
    inProgressCount: data.kpiSnapshot.inProgressCount,
    comingUpCount: data.kpiSnapshot.comingUpCount,
    overdueCount: data.kpiSnapshot.overdueCount,
    longestWaitMinutes,
    availableStaffCount,
    availableStaffName,
    availableStaffLabel,
    firstWaitingName: data.walkinQueue[0]?.client_name?.trim() || null,
    firstOverdueName,
    firstOverdueTimeLabel,
    notStartedCount: notStartedBookings.length,
    firstNotStartedName,
    firstNotStartedTimeLabel,
    smsFailedCount: data.bookingsForDay.filter(
      (b) => b.sms_confirmation_failed_at != null && b.status !== "cancelled",
    ).length,
    pendingPartyCount: pendingPartyCard?.pendingCount ?? 0,
    pendingPartyGroupTime: pendingPartyCard?.groupStartDisplay ?? null,
    pendingPartyOrganizerName,
    isSetupIncomplete,
    // Walk-in queue feature gate (page forces queue_panel off when the
    // walkin_queue feature is disabled) — suppresses walk-in/queue nudges.
    queueEnabled: modules.queue_panel,
  };
  const cockpitLabels: CockpitLabels = {
    longWaitGuest: rcMessages.basicMode.longWaitGuest,
    finishOverdue: rcMessages.basicMode.finishOverdue,
    assignWaiting: rcMessages.basicMode.assignWaiting,
    assignWaitingNamed: rcMessages.basicMode.assignWaitingNamed,
    prepareNext: rcMessages.basicMode.prepareNext,
    partyPendingNamed: rcMessages.basicMode.partyPendingNamed,
    partyPendingCount: rcMessages.basicMode.partyPendingCount,
    suggestWalkin: rcMessages.basicMode.suggestWalkin,
    actionOpenQueue: rcMessages.basicMode.actionOpenQueue,
    actionAddWalkin: rcMessages.basicMode.actionAddWalkin,
    actionOpenParty: rcMessages.basicMode.actionOpenParty,
    actionOpenBooking: rcMessages.basicMode.actionOpenBooking,
    alertOverdue: rcMessages.basicMode.alertOverdue,
    alertOverdueNamed: rcMessages.basicMode.alertOverdueNamed,
    alertNotStarted: rcMessages.basicMode.alertNotStarted,
    alertNotStartedNamed: rcMessages.basicMode.alertNotStartedNamed,
    alertLongWait: rcMessages.basicMode.alertLongWait,
    alertNoStaffForWaiting: rcMessages.basicMode.alertNoStaffForWaiting,
    alertSmsFailed: rcMessages.basicMode.alertSmsFailed,
    alertSetupIncomplete: rcMessages.basicMode.alertSetupIncomplete,
  };
  // Cockpit action button handler. Queue + walk-in open the queue slide-over
  // (the walk-in form lives inside it); party scrolls the party strip into
  // view; overdue opens the overdue booking's detail drawer (it's a desk
  // booking, NOT a queue item — opening the queue here was the dead-click bug).
  const onCockpitAction = (
    target: import("@/shared/dashboard/basicModeCockpit").CockpitActionTarget,
  ) => {
    if (target === "open_overdue") {
      if (firstOverdueId) openBookingDrawer(firstOverdueId);
      return;
    }
    if (target === "open_not_started") {
      // Confirmed-but-not-started guest → open the booking so the receptionist
      // can mark arrived / no-show (same affordance as the attention chip).
      if (firstNotStartedId) openBookingDrawer(firstNotStartedId);
      return;
    }
    if (target === "open_party") {
      // Reveal the party cards on demand (hidden by default in Basic), then
      // scroll/focus the SPECIFIC group the alert is about (falls back to the
      // strip if the card anchor isn't found).
      setPartyRevealed(true);
      setTimeout(() => {
        const card = pendingPartyGroupId
          ? document.getElementById(`party-card-${pendingPartyGroupId}`)
          : null;
        (card ?? document.getElementById("party-strip"))?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 50);
      return;
    }
    if (target === "add_walkin") {
      // Banner "+ Walk-in" (e.g. "Thợ 1 đang sẵn sàng") → open in ADD mode with
      // the name field focused, same as the header "+ Walk-in".
      openWalkinAdd();
      return;
    }
    // open_queue / assign_waiting → open the panel on the waiting LIST.
    setQueuePanelOpen(true);
  };

  const setupCtaPath =
    data.services.length === 0
      ? `/dashboard/${encodeURIComponent(slug)}/setup/services`
      : `/dashboard/${encodeURIComponent(slug)}/setup/staff`;

  // Wix-origin pending → desk Approve/Decline that writes back to Wix. Owner/senior only.
  const isWixPending =
    !!openDrawerBooking &&
    openDrawerBooking.status === "pending" &&
    !!openDrawerBooking.wix_booking_id &&
    canCancelBooking(viewerRole);

  const onDrawerApproveWix = async () => {
    const id = drawerBookingId;
    if (!id) return;
    setDrawerBusy(true);
    try {
      const r = await approveWixBooking(slug, {
        salonId: data.salon.id,
        bookingId: id,
      });
      if (!r.ok) {
        setShakeMessage(mutationMessage(messages.receptionist, r.error));
      } else {
        closeBookingDrawer();
        await reloadCurrentDay();
        router.refresh();
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  const onDrawerDeclineWix = async () => {
    const id = drawerBookingId;
    if (!id) return;
    setDrawerBusy(true);
    try {
      const r = await declineWixBooking(slug, {
        salonId: data.salon.id,
        bookingId: id,
      });
      if (!r.ok) {
        setShakeMessage(mutationMessage(messages.receptionist, r.error));
      } else {
        closeBookingDrawer();
        await reloadCurrentDay();
        router.refresh();
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  const drawerPrimaryAction = isWixPending
    ? {
        label: rcMessages.drawer.approveWix,
        busy: drawerBusy,
        onPress: () => void onDrawerApproveWix(),
      }
    : !canChangeBookingStatus(viewerRole)
      ? // View-only roles (nail_tech) can't advance status — hide the
        // Start/Complete button so it matches the server-side gate in
        // updateBookingStatus (no button that would just error).
        undefined
      : openDrawerBooking?.status === "pending" ||
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

  const drawerDeclineAction = isWixPending
    ? {
        label: rcMessages.drawer.declineWix,
        busy: drawerBusy,
        onPress: () => void onDrawerDeclineWix(),
      }
    : undefined;

  const handleMarkNoShow = async (id: string, chargeFee?: boolean) => {
    if (!id) return;
    setDrawerBusy(true);
    try {
      const r = await markNoShowBooking(slug, {
        salonId: data.salon.id,
        bookingId: id,
        ...(chargeFee !== undefined ? { chargeFee } : {}),
      });
      if (!r.ok) {
        setShakeMessage(mutationMessage(messages.receptionist, r.error));
      } else {
        closeBookingDrawer();
        await reloadCurrentDay();
        router.refresh();
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  // Check if booking has a card + fee before marking no-show; show the
  // charge/waive modal if so. Plain functions (NOT hooks) — they live after the
  // component's early `return` for TV mode, where calling useState/useCallback
  // would violate the rules of hooks. `noShowChargeModal` state is declared up
  // with the other useState hooks above the early return.
  const triggerMarkNoShow = (id: string) => {
    const b = data.bookingsForDay.find((x) => x.id === id);
    if (
      b &&
      b.noshow_card_id &&
      b.noshow_fee_cents &&
      b.noshow_fee_cents > 0 &&
      b.noshow_charge_status !== "charged" &&
      b.noshow_charge_status !== "waived"
    ) {
      setNoShowChargeModal({ bookingId: id, feeCents: b.noshow_fee_cents });
    } else {
      void handleMarkNoShow(id);
    }
  };

  const onDrawerMarkNoShow = () =>
    void triggerMarkNoShow(drawerBookingId ?? "");

  // Inline "Start" handler — confirmed/pending → in_progress straight from the grid.
  const handleStartBooking = async (bookingId: string) => {
    const r = await updateBookingStatus(bookingId, "in_progress", slug);
    if (!r.ok) {
      setShakeMessage(
        updateBookingStatusToastMessage(messages.receptionist, r),
      );
      return;
    }
    await reloadCurrentDay();
    router.refresh();
  };

  // Tombstone handlers — undo / charge / waive from the grid ribbon popover.
  const handleTombstoneUndo = async (bookingId: string) => {
    if (!bookingId) return;
    setDrawerBusy(true);
    try {
      const r = await undoNoShowBooking(slug, {
        salonId: data.salon.id,
        bookingId,
      });
      if (!r.ok) {
        setShakeMessage(mutationMessage(messages.receptionist, r.error));
      } else {
        closeBookingDrawer();
        await reloadCurrentDay();
        router.refresh();
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  const handleTombstoneCharge = async (bookingId: string) => {
    setDrawerBusy(true);
    try {
      const r = await chargeNoShowFeeManual(slug, {
        salonId: data.salon.id,
        bookingId,
      });
      if (!r.ok) setShakeMessage(messages.receptionist.actionErrorFallback);
      else {
        await reloadCurrentDay();
        router.refresh();
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  const handleTombstoneWaive = async (bookingId: string) => {
    setDrawerBusy(true);
    try {
      const r = await waiveNoShowFee(slug, {
        salonId: data.salon.id,
        bookingId,
      });
      if (!r.ok) setShakeMessage(messages.receptionist.actionErrorFallback);
      else {
        await reloadCurrentDay();
        router.refresh();
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  // No-show: only for a confirmed / in-progress booking whose start time has passed
  // (you can't no-show a future appointment). Front desk: owner/admin/senior/receptionist.
  const drawerNowMs = Date.parse(nowIso);
  const drawerNoShowAction =
    openDrawerBooking &&
    canMarkNoShow(viewerRole) &&
    (openDrawerBooking.status === "confirmed" ||
      openDrawerBooking.status === "in_progress") &&
    new Date(openDrawerBooking.start_time_utc).getTime() < drawerNowMs
      ? {
          label: rcMessages.drawer.noShow,
          busy: drawerBusy,
          onPress: () => void onDrawerMarkNoShow(),
        }
      : undefined;

  // Generic cancel — hidden for Wix-pending (Decline replaces it there to avoid a duplicate reject).
  const drawerCancelAction =
    openDrawerBooking &&
    !isWixPending &&
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
        closeBookingDrawer();
        await reloadCurrentDay();
        router.refresh();
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  // Undo a no-show (the guest was just running late). Reverts to confirmed +
  // decrements their no-show history so they aren't wrongly penalised. Shared by
  // the drawer action and the "needs attention" strip.
  const handleUndoNoShow = async (id: string) => {
    if (!id) return;
    setDrawerBusy(true);
    try {
      const r = await undoNoShowBooking(slug, {
        salonId: data.salon.id,
        bookingId: id,
      });
      if (!r.ok) {
        setShakeMessage(mutationMessage(messages.receptionist, r.error));
      } else {
        closeBookingDrawer();
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
    new Date(openDrawerBooking.start_time_utc).getTime() > drawerNowMs + 60_000
      ? {
          label: rcMessages.drawer.restoreBooking,
          busy: drawerBusy,
          onPress: () => void onDrawerRestoreBooking(),
        }
      : undefined;

  const onDrawerSetFinalPrice = async (priceCents: number) => {
    const id = drawerBookingId;
    if (!id) return;
    setDrawerBusy(true);
    try {
      const r = await setBookingFinalPrice(slug, {
        salonId: data.salon.id,
        bookingId: id,
        priceCents,
      });
      if (!r.ok) {
        setShakeMessage(mutationMessage(messages.receptionist, r.error));
      } else {
        await reloadCurrentDay();
        router.refresh();
      }
    } finally {
      setDrawerBusy(false);
    }
  };

  // Final-price entry: only when the booking's service is variable-priced
  // ('from'/'range'), the viewer may edit, and the booking isn't cancelled.
  const drawerServicePriceType = openDrawerBooking
    ? data.services.find((s) => s.id === openDrawerBooking.service_id)
        ?.price_type
    : undefined;
  const drawerFinalPriceAction =
    openDrawerBooking &&
    canEditBooking(viewerRole) &&
    openDrawerBooking.status !== "cancelled" &&
    (drawerServicePriceType === "from" || drawerServicePriceType === "range")
      ? {
          fieldLabel: language === "vi" ? "Giá thực tế" : "Final price",
          saveLabel: language === "vi" ? "Lưu" : "Save",
          savedLabel: language === "vi" ? "✓ Đã lưu" : "✓ Saved",
          busy: drawerBusy,
          currency: data.salon.currencyCode,
          currentCents: openDrawerBooking.price_cents ?? null,
          onSave: onDrawerSetFinalPrice,
        }
      : undefined;

  return (
    <>
      <div
        data-testid="receptionist-center-loaded"
        data-rush-mode={rush.active ? "on" : "off"}
        style={{ ...drcCssVars, backgroundColor: drcBg }}
        className={cn(
          "flex min-h-[100dvh] w-full flex-col",
          rush.active && "[&_[data-rush-fade]]:opacity-50",
        )}
      >
        {/* Hydration signal for E2E: only rendered after React useEffect fires. */}
        {rcHydrated && (
          <span
            data-testid="rc-hydrated"
            aria-hidden="true"
            style={{ display: "none" }}
          />
        )}
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
        <header className="shrink-0 border-b border-nq-muted/20 px-[var(--pad-nq-section-mobile)] py-2.5 backdrop-blur-sm md:px-6 md:py-3" style={{ backgroundColor: "var(--drc-bg, #0b0c10)" }}>
          <div className="mx-auto flex w-full max-w-[var(--max-nq-desktop)] flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 gap-y-2">
                <Link
                  href={`/dashboard/${encodeURIComponent(slug)}`}
                  className="truncate text-[13px] font-medium text-nq-primary hover:text-nq-primary/85"
                >
                  ← {rcMessages.navOwnerDashboard}
                </Link>
                <h1 className="truncate text-lg font-semibold text-nq-foreground md:text-xl">
                  {basicModeActive
                    ? rcMessages.basicMode.pageTitle
                    : rcMessages.title}
                </h1>
              </div>
              <p className="truncate text-[11px] text-nq-muted sm:text-xs md:text-sm">
                {data.salon.name}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              {/* Status pill duplicates the Now Bar's Waiting + In service
                  counts, so it's hidden in Basic Mode. Balanced/Advanced
                  keep it (no Now Bar there). */}
              {isViewingToday && modules.kpi_bar && !basicModeActive ? (
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
              {viewerRole === "owner" && !basicModeActive ? (
                <Badge
                  data-testid="role-badge-owner"
                  variant="info"
                  state="subtle"
                  size="sm"
                  className="hidden xl:inline-flex"
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
              {/* Basic Mode toggle — per-device front-desk cockpit. Shown
                  on the live day board for every role (it's a personal view
                  preference, not a salon-wide setting). Hidden when the salon
                  forces Basic Mode (the toggle would be a no-op). */}
              {isViewingToday && viewMode === "day" && !isForced ? (
                <button
                  type="button"
                  data-testid="basic-mode-toggle"
                  aria-pressed={basicMode}
                  aria-label={
                    basicMode
                      ? rcMessages.basicMode.toggleOffAria
                      : rcMessages.basicMode.toggleOnAria
                  }
                  onClick={toggleBasicMode}
                  data-rush-fade
                  className={cn(
                    "hidden rounded-md border px-2.5 py-1 text-xs font-medium transition-colors xl:inline-flex",
                    basicMode
                      ? "border-nq-primary bg-nq-primary/15 text-nq-primary"
                      : "border-nq-border bg-nq-surface text-nq-muted hover:text-nq-foreground",
                  )}
                >
                  {rcMessages.basicMode.toggle}
                </button>
              ) : null}
              {/* Density slider is hidden in Basic Mode — Basic Mode is the
                  simplified view, so the density control would be redundant
                  clutter. Reappears when Basic Mode is off. */}
              {viewerRole !== "nail_tech" && !basicModeActive ? (
                <span className="hidden xl:inline" data-rush-fade>
                  <DensitySlider
                    slug={slug}
                    value={data.dashboardDensity}
                    labels={rcMessages.density}
                    onChanged={onDensityChanged}
                    onError={(msg) => setShakeMessage(msg)}
                  />
                </span>
              ) : null}
              {/* DRC color theme picker — owner-only, subtle palette icon */}
              {viewerRole === "owner" && !basicModeActive ? (
                <span className="hidden xl:inline" data-rush-fade>
                  <DrcThemePicker
                    slug={slug}
                    currentAccent={drcAccent}
                    onAccentChange={setDrcAccent}
                    currentBg={drcBg}
                    onBgChange={setDrcBg}
                  />
                </span>
              ) : null}
              {/* Day / Week view-mode toggle. Day is the live desk job;
                  Week is a read-only planning glance per
                  DASHBOARD_LAYOUT_RULES §3. Pair color with text label
                  per COLOR_TOKENS §5 — selected state uses the gold
                  family because this is a navigational commitment, not
                  a status.
                  Basic Mode is a front-desk "today" view — the
                  Day/Week/Month toggle is hidden there (Yesterday/Today/
                  Tomorrow remains). Balanced/Advanced keep the toggle. */}
              {basicModeActive ? null : (
                <div
                  role="tablist"
                  aria-label={rcMessages.viewMode.ariaLabel}
                  data-testid="view-mode-toggle"
                  data-rush-fade
                  className="hidden overflow-hidden rounded-md border border-nq-border bg-nq-surface text-xs font-medium xl:inline-flex"
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
              )}
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
                  onClick={openWalkinAdd}
                >
                  {language === "vi"
                    ? "+ Khách vãng lai"
                    : rcMessages.queue.addWalkinCta}
                </Button>
              ) : null}
              {/* "New appointment" — book a phone-in customer for a FUTURE date
                 (not gated to today, unlike the walk-in queue). */}
              {viewMode === "day" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="header-add-appointment"
                  className="hidden sm:inline-flex"
                  onClick={() => {
                    // Open a blank form on the currently-viewed date so a
                    // receptionist booking ahead (viewing tomorrow) doesn't
                    // land on today's date by default.
                    setDeskPrefill({ ymd: data.selectedDate });
                    setDeskBookingOpen(true);
                  }}
                >
                  {language === "vi" ? "+ Hẹn mới" : "+ New appt"}
                </Button>
              ) : null}
              {deskBookingOpen ? (
                <DeskBookingForm
                  slug={slug}
                  salonId={data.salon.id}
                  timezone={data.salon.timezone}
                  language={language}
                  notifySettings={data.salon.staffNotificationSettings}
                  initialStaffId={deskPrefill?.staffId}
                  initialYmd={deskPrefill?.ymd}
                  initialSlotLabel={deskPrefill?.slotLabel}
                  initialServiceId={deskPrefill?.serviceId}
                  initialPhone={deskPrefill?.phone}
                  initialName={deskPrefill?.name}
                  anchor={deskPrefill?.anchor}
                  onClose={() => {
                    setDeskBookingOpen(false);
                    setDeskPrefill(null);
                  }}
                  onCreated={(booking) => {
                    setDeskPrefill(null);
                    // Optimistic insert: if the new booking falls on the day the
                    // receptionist is currently viewing (salon-local), splice it
                    // into the grid immediately so it shows without waiting for
                    // the full-day reload. The background reload below then
                    // replaces it with the canonical row (same id → no dupe).
                    if (booking) {
                      const bookingYmd = salonYmdOfUtc(
                        booking.start_time_utc,
                        data.salon.timezone,
                      );
                      if (bookingYmd === data.selectedDate) {
                        setData((d) =>
                          d.bookingsForDay.some((b) => b.id === booking.id)
                            ? d
                            : {
                                ...d,
                                bookingsForDay: [...d.bookingsForDay, booking],
                              },
                        );
                      }
                    }
                    void reloadCurrentDay();
                  }}
                />
              ) : null}
              {/* "Group" — book a group/party for a future date. Gated on the
                 same per-salon `group_booking` flag as the party-card strip. */}
              {viewMode === "day" && groupBookingEnabled ? (
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid="header-add-group"
                  className="hidden sm:inline-flex"
                  onClick={() => setDeskGroupOpen(true)}
                >
                  {language === "vi" ? "+ Nhóm" : "+ Group"}
                </Button>
              ) : null}
              {deskGroupOpen ? (
                <DeskGroupForm
                  slug={slug}
                  salonId={data.salon.id}
                  language={language}
                  timezone={data.salon.timezone}
                  onClose={() => setDeskGroupOpen(false)}
                  onCreated={() => {
                    void reloadCurrentDay();
                  }}
                />
              ) : null}
              {/*
               * Walk-in queue slide-over toggle. See
               * DASHBOARD_LAYOUT_RULES §11.3. Hidden when the queue
               * module is off (the slide-over wouldn't render anyway,
               * so don't surface a button that does nothing). Badge
               * color tracks operational urgency: red when any walk-in
               * is overdue, gold when ≥1 waiting but none urgent, no
               * badge when empty.
               *
               * Hidden when the queue is empty: with nothing waiting there's
               * no list to view, and "+ Walk-in" is the way in. This removes
               * the "two buttons that do the same thing" confusion — the
               * toggle only appears once there are people waiting (and then
               * carries the count badge). When the panel is open it stays
               * visible so it can also close the panel.
               */}
              {isViewingToday &&
              viewMode === "day" &&
              modules.queue_panel &&
              (queueWaitingCount > 0 || queuePanelOpen) ? (
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
              {/* Yesterday/Today/Tomorrow only drives the Day view's data
                  loader. In Week/Month it was a dead click (QA M8), so hide it
                  outside Day view. */}
              {viewMode === "day" ? (
                <>
                  {/* Always-visible date anchor — tells you which day you're
                      viewing, especially after drilling in from Month view. */}
                  <ViewedDateChip
                    ymd={data.selectedDate}
                    language={language}
                    isToday={isViewingToday}
                  />
                  <DateSwitcher
                    selectedOffset={dateOffset}
                    onChange={(next) => void onDateSwitchChange(next)}
                    labels={rcMessages.dateSwitcher}
                  />
                </>
              ) : null}
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
        <ConnectionBanner
          state={connectionState}
          labels={rcMessages.connection}
          lastUpdatedLabel={
            // lastSyncedIso starts "" on the SSR pass (seeded from nowIso);
            // formatInSalonTz throws on an empty ISO. The client fills it in
            // right after mount, and the banner only surfaces when
            // reconnecting/offline, so an empty label during SSR is harmless.
            lastSyncedIso ? formatInSalonTz(lastSyncedIso, timezone, "time") : ""
          }
          onReload={() => window.location.reload()}
        />

        {isViewingToday && viewMode === "day" ? (
          <DailyBriefCard
            slug={slug}
            selectedDate={data.selectedDate}
            bookings={data.bookingsForDay}
            readyStaffCount={availableStaffCount}
            totalStaffCount={data.staff.length}
            waitingCount={queueWaitingCount}
            closeMinutes={data.salon.closeMinutes}
            currentMinutes={salonNowMinutes(timezone, nowIso)}
            formatTime={(utcIso) => formatInSalonTz(utcIso, timezone, "time")}
            labels={rcMessages.dailyBrief}
          />
        ) : null}

        {!basicModeActive && isViewingToday && viewMode === "day" ? (
          <NailiqSuggestionBar
            inputs={cockpitInputs}
            labels={cockpitLabels}
            heading={rcMessages.basicMode.aiSuggestionHeading}
            allClear={rcMessages.basicMode.aiAllClear}
            reasons={rcMessages.basicMode.aiReasons}
            onAction={onCockpitAction}
          />
        ) : null}

        {/*
         * KPI band per `docs/DASHBOARD_LAYOUT_RULES.md` §5: top summary
         * band sits **above** the three-zone row, the grid shrinks
         * vertically by the band's height, and horizontal three-zone
         * allocation does not change. Today-only — KPIs reference live
         * "now" semantics (Coming up 30m, Overdue, Next available) so
         * historical/future date views must not pretend they are live.
         */}
        {basicModeActive ? (
          /* Basic Mode replaces the full KPI band with the Front Desk
             Cockpit: Critical Alerts (max 2) + Next Action + 4-card Now Bar.
             Revenue / avg-wait / next-available clutter is intentionally
             dropped here (still available in the full Balanced/Advanced view). */
          <BasicCockpit
            snapshot={data.kpiSnapshot}
            inputs={cockpitInputs}
            labels={cockpitLabels}
            nowBar={{
              waiting: rcMessages.kpiBar.waiting,
              inService: rcMessages.kpiBar.inService,
              upcoming: rcMessages.basicMode.nowUpcoming,
              upcomingTitle: rcMessages.basicMode.nowUpcomingTitle,
              availableStaff: rcMessages.basicMode.nowAvailableStaff,
              noOneWaiting: rcMessages.basicMode.nowNoOneWaiting,
              noStaffAvailable: rcMessages.basicMode.nowNoStaffAvailable,
            }}
            headings={{
              nextAction: rcMessages.basicMode.nextActionHeading,
              alerts: rcMessages.basicMode.alertsHeading,
              moreIssues: rcMessages.basicMode.moreIssues,
            }}
            onAction={onCockpitAction}
            onOpenQueue={() => setQueuePanelOpen(true)}
            isLoading={dayLoading}
          />
        ) : isViewingToday && modules.kpi_bar ? (
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
            Balanced/Advanced no longer mount the strip inline (it ate the
            grid's height); instead the party cards live inside the
            AttentionChipBar's "Groups" dropdown above the grid. Basic Mode
            keeps its calm cockpit: the strip is revealed on demand only when
            the cockpit's "Open party bookings" alert is tapped (partyRevealed). */}
        {/* Release flag `group_booking` (PR2): hide the party-card strip
            entirely when group booking is disabled for this salon. */}
        {groupBookingEnabled && basicModeActive && partyRevealed ? (
          <div id="party-strip">
            <PartyCardPanel
              initialCards={partyCards}
              slug={slug}
              salonId={data.salon.id}
              currencyCode={data.salon.currencyCode}
              labels={rcMessages.partyCard}
              canCancel={canCancelBooking(viewerRole)}
              onDeskClaim={(claimId, token, memberName, memberPhone) =>
                deskClaimPartySlotAction(slug, claimId, token, memberName, memberPhone)
              }
            />
          </div>
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

        {viewMode === "month" ? (
          <MonthView
            slug={slug}
            firstYmd={monthFirstYmd}
            timezone={timezone}
            todayYmd={salonToday(timezone, nowIso || undefined)}
            language={language}
            messages={rcMessages.monthView}
            removedGuest={rcMessages.removedGuest}
            hint={calendarHint}
            refreshNonce={calendarRefreshNonce}
            onDayClick={(ymd) => {
              // Switch to Day view for the tapped date.
              onChangeViewMode("day");
              const tz = timezone;
              const today = salonToday(tz, nowIso || undefined);
              const yesterday = salonDateOffset(tz, -1, nowIso || undefined);
              const tomorrow = salonDateOffset(tz, 1, nowIso || undefined);
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
                  if (res.ok) {
                    setData(res.data);
                    markSynced();
                  } else setShakeMessage(loadErrorCopy(rcMessages, res.error));
                })();
              }
            }}
            onBookingClick={(bookingId, ymd) =>
              void onBookingClickFromCalendar(bookingId, ymd)
            }
            onPrevMonth={() => setMonthFirstYmd((m) => shiftMonth(m, -1))}
            onThisMonth={() =>
              setMonthFirstYmd(firstOfMonth(salonToday(timezone, nowIso || undefined)))
            }
            onNextMonth={() => setMonthFirstYmd((m) => shiftMonth(m, 1))}
          />
        ) : viewMode === "week" ? (
          <WeekView
            slug={slug}
            mondayYmd={weekMondayYmd}
            timezone={timezone}
            todayYmd={salonToday(timezone, nowIso || undefined)}
            messages={rcMessages.weekView}
            removedGuest={rcMessages.removedGuest}
            hint={calendarHint}
            refreshNonce={calendarRefreshNonce}
            onDayClick={(ymd) => {
              // Tapping a day flips back to Day view and (when the day
              // is yesterday/today/tomorrow) slots into the existing
              // dateOffset machinery; out-of-range days fall back to
              // today since DateSwitcher only models -1/0/+1.
              onChangeViewMode("day");
              const tz = timezone;
              const today = salonToday(tz, nowIso || undefined);
              const yesterday = salonDateOffset(tz, -1, nowIso || undefined);
              const tomorrow = salonDateOffset(tz, 1, nowIso || undefined);
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
                  if (res.ok) {
                    setData(res.data);
                    markSynced();
                  } else setShakeMessage(loadErrorCopy(rcMessages, res.error));
                })();
              }
            }}
            onBookingClick={(bookingId, ymd) =>
              void onBookingClickFromCalendar(bookingId, ymd)
            }
            onPrevWeek={() => setWeekMondayYmd((m) => shiftWeek(m, -1))}
            onThisWeek={() =>
              setWeekMondayYmd(mondayYmdOf(salonToday(timezone, nowIso || undefined)))
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
              <AttentionChipBar
                language={language === "vi" ? "vi" : "en"}
                overdue={attentionOverdue}
                noShowsToday={noShowsTodayList}
                groupSummary={groupSummary}
                groupsContent={
                  showGroupsChip ? (
                    <PartyCardPanel
                      initialCards={partyCards}
                      slug={slug}
                      salonId={data.salon.id}
                      currencyCode={data.salon.currencyCode}
                      labels={rcMessages.partyCard}
                      canCancel={canCancelBooking(viewerRole)}
                    />
                  ) : null
                }
                waitlistSummary={waitlistSummary}
                waitlistContent={
                  waitlistSummary ? (
                    <OnlineWaitlistPanel
                      slug={slug}
                      entries={data.onlineWaitlist}
                      onCreateBooking={createBookingFromClaim}
                    />
                  ) : null
                }
                busy={drawerBusy}
                removedLabel={attentionRemovedLabel}
                formatTime={(utcIso) =>
                  formatInSalonTz(utcIso, timezone, "time")
                }
                displayName={displayCustomerName}
                onOpenBooking={(id) => openBookingDrawer(id)}
                onMarkNoShow={(id) => void triggerMarkNoShow(id)}
                onUndoNoShow={(id) => void handleUndoNoShow(id)}
              />

              {isMobile ? (
                <VerticalDayView
                  staff={gridStaff}
                  bookings={gridBookings}
                  selectedDate={data.selectedDate}
                  timezone={timezone}
                  nowIso={nowIso}
                  isViewingToday={isViewingToday}
                  openMinutes={data.salon.openMinutes}
                  closeMinutes={data.salon.closeMinutes}
                  onBookingClick={(id) => openBookingDrawer(id)}
                  onEmptySlotClick={(staffId, ymd, slotLabel) => {
                    setDeskPrefill({ staffId, ymd, slotLabel, anchor: undefined });
                    setDeskBookingOpen(true);
                  }}
                  onNavigateDate={(ymd) => void navigateToYmd(ymd)}
                  onAddBooking={() => setDeskBookingOpen(true)}
                  language={language === "vi" ? "vi" : "en"}
                />
              ) : (
              <StaffTimelineGrid
                compactBookingIcons={basicModeActive}
                staff={gridStaff}
                bookings={gridBookings}
                assigning={assignedSlot}
                selectedDate={data.selectedDate}
                openMinutes={data.salon.openMinutes}
                closeMinutes={data.salon.closeMinutes}
                timezone={timezone}
                nowIso={nowIso}
                isViewingToday={isViewingToday}
                jumpToNowTrigger={jumpToNowTrigger}
                existingBookings={gridBookings}
                onBookingClick={(id) => openBookingDrawer(id)}
                onSlotClick={(staffId, utc) =>
                  void onWalkinAssignSlot(staffId, utc)
                }
                onEmptySlotClick={(staffId, ymd, slotLabel, anchor) => {
                  // Click an empty grid slot → open the desk form as a card
                  // anchored at the click (grid stays visible).
                  setDeskPrefill({ staffId, ymd, slotLabel, anchor });
                  setDeskBookingOpen(true);
                }}
                onRescheduleBooking={
                  // Drag-to-reschedule is an EDIT, so only wire it for roles that
                  // can edit (owner/admin/senior/receptionist). Without this gate
                  // view-only nail_tech could grab-drag a block; the server would
                  // reject it (`canEditBooking`) and it would snap back with an
                  // "unauthorized" toast — a confusing UI/server split. Passing
                  // `undefined` hides the drag affordance so the UI matches the
                  // server gate (mirrors the Start/Complete button gate in #404).
                  canEditBooking(viewerRole)
                    ? async (bookingId, newStaffId, newStartUtc) => {
                        const booking = data.bookingsForDay.find(
                          (b) => b.id === bookingId,
                        );
                        if (!booking) return { ok: false, error: "not_found" };
                        const result = await editBookingAction(slug, {
                          salonId: data.salon.id,
                          bookingId,
                          newStartTimeUtc: newStartUtc,
                          newStaffId,
                          newServiceId: booking.service_id,
                          newAddonServiceId: booking.addon_service_id ?? null,
                          // Drag has no confirm dialog → notify per the salon's
                          // smart per-event default for reschedule.
                          notify: defaultNotifyOn(
                            data.salon.staffNotificationSettings,
                            "reschedule",
                          )
                            ? {
                                sms: data.salon.staffNotificationSettings
                                  .channels.sms,
                                email:
                                  data.salon.staffNotificationSettings.channels
                                    .email,
                              }
                            : { sms: false, email: false },
                        });
                        if (result.ok) {
                          // Reload the CURRENTLY-VIEWED day (respects dateOffset)
                          // like every other mutation — `router.refresh()` re-ran
                          // the server loader's default day and snapped the view
                          // back to today after dragging on a future day.
                          await reloadCurrentDay();
                          return { ok: true };
                        }
                        // Surface WHY the drop snapped back, instead of failing silently.
                        const failCopy = rcMessages.grid.rescheduleFailed;
                        const reason =
                          result.error === "past_date"
                            ? failCopy.past_date
                            : result.error === "slot_conflict"
                              ? failCopy.slot_conflict
                              : result.error === "staff_cannot_perform_service"
                                ? failCopy.staff_cannot_perform_service
                                : failCopy.generic;
                        showErrorToast(reason);
                        return { ok: false, error: result.error };
                      }
                    : undefined
                }
                labels={{
                  formatTimeLabel: (utcIso: string) =>
                    utcIso ? formatInSalonTz(utcIso, timezone, "shortTime") : "",
                  conflictWith: rcMessages.grid.conflictWith,
                  overflowMessage: rcMessages.grid.overflowMessage,
                  closingLabel: rcMessages.grid.closingLabel,
                  waitlistOffer:
                    language === "vi"
                      ? "Đang mời khách chờ"
                      : "Offering to waitlist",
                  waitlistOfferUntil: (time: string) =>
                    language === "vi" ? `đến ${time}` : `until ${time}`,
                  bookingIcon: {
                    ...rcMessages.grid.bookingIcon,
                    startShort: rcMessages.latenessGrid.startShort,
                    autoNoShowAt: rcMessages.latenessGrid.autoNoShowAt,
                    lateChip: rcMessages.latenessGrid.late,
                    veryLateChip: rcMessages.latenessGrid.veryLate,
                  },
                  removedGuest: rcMessages.removedGuest,
                  latenessGrid: rcMessages.latenessGrid,
                }}
                showStaffPerformanceDetail={modules.staff_performance}
                showTimelineHeatmap={modules.timeline_heatmap}
                showBookingPrices={
                  modules.revenue_today && densityConfig.showPriceInBlock
                }
                showWalkinAccent={modules.vip_indicators}
                currencyCode={data.salon.currencyCode}
                showBookingMetaLine={densityConfig.showMetaLine}
                showBookingTimeRange={densityConfig.showTimeRangeInBlock}
                bookingBlockMinHeightPx={densityConfig.bookingBlockMinHeight}
                timeSlotMinutesVisualHint={densityConfig.timeSlotMinutes}
                autoNoShowMinutes={data.salon.autoNoShowMinutes}
                noShowTombstones={noShowsTodayList}
                waitlistOffers={data.waitlistOffers}
                onStartBooking={
                  canChangeBookingStatus(viewerRole)
                    ? (id) => void handleStartBooking(id)
                    : undefined
                }
                language={language === "vi" ? "vi" : "en"}
                onTombstoneUndo={(id) => void handleTombstoneUndo(id)}
                onTombstoneCharge={(id) => void handleTombstoneCharge(id)}
                onTombstoneWaive={(id) => void handleTombstoneWaive(id)}
              />
              )}
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
            <div className="min-h-0 flex-1 overflow-y-auto">
              <WalkinQueueSidebar
                onClose={() => setQueuePanelOpen(false)}
                closeLabel={rcMessages.queue.closePanel}
                assigningId={assigningWalkinId}
                items={queueItems}
                services={data.services.map((s) => ({
                  id: s.id,
                  name: s.name,
                  duration_minutes: s.duration_minutes,
                  price_cents: s.price_cents,
                  price_type: s.price_type,
                  price_max_cents: s.price_max_cents,
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
                waitLinkBaseUrl={originBaseUrl}
                waitLinkSalonSlug={slug}
                onCancelWalkin={onCancelWalkin}
                onStartAssign={(id) => setAssigningWalkinId(id)}
                onCancelAssign={() => setAssigningWalkinId(null)}
                addFormDisabled={isSetupIncomplete}
                isOffline={isOffline}
                offlineAddDisabledHint={
                  rcMessages.connection.offlineAddDisabled
                }
                showQuickAdd={modules.quick_add}
                focusAddNonce={addFocusNonce}
                showWaitTime={modules.wait_time}
                showVipIndicator={modules.vip_indicators}
                compact={effectiveDensity === "simple"}
                queueDisplayMode={data.salon.queueDisplayMode}
                popularServiceIds={data.popularServiceIds}
                popularServicesLabel={rcMessages.popularServices.label}
                labels={{
                  title: rcMessages.queue.title,
                  removedGuest: rcMessages.removedGuest,
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
                  requestedByClientLine: rcMessages.queue.requestedByClientLine,
                  overloadBanner: rcMessages.queue.overloadBanner,
                  overloadBannerDismiss: rcMessages.queue.overloadBannerDismiss,
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
              {/* Online waitlist — staff see online customers waiting for a
                  full slot right below the walk-in queue and invite one in a
                  single tap (texts them the claim link via SMS). */}
              <OnlineWaitlistPanel
                slug={slug}
                entries={data.onlineWaitlist}
                onCreateBooking={createBookingFromClaim}
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

      {/* Transient error toast — explains a rejected drag-to-reschedule. */}
      <div
        data-testid="reschedule-error-toast"
        aria-live="assertive"
        className={cn(
          "fixed bottom-6 left-1/2 z-50 flex max-w-[min(100vw-2rem,26rem)] -translate-x-1/2 px-4",
          "motion-safe:transition-[transform,opacity] motion-safe:duration-300 motion-safe:ease-[var(--ease-nq-out,cubic-bezier(0.22,1,0.36,1))]",
          errorToast
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-3 opacity-0",
        )}
        aria-hidden={!errorToast}
        inert={!errorToast}
      >
        <div className="flex w-full items-start gap-3 rounded-xl border-2 border-nq-error bg-nq-surface p-4 shadow-nq-card">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-nq-error text-sm font-semibold leading-none text-white"
            aria-hidden
          >
            !
          </span>
          <p className="min-w-0 flex-1 pt-1 text-sm font-medium leading-snug text-nq-foreground">
            {errorToast}
          </p>
        </div>
      </div>

      <BookingDetailDrawer
        open={drawerBookingId !== null && detailModel !== null}
        model={detailModel}
        slug={slug}
        onClose={() => closeBookingDrawer()}
        onViewPartyCard={
          openDrawerBooking?.group_id
            ? () => {
                const gid = openDrawerBooking.group_id;
                closeBookingDrawer();
                setPartyRevealed(true);
                setTimeout(() => {
                  const card = gid
                    ? document.getElementById(`party-card-${gid}`)
                    : null;
                  (card ?? document.getElementById("party-strip"))?.scrollIntoView({
                    behavior: "smooth",
                    block: "start",
                  });
                }, 50);
              }
            : undefined
        }
        copy={drawerCopy}
        viewerRole={viewerRole}
        isOffline={isOffline}
        offlineEditDisabledHint={rcMessages.connection.offlineEditDisabled}
        primaryAction={drawerPrimaryAction}
        cancelAction={drawerCancelAction}
        restoreAction={drawerRestoreAction}
        declineAction={drawerDeclineAction}
        noShowAction={drawerNoShowAction}
        finalPriceAction={drawerFinalPriceAction}
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
                  staff_name:
                    staffNameById.get(openDrawerBooking.staff_id) ?? null,
                  price_cents: openDrawerBooking.price_cents ?? 0,
                  staff_id: openDrawerBooking.staff_id,
                  service_id: openDrawerBooking.service_id,
                  addon_service_id: openDrawerBooking.addon_service_id,
                  addon_service_name: openDrawerBooking.addon_service_name,
                  addon_duration_minutes:
                    openDrawerBooking.addon_duration_minutes,
                  addon_buffer_minutes: openDrawerBooking.addon_buffer_minutes,
                  addon_price_cents: openDrawerBooking.addon_price_cents,
                  verification_method:
                    openDrawerBooking.verification_method ?? null,
                  sms_confirmation_sent_at:
                    openDrawerBooking.sms_confirmation_sent_at ?? null,
                  sms_confirmation_failed_at:
                    openDrawerBooking.sms_confirmation_failed_at ?? null,
                  no_show_risk_score:
                    openDrawerBooking.no_show_risk_score ?? null,
                  seat_together: openDrawerBooking.seat_together === true,
                  resource_id: openDrawerBooking.resource_id ?? null,
                },
                staff: data.staff.map((s) => ({ id: s.id, name: s.name })),
                services: data.services.map((s) => ({
                  id: s.id,
                  name: s.name,
                  price_cents: s.price_cents,
                  price_type: s.price_type,
                  price_max_cents: s.price_max_cents,
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
        customerContext={customerContext}
        customerContextLoading={customerContext === undefined}
        onViewProfile={
          openDrawerBooking?.client_phone
            ? () => setOpen360Phone(openDrawerBooking.client_phone)
            : undefined
        }
        onRebookNext={
          openDrawerBooking?.client_phone
            ? () => {
                const b = openDrawerBooking;
                const next = customerContext?.nextSuggestedAt ?? null;
                setDeskPrefill({
                  phone: b.client_phone ?? undefined,
                  name: b.client_name ?? undefined,
                  serviceId:
                    customerContext?.usualServiceId ?? b.service_id ?? undefined,
                  staffId:
                    customerContext?.usualStaffId ?? b.staff_id ?? undefined,
                  ymd: next ? salonYmdOfUtc(next, timezone) : undefined,
                });
                closeBookingDrawer();
                setDeskBookingOpen(true);
              }
            : undefined
        }
      />

      {/* Customer 360 — full profile, history, preferences (allergies),
          return pattern + loyalty. Opened from the booking drawer. */}
      <ClientProfile360Drawer
        slug={slug}
        clientPhone={open360Phone}
        viewerRole={viewerRole}
        onClose={() => setOpen360Phone(null)}
        onBookAgain={(phone) => {
          setOpen360Phone(null);
          setDeskPrefill({ phone, name: openDrawerBooking?.client_name ?? undefined });
          setDeskBookingOpen(true);
        }}
      />

      {depositCancel ? (
        <Modal
          isOpen
          onClose={() => setDepositCancel(null)}
          size="sm"
          title="Khách đã đặt cọc"
          description={`Khách đã cọc ${formatCurrency(depositCancel.amountCents, data.salon.currencyCode) ?? ""}. Hoàn cọc cho khách khi huỷ, hay giữ cọc?`}
        >
          <div className="flex flex-col gap-2 py-1">
            <Button
              type="button"
              variant="primary"
              loading={drawerBusy}
              data-testid="deposit-cancel-refund"
              onClick={() => {
                const id = depositCancel.id;
                setDepositCancel(null);
                void doCancelBooking(id, true);
              }}
            >
              Hoàn cọc &amp; huỷ
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={drawerBusy}
              data-testid="deposit-cancel-keep"
              onClick={() => {
                const id = depositCancel.id;
                setDepositCancel(null);
                void doCancelBooking(id, false);
              }}
            >
              Giữ cọc &amp; huỷ
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDepositCancel(null)}
            >
              Đóng
            </Button>
          </div>
        </Modal>
      ) : null}

      {notifyCancel
        ? (() => {
            const b = data.bookingsForDay.find((x) => x.id === notifyCancel.id);
            if (!b) return null;
            const settings = data.salon.staffNotificationSettings;
            const locale = resolveCustomerLocale({
              clientLocale: b.client_locale,
              salonDefaultLocale: settings.defaultLocale,
            });
            const whenLabel = new Intl.DateTimeFormat(
              locale === "vi" ? "vi-VN" : "en-US",
              {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
                timeZone: timezone,
              },
            ).format(new Date(Date.parse(b.start_time_utc)));
            const previewText = buildStaffActionSms("cancel", locale, {
              customerName: (b.client_name ?? "").trim(),
              salonName: data.salon.name,
              serviceName: b.service_name ?? "",
              whenLabel,
              salonPhone: null,
            });
            const hasPhone = !!(b.client_phone && b.client_phone.trim());
            const hasEmail = !!(b.client_email && b.client_email.trim());
            const n = rcMessages.notify;
            // Group-aware cancel: count the still-cancellable members of this
            // party (same group_id, today's grid). >1 → offer "this / whole party".
            const groupId = b.group_id ?? null;
            const partySize = groupId
              ? data.bookingsForDay.filter(
                  (x) =>
                    x.group_id === groupId &&
                    (x.status === "pending" ||
                      x.status === "confirmed" ||
                      x.status === "in_progress"),
                ).length
              : 0;
            const isGroup = !!groupId && partySize > 1;
            const cancelWhole = isGroup && cancelScope === "whole";
            return (
              <Modal
                isOpen
                onClose={() => setNotifyCancel(null)}
                size="sm"
                title={n.cancelTitle}
                description={n.cancelDesc}
              >
                <div className="flex flex-col gap-3 py-1">
                  {isGroup ? (
                    <div
                      className="flex flex-col gap-2 rounded-lg border border-nq-primary/30 bg-nq-primary/5 p-2.5"
                      data-testid="cancel-group-scope"
                    >
                      <p className="text-[12px] font-medium text-nq-foreground">
                        {n.groupBanner(partySize)}
                      </p>
                      <div className="grid grid-cols-2 gap-1.5">
                        <button
                          type="button"
                          data-testid="cancel-scope-this"
                          aria-pressed={cancelScope === "this"}
                          onClick={() => setCancelScope("this")}
                          className={cn(
                            "rounded-md px-2 py-1.5 text-[12px] font-semibold transition-colors",
                            cancelScope === "this"
                              ? "bg-nq-primary text-nq-background"
                              : "bg-nq-surface text-nq-muted hover:text-nq-foreground",
                          )}
                        >
                          {n.cancelThisOne}
                        </button>
                        <button
                          type="button"
                          data-testid="cancel-scope-whole"
                          aria-pressed={cancelScope === "whole"}
                          onClick={() => setCancelScope("whole")}
                          className={cn(
                            "rounded-md px-2 py-1.5 text-[12px] font-semibold transition-colors",
                            cancelScope === "whole"
                              ? "bg-nq-error text-white"
                              : "bg-nq-surface text-nq-muted hover:text-nq-foreground",
                          )}
                        >
                          {n.cancelWholeParty(partySize)}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <NotifyCustomerPanel
                    value={notifyCancelChannels}
                    onChange={setNotifyCancelChannels}
                    hasPhone={hasPhone}
                    hasEmail={hasEmail}
                    previewText={previewText}
                    labels={{
                      heading: n.heading,
                      sms: n.sms,
                      email: n.email,
                      previewTitle: n.previewTitle,
                      willNotNotify: n.willNotNotify,
                      noPhone: n.noPhone,
                      noEmail: n.noEmail,
                      languageNote: locale === "vi" ? n.langVi : n.langEn,
                    }}
                  />
                  <div className="flex flex-col gap-2">
                    <Button
                      type="button"
                      variant="danger"
                      loading={drawerBusy}
                      data-testid="notify-cancel-confirm"
                      onClick={() => {
                        const id = notifyCancel.id;
                        const ch = {
                          sms: notifyCancelChannels.sms && hasPhone,
                          email: notifyCancelChannels.email && hasEmail,
                        };
                        setNotifyCancel(null);
                        if (cancelWhole && groupId) {
                          void doCancelGroup(groupId, ch);
                        } else {
                          void doCancelBooking(id, false, ch);
                        }
                      }}
                    >
                      {cancelWhole
                        ? n.confirmCancelGroup(partySize)
                        : n.confirmCancel}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setNotifyCancel(null)}
                    >
                      {n.keep}
                    </Button>
                  </div>
                </div>
              </Modal>
            );
          })()
        : null}

      {/* No-show fee charge/waive modal — shown when the booking has a Square card on file. */}
      {noShowChargeModal ? (
        <Modal
          isOpen={!!noShowChargeModal}
          onClose={() => setNoShowChargeModal(null)}
          size="sm"
          title={rcMessages.noShowFeeModal.title}
          description={rcMessages.noShowFeeModal.desc(
            formatCurrency(noShowChargeModal.feeCents, data.salon.currencyCode) ?? "",
          )}
          footer={
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="w-full rounded-xl bg-nq-warning/90 px-4 py-3 text-sm font-semibold text-white transition-all hover:bg-nq-warning active:scale-[0.98]"
                onClick={() => {
                  const id = noShowChargeModal.bookingId;
                  setNoShowChargeModal(null);
                  void handleMarkNoShow(id, true);
                }}
              >
                {rcMessages.noShowFeeModal.charge(
                  formatCurrency(noShowChargeModal.feeCents, data.salon.currencyCode) ?? "",
                )}
              </button>
              <button
                type="button"
                className="w-full rounded-xl border border-nq-border px-4 py-3 text-sm font-medium text-nq-muted transition-colors hover:bg-nq-surface/60"
                onClick={() => {
                  const id = noShowChargeModal.bookingId;
                  setNoShowChargeModal(null);
                  void handleMarkNoShow(id, false);
                }}
              >
                {rcMessages.noShowFeeModal.waive}
              </button>
              <button
                type="button"
                className="w-full px-4 py-2 text-sm text-nq-muted transition-colors hover:text-nq-foreground"
                onClick={() => setNoShowChargeModal(null)}
              >
                {rcMessages.noShowFeeModal.cancel}
              </button>
            </div>
          }
          showCloseButton={false}
        />
      ) : null}
    </>
  );
}

export function ReceptionistCenter({
  slug,
  initialResult,
  viewerRole,
  bookingLimitStatus,
  partyCards,
  groupBookingEnabled = true,
  tvModeEnabled = true,
  accentColor,
  bgColor,
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
      groupBookingEnabled={groupBookingEnabled}
      tvModeEnabled={tvModeEnabled}
      accentColor={accentColor ?? null}
      bgColor={bgColor ?? null}
    />
  );
}
