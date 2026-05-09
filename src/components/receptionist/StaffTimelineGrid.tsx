"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import { BookingBlock } from "./BookingBlock";
import { GhostBlock } from "./GhostBlock";
import { NowLine } from "./NowLine";
import {
  StaffAvatar,
  type StaffSkill,
  type StaffStatus,
} from "@/components/ui/StaffAvatar";
import { checkBookingConflict, type ConflictCheckBooking } from "@/shared/lib/conflictCheck";
import { cn } from "@/shared/lib/cn";
import {
  salonNowMinutes,
  salonWallTimeToUtcIso,
  utcIsoToSalonMinutesFromMidnight,
} from "@/shared/lib/salonTime";

const HOUR_START = 8;
const HOUR_END = 20;
const SLOT_MINUTES = 30;
const SLOT_PX = 64;
const ROW_HEIGHT = 76;
const STAFF_COL_WIDTH = 140;
const TIME_HEADER_HEIGHT = 44;
const TOTAL_SLOTS = (HOUR_END - HOUR_START) * 2;

export interface GridStaff {
  id: string;
  name: string;
  job_role: string;
  /**
   * Operational availability — drives `StaffAvatar` status dot. Computed
   * server-side in `loadReceptionistCenterData` from today's bookings +
   * `staff.status` (inactive/pending → "offline").
   */
  status: StaffStatus;
  /**
   * Relative workload 0–100 for the day; busiest staff = 100. Rendered as
   * the bar under the avatar when `staff_performance` module is on.
   */
  workload: number;
  /**
   * Skill tags (filtered to known `StaffSkill` keys at the data boundary).
   * Rendered as `Badge` row under the avatar when `staff_performance` is
   * on.
   */
  skills: ReadonlyArray<StaffSkill>;
}

export interface GridBooking {
  id: string;
  client_name: string;
  service_name: string;
  status: "pending" | "confirmed" | "in_progress" | "completed";
  source: "appointment" | "walkin";
  staff_id: string;
  start_time_utc: string;
  end_time_utc: string;
  price_cents: number | null;
  /**
   * Server-derived booking-block icon flags (see
   * `loadReceptionistCenterData.ts` for the derivation rules — no new
   * DB columns).
   */
  is_vip: boolean;
  has_notes: boolean;
  has_design: boolean;
}

export interface StaffTimelineGridProps {
  staff: GridStaff[];
  bookings: GridBooking[];
  assigning: {
    queueItemId: string;
    clientName: string;
    serviceDurationMinutes: number;
  } | null;
  selectedDate: string;
  timezone: string;
  nowIso: string;
  /** When false, hide now line and skip jump-to-now scrolling (yesterday/tomorrow). */
  isViewingToday: boolean;
  /** Increment (e.g. from parent) to smooth-scroll to the current time column. */
  jumpToNowTrigger: number;
  existingBookings: GridBooking[];
  onBookingClick: (bookingId: string) => void;
  onSlotClick: (staffId: string, slotStartUtc: string) => void;
  labels: {
    formatTimeLabel: (utc: string) => string;
    conflictWith: (clientName: string) => string;
    overflowMessage: string;
    /**
     * Localized icon-stack labels for the booking block. Optional —
     * defaults to English titles in `BookingBlock` when omitted.
     */
    bookingIcon?: {
      vip: string;
      notes: string;
      late: string;
      design: string;
    };
  };
  /** When false, hides per-staff role line and busy ring on avatars (`staff_performance`). */
  showStaffPerformanceDetail?: boolean;
  /** When false, softens vertical slot dividers (`timeline_heatmap`). */
  showTimelineHeatmap?: boolean;
  /** Passed to each booking block (`revenue_today`). */
  showBookingPrices?: boolean;
  /** Passed to each booking block (`vip_indicators`). */
  showWalkinAccent?: boolean;
  /**
   * Density-derived flag — controls the secondary meta line (service +
   * price) on booking blocks. Off in `simple` density to keep blocks
   * calm; on otherwise. Composes with `showBookingPrices` (price segment
   * still requires both).
   */
  showBookingMetaLine?: boolean;
  /**
   * Density-derived flag — controls the `StaffAvatar` skills row in the
   * staff column. Composes with `showStaffPerformanceDetail` (both must
   * be true).
   */
  showStaffSkillBadges?: boolean;
  /**
   * Density-derived visual override for booking block minimum height
   * (px). Visual only — schedule math (slot count + GIST overlap)
   * remains on the salon's true 30-minute cadence.
   */
  bookingBlockMinHeightPx?: number;
  /**
   * Density-derived visual hint for slot row height tier (20 / 30 / 40
   * minutes equivalent). Visual only — does not change `SLOT_PX` or
   * `TOTAL_SLOTS`. Reserved for future density-driven row-height
   * adjustments; currently unused but plumbed so the contract stays
   * stable as density tightens.
   */
  timeSlotMinutesVisualHint?: 20 | 30 | 40;
}

