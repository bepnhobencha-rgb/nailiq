"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { loadReceptionistCenterDataAction } from "@/shared/dashboard/loadReceptionistCenterDataAction";
import type { ReceptionistCenterData } from "@/shared/dashboard/loadReceptionistCenterData";
import type { ReceptionistMessages } from "@/shared/i18n/user";
import { cn } from "@/shared/lib/cn";
import { formatInSalonTz, salonToday } from "@/shared/lib/salonTime";

/**
 * 7-column read-only week-overview grid for the Receptionist Center.
 *
 * Data: loads 7 days in parallel via the existing
 * `loadReceptionistCenterDataAction` server action — accepts the cost of
 * 7 round-trips for now to avoid introducing a new server action / RPC
 * dedicated to a week range. Per `DASHBOARD_LAYOUT_RULES.md` §3 the
 * three-zone layout is locked for the live desk; the week view sits
 * **alongside** it as a different operational job (planning glance, not
 * intake), so we don't try to retrofit the staff×timeline geometry.
 *
 * Read-only by design: no drag, no create — receptionists switch back
 * to the Day view to act on a slot. Click a day column → the parent
 * switches to Day view for that date.
 */

const TOP_BOOKINGS_PER_DAY = 3;
const DAYS_PER_WEEK = 7;

/** YYYY-MM-DD → Date at local midnight (no tz drift; consumers pass salon-local YMDs). */
function ymdToLocalDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Rebuild YYYY-MM-DD from a local Date. */
function localDateToYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Monday of the week containing the supplied YMD (Mon-Sun grid). */
export function mondayYmdOf(ymd: string): string {
  const d = ymdToLocalDate(ymd);
  // Sun=0, Mon=1, … Sat=6 in JS; we want Mon=0 … Sun=6.
  const monIdx = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - monIdx);
  return localDateToYmd(d);
}

/** Mon-Sun YMDs starting at `mondayYmd`. */
function weekYmds(mondayYmd: string): string[] {
  const out: string[] = [];
  const start = ymdToLocalDate(mondayYmd);
  for (let i = 0; i < DAYS_PER_WEEK; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(localDateToYmd(d));
  }
  return out;
}

export function shiftWeek(mondayYmd: string, weeks: number): string {
  const d = ymdToLocalDate(mondayYmd);
  d.setDate(d.getDate() + weeks * DAYS_PER_WEEK);
  return localDateToYmd(d);
}

type DayState =
  | { kind: "loading" }
  | {
      kind: "ok";
      bookings: ReceptionistCenterData["bookingsForDay"];
    }
  | { kind: "error" };

export interface WeekViewProps {
  slug: string;
  /** YYYY-MM-DD (salon-local) of the Monday at the start of the visible week. */
  mondayYmd: string;
  /** Salon timezone — used only to format the day-header date label. */
  timezone: string;
  /** Today (salon-local) so we can highlight the "today" column. */
  todayYmd: string;
  messages: ReceptionistMessages["weekView"];
  /** Tap a day header → parent flips to Day view for that date. */
  onDayClick: (ymd: string) => void;
  /** Week navigation handlers. */
  onPrevWeek: () => void;
  onThisWeek: () => void;
  onNextWeek: () => void;
}

