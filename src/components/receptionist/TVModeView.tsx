"use client";

import { useMemo, useState, useTransition } from "react";

import { Badge } from "@/components/ui/Badge";
import { StaffAvatar, type StaffStatus } from "@/components/ui/StaffAvatar";
import { updateDashboardPreset } from "@/shared/dashboard/salonOwnerActions";
import { cn } from "@/shared/lib/cn";
import { minutesWaiting } from "@/shared/lib/queueUrgency";
import { formatInSalonTz } from "@/shared/lib/salonTime";
import type { ReceptionistMessages } from "@/shared/i18n/user";

/**
 * TV Mode — read-only wall display for shared salon screens.
 *
 * Per `DASHBOARD_LAYOUT_RULES.md` §3 (TV preset): "Touch precision paths
 * may be reduced — remote or glance use — but the three-zone map remains
 * recognizable from across a room." This view distills that into a
 * single-column at-a-glance read: clock, staff status, queue summary.
 *
 * No click handlers, no forms, no drawers. Updates flow through the
 * caller's existing realtime subscription (parent re-renders with fresh
 * `staff` / `bookingsForDay` / `walkinQueue` props).
 */
export type TVModeStaff = {
  id: string;
  name: string;
  status: StaffStatus;
};

export type TVModeBooking = {
  id: string;
  staff_id: string;
  client_name: string;
  service_name: string;
  status: "pending" | "confirmed" | "in_progress" | "completed" | "waiting" | "cancelled";
};

export type TVModeQueueItem = {
  id: string;
  joined_queue_at: string;
};

export interface TVModeViewProps {
  slug: string;
  salonName: string;
  staff: ReadonlyArray<TVModeStaff>;
  bookingsForDay: ReadonlyArray<TVModeBooking>;
  walkinQueue: ReadonlyArray<TVModeQueueItem>;
  nowIso: string;
  timezone: string;
  messages: ReceptionistMessages;
}

const STATUS_LABELS: Record<StaffStatus, string> = {
  available: "available",
  busy: "busy",
  overbooked: "overbooked",
  offline: "offline",
};

const STATUS_VARIANTS: Record<
  StaffStatus,
  "success" | "warning" | "danger" | "neutral"
> = {
  available: "success",
  busy: "warning",
  overbooked: "danger",
  offline: "neutral",
};

export function TVModeView({
  slug,
  salonName,
  staff,
  bookingsForDay,
  walkinQueue,
  nowIso,
  timezone,
  messages,
}: TVModeViewProps) {
  const [isPending, startTransition] = useTransition();
  const [exitError, setExitError] = useState<string | null>(null);

  const clockLabel = useMemo(
    () => formatInSalonTz(nowIso, timezone, "time"),
    [nowIso, timezone],
  );

  /** Map staff_id → current `in_progress` booking, if any. */
  const currentByStaff = useMemo(() => {
    const m = new Map<string, TVModeBooking>();
    for (const b of bookingsForDay) {
      if (b.status === "in_progress") {
        m.set(b.staff_id, b);
      }
    }
    return m;
  }, [bookingsForDay]);

  /** Estimated wait = average minutes already waited across queue. Pure
   *  read-only signal, intentionally simple — TV mode is glance, not
   *  forecasting. Returns null when queue is empty. */
  const estWaitMinutes = useMemo(() => {
    if (walkinQueue.length === 0) return null;
    let total = 0;
    for (const q of walkinQueue) {
      total += minutesWaiting(q.joined_queue_at, nowIso);
    }
    return Math.round(total / walkinQueue.length);
  }, [walkinQueue, nowIso]);

  const tv = messages.tv;

  const onExit = () => {
    if (isPending) return;
    setExitError(null);
    startTransition(async () => {
      const res = await updateDashboardPreset(slug, "reception");
      if (!res.ok) {
        setExitError(messages.actionErrorFallback);
      }
    });
  };

  return (
    <div
      data-testid="tv-mode-view"
      className="group relative flex min-h-[100dvh] w-full flex-col bg-nq-bg text-nq-foreground"
    >
      <header className="flex shrink-0 flex-col items-center gap-2 px-6 pt-10 pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-nq-muted">
          {tv.title}
        </p>
        <p
          data-testid="tv-mode-clock"
          className="font-mono text-[clamp(3rem,8vw,5rem)] font-bold leading-none tabular-nums text-nq-foreground"
          aria-label={`Current time ${clockLabel}`}
        >
          {clockLabel}
        </p>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-4 px-6 pb-6">
        <ul
          data-testid="tv-mode-staff-list"
          className="flex flex-col gap-3"
        >
          {staff.map((s) => {
            const current = currentByStaff.get(s.id);
            return (
              <li
                key={s.id}
                data-testid={`tv-mode-staff-row-${s.id}`}
                className={cn(
                  "flex items-center gap-4 rounded-xl border border-nq-border/60 bg-nq-surface px-5 py-4",
                )}
              >
                <StaffAvatar
                  name={s.name}
                  status={s.status}
                  size="lg"
                  showStatus
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="truncate text-2xl font-semibold leading-tight">
                    {s.name}
                  </p>
                  {current ? (
                    <p className="truncate text-lg leading-tight text-nq-foreground/85">
                      <span className="font-medium">{current.client_name}</span>
                      <span className="text-nq-muted"> · {current.service_name}</span>
                    </p>
                  ) : (
                    <p className="truncate text-lg leading-tight text-nq-muted">
                      {tv.noBookings}
                    </p>
                  )}
                </div>
                <Badge
                  variant={STATUS_VARIANTS[s.status]}
                  state="default"
                  size="lg"
                >
                  {STATUS_LABELS[s.status]}
                </Badge>
              </li>
            );
          })}
        </ul>

        <div
          data-testid="tv-mode-queue-summary"
          className="flex flex-col items-center gap-1 rounded-xl border border-nq-border/60 bg-nq-surface px-6 py-5 text-center"
        >
          <p className="text-3xl font-semibold tabular-nums">
            {walkinQueue.length}{" "}
            <span className="text-xl font-medium text-nq-muted">
              {tv.guestsWaiting}
            </span>
          </p>
          {estWaitMinutes !== null ? (
            <p className="text-base text-nq-muted">
              {tv.estWait}: {messages.kpiBar.minutesShort(estWaitMinutes)}
            </p>
          ) : null}
        </div>
      </main>

      <footer className="flex shrink-0 items-center justify-center px-6 pb-6 pt-2">
        <p className="truncate text-sm text-nq-muted">{salonName}</p>
      </footer>

      {/* Exit affordance — corner-anchored, hidden until hover/focus per
          UX_PRINCIPLES §1 (calm by default). Aria-label keeps it
          discoverable to AT users even while visually subtle. */}
      <button
        type="button"
        data-testid="tv-mode-exit"
        aria-label={tv.exitTvMode}
        disabled={isPending}
        onClick={onExit}
        className={cn(
          "absolute bottom-3 right-3 rounded-full border border-nq-border/60 bg-nq-surface/90 px-3 py-1.5 text-xs font-medium text-nq-muted",
          "opacity-0 transition-opacity duration-[var(--duration-nq-normal,200ms)] focus-visible:opacity-100 group-hover:opacity-100",
          "hover:text-nq-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
        )}
      >
        {tv.exitTvMode}
      </button>

      {exitError ? (
        <p
          role="alert"
          data-testid="tv-mode-exit-error"
          className="absolute bottom-12 right-3 rounded-md bg-nq-error/15 px-2 py-1 text-xs text-nq-error"
        >
          {exitError}
        </p>
      ) : null}
    </div>
  );
}