function slotIndexToUtc(
  slotIndex: number,
  selectedDate: string,
  timezone: string,
): string {
  const minutesFromMidnight = HOUR_START * 60 + slotIndex * SLOT_MINUTES;
  return salonWallTimeToUtcIso(selectedDate, minutesFromMidnight, timezone);
}

function bookingToPosition(booking: GridBooking, timezone: string) {
  const startMin = utcIsoToSalonMinutesFromMidnight(booking.start_time_utc, timezone);
  const minutesFrom8 = startMin - HOUR_START * 60;
  const durationMin =
    (Date.parse(booking.end_time_utc) - Date.parse(booking.start_time_utc)) / 60_000;
  return {
    leftPx: (minutesFrom8 / SLOT_MINUTES) * SLOT_PX,
    widthPx: (durationMin / SLOT_MINUTES) * SLOT_PX,
  };
}

function computeNowLineLeftPx(nowIso: string, timezone: string): number | null {
  const m = salonNowMinutes(timezone, nowIso);
  const gridStart = HOUR_START * 60;
  const gridEnd = HOUR_END * 60;
  if (m < gridStart || m >= gridEnd) {
    return null;
  }
  const minutesFrom8 = m - gridStart;
  return (minutesFrom8 / SLOT_MINUTES) * SLOT_PX;
}

/** Nearest 30-minute slot center for scroll alignment (≈ ±15 min from "now"). */
function computeNearestSlotCenterLeftPx(nowIso: string, timezone: string): number | null {
  const m = salonNowMinutes(timezone, nowIso);
  const gridStart = HOUR_START * 60;
  const gridEnd = HOUR_END * 60;
  if (m < gridStart || m >= gridEnd) {
    return null;
  }
  const minutesFrom8 = m - gridStart;
  const slotIndex = Math.round(minutesFrom8 / SLOT_MINUTES);
  const clamped = Math.max(0, Math.min(TOTAL_SLOTS - 1, slotIndex));
  return clamped * SLOT_PX + SLOT_PX / 2;
}

function toConflictRows(bookings: GridBooking[]): ConflictCheckBooking[] {
  return bookings.map((b) => ({
    id: b.id,
    staff_id: b.staff_id,
    start_time_utc: b.start_time_utc,
    end_time_utc: b.end_time_utc,
    status: b.status,
    client_name: b.client_name,
  }));
}

const timelineWidthPx = TOTAL_SLOTS * SLOT_PX;