export function WeekView({
  slug,
  mondayYmd,
  timezone,
  todayYmd,
  messages,
  onDayClick,
  onPrevWeek,
  onThisWeek,
  onNextWeek,
}: WeekViewProps) {
  const ymds = useMemo(() => weekYmds(mondayYmd), [mondayYmd]);
  const [days, setDays] = useState<Record<string, DayState>>({});

  useEffect(() => {
    let cancelled = false;
    setDays(
      Object.fromEntries(ymds.map((y) => [y, { kind: "loading" } as DayState])),
    );
    void Promise.all(
      ymds.map(async (ymd) => {
        const res = await loadReceptionistCenterDataAction(slug, ymd);
        return { ymd, res };
      }),
    ).then((results) => {
      if (cancelled) return;
      const next: Record<string, DayState> = {};
      for (const { ymd, res } of results) {
        if (res.ok) {
          next[ymd] = { kind: "ok", bookings: res.data.bookingsForDay };
        } else {
          next[ymd] = { kind: "error" };
        }
      }
      setDays(next);
    });
    return () => {
      cancelled = true;
    };
  }, [slug, ymds]);

  /** Range label "Mon 5 – Sun 11" — uses local date math, no tz dependence
   *  beyond what the YMDs already encode. Using the salon timezone for the
   *  individual day labels would add a UTC-vs-local round-trip; the
   *  short labels read identically either way. */
  const rangeLabel = useMemo(() => {
    if (ymds.length === 0) return "";
    const fmt = (ymd: string) => {
      const d = ymdToLocalDate(ymd);
      return new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        day: "numeric",
        month: "short",
      }).format(d);
    };
    return `${fmt(ymds[0])} – ${fmt(ymds[ymds.length - 1])}`;
  }, [ymds]);

  return (
    <div
      data-testid="week-view"
      className="mx-auto flex w-full max-w-[var(--max-nq-desktop)] flex-col gap-3 px-[var(--pad-nq-section-mobile)] py-4 md:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-nq-muted">
            {messages.title}
          </p>
          <p className="truncate text-sm text-nq-foreground">{rangeLabel}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            data-testid="week-view-prev"
            onClick={onPrevWeek}
            className="rounded-md border border-nq-border bg-nq-surface px-2.5 py-1 text-xs font-medium text-nq-foreground hover:border-nq-primary/40"
          >
            ← {messages.prevWeek}
          </button>
          <button
            type="button"
            data-testid="week-view-this-week"
            onClick={onThisWeek}
            className="rounded-md border border-nq-primary/45 bg-nq-primary/10 px-2.5 py-1 text-xs font-medium text-nq-primary hover:bg-nq-primary/[0.16]"
          >
            {messages.thisWeek}
          </button>
          <button
            type="button"
            data-testid="week-view-next"
            onClick={onNextWeek}
            className="rounded-md border border-nq-border bg-nq-surface px-2.5 py-1 text-xs font-medium text-nq-foreground hover:border-nq-primary/40"
          >
            {messages.nextWeek} →
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <ul
          data-testid="week-view-grid"
          className="grid min-w-[42rem] grid-cols-7 gap-3"
        >
          {ymds.map((ymd) => {
            const isToday = ymd === todayYmd;
            const state = days[ymd] ?? { kind: "loading" as const };
            const date = ymdToLocalDate(ymd);
            const weekday = new Intl.DateTimeFormat("en-US", {
              weekday: "short",
            }).format(date);
            const dayNum = date.getDate();

            return (
              <li key={ymd} data-testid={`week-view-day-${ymd}`}>
                <Card
                  variant={isToday ? "elevated" : "default"}
                  padding="sm"
                  className={cn(
                    "h-full",
                    isToday && "ring-1 ring-nq-primary/45",
                  )}
                >
                  <button
                    type="button"
                    data-testid={`week-view-day-button-${ymd}`}
                    onClick={() => onDayClick(ymd)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nq-primary/40",
                    )}
                    aria-label={messages.openDayAria.replace(
                      "{date}",
                      `${weekday} ${dayNum}`,
                    )}
                  >
                    <span
                      className={cn(
                        "text-xs font-semibold uppercase tracking-wide",
                        isToday ? "text-nq-primary" : "text-nq-muted",
                      )}
                    >
                      {weekday}
                    </span>
                    <span
                      className={cn(
                        "text-base font-semibold tabular-nums",
                        isToday ? "text-nq-primary" : "text-nq-foreground",
                      )}
                    >
                      {dayNum}
                    </span>
                  </button>

                  {state.kind === "loading" ? (
                    <p className="mt-2 text-[11px] text-nq-muted">
                      {messages.loading}
                    </p>
                  ) : null}

                  {state.kind === "error" ? (
                    <p
                      className="mt-2 text-[11px] text-nq-error"
                      role="alert"
                      data-testid={`week-view-day-error-${ymd}`}
                    >
                      {messages.dayError}
                    </p>
                  ) : null}

                  {state.kind === "ok" ? (
                    <DayColumnContent
                      bookings={state.bookings}
                      timezone={timezone}
                      moreLabel={messages.moreCount}
                      emptyLabel={messages.emptyDay}
                      countLabel={messages.bookingCount}
                    />
                  ) : null}
                </Card>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function DayColumnContent({
  bookings,
  timezone,
  moreLabel,
  emptyLabel,
  countLabel,
}: {
  bookings: ReceptionistCenterData["bookingsForDay"];
  timezone: string;
  moreLabel: string;
  emptyLabel: string;
  countLabel: string;
}) {
  const sorted = useMemo(() => {
    return [...bookings].sort((a, b) => {
      const am = Date.parse(a.start_time_utc);
      const bm = Date.parse(b.start_time_utc);
      return (Number.isFinite(am) ? am : 0) - (Number.isFinite(bm) ? bm : 0);
    });
  }, [bookings]);

  const visible = sorted.slice(0, TOP_BOOKINGS_PER_DAY);
  const more = Math.max(0, sorted.length - TOP_BOOKINGS_PER_DAY);

  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <Badge variant="info" state="subtle" size="sm">
        {countLabel.replace("{n}", String(sorted.length))}
      </Badge>

      {sorted.length === 0 ? (
        <p className="text-[11px] italic text-nq-muted">{emptyLabel}</p>
      ) : null}

      {visible.map((b) => (
        <div
          key={b.id}
          className="rounded-md border border-nq-border/50 bg-nq-surface/60 px-1.5 py-1 text-[11px] text-nq-foreground"
        >
          <p className="truncate font-medium">
            {formatInSalonTz(b.start_time_utc, timezone, "shortTime")}{" "}
            <span className="font-normal text-nq-muted">
              {b.client_name}
            </span>
          </p>
          <p className="truncate text-nq-muted">{b.service_name}</p>
        </div>
      ))}

      {more > 0 ? (
        <p
          className="text-[11px] font-medium text-nq-muted"
          data-testid="week-view-more"
        >
          {moreLabel.replace("{n}", String(more))}
        </p>
      ) : null}
    </div>
  );
}
