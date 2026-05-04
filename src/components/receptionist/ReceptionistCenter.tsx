"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import Link from "next/link";
import { useRouter } from "next/navigation";

import { createClient } from "@/shared/lib/supabase/client";
import { UserLanguageToggle } from "@/components/user/UserLanguageToggle";
import { BookingDetailDrawer, type BookingDetailDrawerModel } from "./BookingDetailDrawer";
import { DateSwitcher } from "./DateSwitcher";
import { StaffTimelineGrid, type GridBooking } from "./StaffTimelineGrid";
import { StatusPill } from "./StatusPill";
import { UndoToast } from "./UndoToast";
import { WalkinQueueSidebar, type QueueItem } from "./WalkinQueueSidebar";
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
import { formatInSalonTz, salonDateOffset, salonToday } from "@/shared/lib/salonTime";
import { useUserLanguage } from "@/shared/lib/useUserLanguage";
import type { BookingStatus } from "@/shared/types";

export type ReceptionistCenterProps = {
  slug: string;
  /** Server load result (`ok: false` shows localized shell only). */
  initialResult: LoadReceptionistCenterResult;
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

function ReceptionistCenterInner({ slug, initialOk }: { slug: string; initialOk: ReceptionistCenterData }) {
  const router = useRouter();
  const { language, setLanguage } = useUserLanguage();
  const messages = useMemo(() => getUserMessages(language), [language]);

  const [nowIso, setNowIso] = useState(() => new Date().toISOString());
  const nowIsoRef = useRef(nowIso);
  nowIsoRef.current = nowIso;

  useEffect(() => {
    const tick = window.setInterval(() => {
      setNowIso(new Date().toISOString());
    }, 60_000);
    return () => window.clearInterval(tick);
  }, []);

  const [data, setData] = useState<ReceptionistCenterData>(() => ({
    ...initialOk,
    selectedDate: initialOk.selectedDate,
  }));

  useEffect(() => {
    setData({ ...initialOk, selectedDate: initialOk.selectedDate });
  }, [initialOk]);

  const [dateOffset, setDateOffset] = useState<-1 | 0 | 1>(0);

  useEffect(() => {
    const tz = data.salon.timezone;
    const today = salonDateOffset(tz, 0, nowIso);
    if (data.selectedDate === today) {
      setDateOffset(0);
    } else {
      const yesterday = salonDateOffset(tz, -1, nowIso);
      const tomorrow = salonDateOffset(tz, 1, nowIso);
      if (data.selectedDate === yesterday) setDateOffset(-1);
      else if (data.selectedDate === tomorrow) setDateOffset(1);
    }
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

  const [drawerBusy, setDrawerBusy] = useState(false);

  const staffNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of data.staff) {
      map.set(s.id, s.name);
    }
    return map;
  }, [data.staff]);

  const busyStaffIds = useMemo(() => {
    return new Set(
      data.bookingsForDay.filter((b) => b.status === "in_progress").map((b) => b.staff_id),
    );
  }, [data.bookingsForDay]);

  const gridStaff = useMemo(
    () =>
      data.staff.map((s) => ({
        id: s.id,
        name: s.name,
        job_role: s.job_role,
        isBusy: busyStaffIds.has(s.id),
      })),
    [data.staff, busyStaffIds],
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
        },
      ];
    });
  }, [data.bookingsForDay]);

  const queueItems: QueueItem[] = data.walkinQueue;

  const inProgressToday = data.bookingsForDay.filter((b) => b.status === "in_progress").length;

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
    const durMin = Math.max(
      0,
      Math.round(Number(b.service_duration_minutes ?? 0)),
    );
    const bufMin = Math.max(
      0,
      Math.round(Number(b.service_buffer_minutes ?? 0)),
    );

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
      String(Number(b.service_duration_minutes ?? 0)),
    );

    const priceLine =
      b.price_cents != null && Number.isFinite(b.price_cents)
        ? `$${(Number(b.price_cents) / 100).toFixed(2)}`
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
    };
  }, [drawerBookingId, data.bookingsForDay, staffNameById, messages, timezone]);

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
  }) => {
    const r = await addWalkinToQueue(slug, {
      salonId: data.salon.id,
      clientName: input.clientName,
      clientPhone: input.clientPhone,
      serviceId: input.serviceId,
      staffRequestNote: input.staffRequestNote ?? undefined,
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
              {isViewingToday ? (
                <StatusPill
                  waitingCount={queueItems.length}
                  inProgressCount={inProgressToday}
                  labelWaiting={rcMessages.statusPill.waitingLabel}
                  labelInProgress={rcMessages.statusPill.inProgressLabel}
                />
              ) : null}
              <UserLanguageToggle language={language} onLanguageChange={setLanguage} />
            </div>
          </div>
          <div
            className={cn(
              "mx-auto mt-3 flex w-full max-w-[var(--max-nq-desktop)] flex-wrap items-center gap-2",
              dayLoading && "pointer-events-none opacity-60",
            )}
            aria-busy={dayLoading}
          >
            <DateSwitcher
              selectedOffset={dateOffset}
              onChange={(next) => void onDateSwitchChange(next)}
              labels={rcMessages.dateSwitcher}
            />
            {dayLoading ? (
              <span className="text-xs font-medium text-nq-muted">{rcMessages.loadingDay}</span>
            ) : null}
          </div>
        </header>

        {isSetupIncomplete ? (
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

        <div
          className={cn(
            "mx-auto flex h-full min-h-[min(100dvh-8rem,48rem)] w-full max-w-[var(--max-nq-desktop)] flex-1 flex-col gap-0",
            isViewingToday && "md:flex-row",
          )}
        >
          <section
            className={cn(
              "flex min-h-[min(50dvh,28rem)] min-w-0 flex-1 flex-col border-t border-nq-muted/20",
              isViewingToday
                ? "order-2 md:order-1 md:border-t-0 md:border-r"
                : "order-1 w-full",
            )}
          >
            <StaffTimelineGrid
              staff={gridStaff}
              bookings={gridBookings}
              assigning={assignedSlot}
              selectedDate={data.selectedDate}
              timezone={timezone}
              nowIso={nowIso}
              existingBookings={gridBookings}
              onBookingClick={(id) => setDrawerBookingId(id)}
              onSlotClick={(staffId, utc) => void onWalkinAssignSlot(staffId, utc)}
              labels={{
                formatTimeLabel: (utcIso: string) => formatInSalonTz(utcIso, timezone, "shortTime"),
                conflictWith: rcMessages.grid.conflictWith,
                overflowMessage: rcMessages.grid.overflowMessage,
              }}
            />
          </section>
          {isViewingToday ? (
            <div className="order-1 h-[min(42dvh,22rem)] min-h-[12rem] w-full shrink-0 md:order-2 md:h-auto md:w-[min(22rem,calc(100vw-2rem))] md:max-w-sm">
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
                labels={{
                  title: rcMessages.queue.title,
                  emptyMessage: rcMessages.queue.emptyMessage,
                  cancelButton: rcMessages.queue.cancelButton,
                  assignButton: rcMessages.queue.assignButton,
                  urgentBadge: rcMessages.queue.urgentBadge,
                  waitingHint: rcMessages.queue.waitingHint,
                  minutesAgo: rcMessages.queue.minutesAgo,
                  addForm: {
                    ...rcMessages.queue.addForm,
                    invalidPhone: rcMessages.walkin.invalidPhone,
                    phoneRequired: rcMessages.walkin.phoneRequired,
                    invalidName: rcMessages.walkin.invalidName,
                    invalidNameChars: rcMessages.walkin.invalidNameChars,
                  },
                }}
              />
            </div>
          ) : null}
        </div>
      </div>

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
                },
                staff: data.staff.map((s) => ({ id: s.id, name: s.name })),
                services: data.services.map((s) => ({
                  id: s.id,
                  name: s.name,
                  price_cents: s.price_cents,
                  duration_minutes: s.duration_minutes,
                  buffer_minutes: s.buffer_minutes,
                })),
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

export function ReceptionistCenter({ slug, initialResult }: ReceptionistCenterProps) {
  if (!initialResult.ok) {
    return <ReceptionistGateError code={initialResult.error} />;
  }
  return <ReceptionistCenterInner slug={slug} initialOk={initialResult.data} />;
}