export function StaffTimelineGrid({
  staff,
  bookings,
  assigning,
  selectedDate,
  timezone,
  nowIso,
  isViewingToday,
  jumpToNowTrigger,
  existingBookings,
  onBookingClick,
  onSlotClick,
  labels,
  showStaffPerformanceDetail = true,
  showTimelineHeatmap = true,
  showBookingPrices = true,
  showWalkinAccent = true,
  showBookingMetaLine = true,
  showStaffSkillBadges = true,
  bookingBlockMinHeightPx,
  // `timeSlotMinutesVisualHint` is reserved for future row-height
  // adjustments; currently unused at runtime.
  timeSlotMinutesVisualHint: _timeSlotMinutesVisualHint,
}: StaffTimelineGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrolledRef = useRef(false);
  const prevJumpTriggerRef = useRef(0);

  const [hoveredSlot, setHoveredSlot] = useState<{
    staffId: string;
    slotIndex: number;
  } | null>(null);

  const conflictRows = useMemo(
    () => toConflictRows(existingBookings),
    [existingBookings],
  );

  const bookingsByStaff = useMemo(() => {
    const m = new Map<string, GridBooking[]>();
    for (const b of bookings) {
      const list = m.get(b.staff_id) ?? [];
      list.push(b);
      m.set(b.staff_id, list);
    }
    return m;
  }, [bookings]);

  const nowLineLeftPx = useMemo(() => {
    if (!isViewingToday) return null;
    return computeNowLineLeftPx(nowIso, timezone);
  }, [isViewingToday, nowIso, timezone]);

  const nowLineLabel = useMemo(() => labels.formatTimeLabel(nowIso), [labels, nowIso]);

  const slotUtcList = useMemo(
    () =>
      Array.from({ length: TOTAL_SLOTS }, (_, i) =>
        slotIndexToUtc(i, selectedDate, timezone),
      ),
    [selectedDate, timezone],
  );

  useEffect(() => {
    autoScrolledRef.current = false;
  }, [selectedDate]);

  useEffect(() => {
    if (!isViewingToday || autoScrolledRef.current) return;
    const el = scrollRef.current;
    const snapPx = computeNearestSlotCenterLeftPx(nowIso, timezone);
    if (snapPx === null || !el) return;
    autoScrolledRef.current = true;
    const w = el.clientWidth;
    const maxScroll = Math.max(0, el.scrollWidth - w);
    const target = Math.max(0, Math.min(snapPx - w / 2, maxScroll));
    el.scrollLeft = target;
  }, [isViewingToday, nowIso, timezone, selectedDate]);

  useEffect(() => {
    if (!isViewingToday) return;
    if (jumpToNowTrigger <= prevJumpTriggerRef.current) return;
    prevJumpTriggerRef.current = jumpToNowTrigger;
    const el = scrollRef.current;
    const snapPx = computeNearestSlotCenterLeftPx(nowIso, timezone);
    if (snapPx === null || !el) return;
    const w = el.clientWidth;
    const maxScroll = Math.max(0, el.scrollWidth - w);
    const target = Math.max(0, Math.min(snapPx - w / 2, maxScroll));
    el.scrollTo({ left: target, behavior: "smooth" });
  }, [jumpToNowTrigger, isViewingToday, nowIso, timezone]);

  const assignMode = assigning !== null;

  return (
    <div
      ref={scrollRef}
      data-testid="staff-timeline-grid"
      className={cn("h-full min-h-0 overflow-auto", assignMode && "cursor-copy")}
    >
      <div className="inline-flex min-w-max flex-row">
        <div
          className={cn(
            "sticky left-0 z-[15] flex shrink-0 flex-col border-r border-nq-muted/25 bg-nq-bg",
          )}
        >
          <div
            className="sticky top-0 z-[25] shrink-0 bg-nq-bg"
            style={{ width: STAFF_COL_WIDTH, height: TIME_HEADER_HEIGHT }}
            aria-hidden
          />

          {staff.map((s) => (
            <div
              key={s.id}
              className={cn(
                "flex shrink-0 items-center gap-2.5 border-b border-nq-muted/15 px-2",
              )}
              style={{ width: STAFF_COL_WIDTH, height: ROW_HEIGHT }}
            >
              {/*
               * Sanctioned `StaffAvatar` primitive (`src/components/ui/`).
               * Status dot replaces the previous custom busy-ring; the
               * `staff_performance` module gate now governs the workload
               * bar + skill row (and the role text below). The dot itself
               * stays visible regardless — basic availability signal is
               * core operational truth, not analytics chrome.
               */}
              <StaffAvatar
                name={s.name}
                status={s.status}
                workload={s.workload}
                showWorkload={showStaffPerformanceDetail}
                showStatus
                size="md"
                skills={s.skills}
                showSkills={
                  showStaffPerformanceDetail &&
                  showStaffSkillBadges &&
                  s.skills.length > 0
                }
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-nq-foreground">{s.name}</p>
                {showStaffPerformanceDetail ? (
                  <p className="truncate text-[11px] text-nq-muted">{s.job_role}</p>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col" style={{ width: timelineWidthPx }}>
          <div
            className={cn(
              "sticky top-0 z-12 flex shrink-0 bg-nq-bg/95 backdrop-blur-sm",
              // `relative` anchors the floating NOW-time bubble (below)
              // inside the time-header strip; combined with the strip's
              // existing `sticky top-0` this keeps the bubble visible
              // during VERTICAL scroll, while it scrolls horizontally
              // with the timeline (i.e. tied to the NOW position on
              // the time axis).
              "relative",
            )}
            style={{ height: TIME_HEADER_HEIGHT, width: timelineWidthPx }}
          >
            {slotUtcList.map((utc, i) => {
              const isHourMark = i % 2 === 0;
              return (
                <div
                  key={i}
                  className={cn(
                    "flex shrink-0 items-end justify-center border-l border-nq-muted/15 pb-1",
                    isHourMark ? "text-nq-foreground" : "text-nq-muted",
                  )}
                  style={{ width: SLOT_PX, height: TIME_HEADER_HEIGHT }}
                >
                  <span
                    className={cn(
                      "font-mono text-[10px] tabular-nums leading-none",
                      isHourMark ? "font-semibold" : "font-medium",
                    )}
                  >
                    {labels.formatTimeLabel(utc)}
                  </span>
                </div>
              );
            })}
            {/*
             * Floating NOW-time bubble. Sits at the top of the timeline
             * header strip, centered over the NowLine's `leftPx`. The
             * strip itself is `sticky top-0`, so the bubble stays
             * vertically visible during vertical scroll. Horizontally
             * it scrolls with the timeline (correctly tied to "now" on
             * the time axis — receptionist still has the "Jump to now"
             * pill in the header to pull it back into view).
             *
             * Color matches the NowLine (red `--color-nq-error`); the
             * pill carries the textual "now" label so the temporal
             * anchor is conveyed by both color AND text per
             * `COLOR_TOKENS.md §5` ("never rely on hue alone").
             *
             * Hidden when `nowLineLeftPx` is null (off-grid time, e.g.
             * before 8am or after 8pm) and on non-today views (existing
             * `isViewingToday` gate already nulls `nowLineLeftPx`).
             */}
            {nowLineLeftPx !== null ? (
              <div
                data-testid="now-line-bubble"
                className={cn(
                  "pointer-events-none absolute top-1 z-[13] -translate-x-1/2",
                  "rounded-full bg-nq-error px-2 py-0.5",
                  "text-[10px] font-semibold tabular-nums text-white shadow-nq-card",
                )}
                style={{ left: nowLineLeftPx }}
                aria-label={`Current time ${nowLineLabel}`}
              >
                {nowLineLabel}
              </div>
            ) : null}
          </div>

          <div
            className="relative"
            style={{ height: staff.length * ROW_HEIGHT, width: timelineWidthPx }}
          >
            {staff.map((s) => {
              const rowBookings = bookingsByStaff.get(s.id) ?? [];
              const showGhost =
                assignMode &&
                assigning !== null &&
                hoveredSlot !== null &&
                hoveredSlot.staffId === s.id;

              let ghostEl: ReactNode = null;
              if (showGhost && assigning !== null) {
                const slotIndex = hoveredSlot.slotIndex;
                const slotStartUtc = slotIndexToUtc(slotIndex, selectedDate, timezone);
                const spanMinutes = assigning.serviceDurationMinutes;
                const spanEndMs = Date.parse(slotStartUtc) + spanMinutes * 60_000;
                const spanEndIso = new Date(spanEndMs).toISOString();

                const overflowEndMinutesFrom8 =
                  slotIndex * SLOT_MINUTES + spanMinutes - TOTAL_SLOTS * SLOT_MINUTES;
                const overflow = overflowEndMinutesFrom8 > 0;

                const conflict = overflow
                  ? null
                  : checkBookingConflict({
                      staffId: s.id,
                      startUtcIso: slotStartUtc,
                      endUtcIso: spanEndIso,
                      existingBookings: conflictRows,
                    });

                const widthPx = (spanMinutes / SLOT_MINUTES) * SLOT_PX;
                const leftPx = slotIndex * SLOT_PX;

                let state: "ok" | "conflict" | "overflow" = "ok";
                let label = `${assigning.clientName} · ${assigning.serviceDurationMinutes}m`;

                if (overflow) {
                  state = "overflow";
                  label = labels.overflowMessage;
                } else if (conflict) {
                  state = "conflict";
                  label = labels.conflictWith(conflict.client_name);
                }

                ghostEl = (
                  <GhostBlock leftPx={leftPx} widthPx={widthPx} state={state} label={label} />
                );
              }

              return (
                <div
                  key={s.id}
                  className={cn(
                    "relative border-b border-nq-muted/15",
                    assignMode && "cursor-copy",
                  )}
                  style={{ height: ROW_HEIGHT, width: timelineWidthPx }}
                  onMouseLeave={() => setHoveredSlot(null)}
                >
                  <div className="pointer-events-none absolute inset-0 flex">
                    {Array.from({ length: TOTAL_SLOTS }, (_, i) => (
                      <div
                        key={i}
                        className={cn(
                          "h-full border-l",
                          showTimelineHeatmap
                            ? i % 2 === 0
                              ? "border-nq-muted/18"
                              : "border-nq-muted/8"
                            : i % 2 === 0
                              ? "border-nq-muted/10"
                              : "border-transparent",
                        )}
                        style={{ width: SLOT_PX, flexShrink: 0 }}
                      />
                    ))}
                  </div>

                  <div
                    className={cn(
                      "absolute inset-0 flex",
                      assignMode ? "z-[3]" : "z-[1]",
                    )}
                  >
                    {Array.from({ length: TOTAL_SLOTS }, (_, slotIndex) => (
                      <button
                        key={slotIndex}
                        type="button"
                        data-testid={`assign-slot-${s.id}-${slotIndex}`}
                        tabIndex={assignMode ? 0 : -1}
                        aria-hidden={!assignMode}
                        className={cn(
                          "h-full shrink-0 border-0 bg-transparent p-0 opacity-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-nq-primary/50",
                          assignMode && "cursor-copy",
                        )}
                        style={{ width: SLOT_PX }}
                        onMouseEnter={() =>
                          setHoveredSlot({ staffId: s.id, slotIndex })
                        }
                        onFocus={() => setHoveredSlot({ staffId: s.id, slotIndex })}
                        onClick={(e: MouseEvent) => {
                          if (!assignMode) return;
                          e.stopPropagation();
                          const utc = slotIndexToUtc(slotIndex, selectedDate, timezone);
                          onSlotClick(s.id, utc);
                        }}
                        onKeyDown={(e: KeyboardEvent) => {
                          if (!assignMode) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            const utc = slotIndexToUtc(slotIndex, selectedDate, timezone);
                            onSlotClick(s.id, utc);
                          }
                        }}
                      />
                    ))}
                  </div>

                  <div
                    className={cn(
                      "relative h-full",
                      assignMode ? "z-[2] pointer-events-none" : "z-[2]",
                    )}
                  >
                    {rowBookings.map((b) => {
                      const { leftPx, widthPx } = bookingToPosition(b, timezone);
                      // `late` per `STATE_MACHINE.md` §3+§5 is an overlay
                      // flag on `in_progress` whose end time has passed —
                      // not a status replacement. Computed client-side
                      // against `nowIso` so the indicator hydrates in
                      // sync with the NowLine + per-minute tick.
                      const endMs = Date.parse(b.end_time_utc);
                      const nowMs = Date.parse(nowIso);
                      const isLate =
                        b.status === "in_progress" &&
                        Number.isFinite(endMs) &&
                        Number.isFinite(nowMs) &&
                        endMs < nowMs;
                      return (
                        <BookingBlock
                          key={b.id}
                          bookingId={b.id}
                          clientName={b.client_name}
                          serviceName={b.service_name}
                          status={b.status}
                          source={b.source}
                          startTimeLabel={labels.formatTimeLabel(b.start_time_utc)}
                          endTimeLabel={labels.formatTimeLabel(b.end_time_utc)}
                          priceCents={b.price_cents}
                          leftPx={leftPx}
                          widthPx={widthPx}
                          onClick={() => onBookingClick(b.id)}
                          showPrice={showBookingPrices}
                          showMetaLine={showBookingMetaLine}
                          showWalkinAccent={showWalkinAccent}
                          minHeightPx={bookingBlockMinHeightPx}
                          isVip={b.is_vip}
                          hasNotes={b.has_notes}
                          hasDesign={b.has_design}
                          isLate={isLate}
                          iconLabels={labels.bookingIcon}
                        />
                      );
                    })}
                    {ghostEl}
                  </div>
                </div>
              );
            })}

            <div
              className="pointer-events-none absolute inset-0 z-[8]"
              aria-hidden
            >
              {/* Time bubble is rendered separately in the time-header strip
                  above so it stays vertically sticky during vertical scroll;
                  this NowLine renders only the vertical line itself. */}
              <NowLine leftPx={nowLineLeftPx} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
