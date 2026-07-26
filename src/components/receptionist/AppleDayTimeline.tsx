"use client";

import { useEffect, useMemo, useRef, type MouseEvent } from "react";

import type {
  GridBooking,
  GridStaff,
} from "@/components/receptionist/StaffTimelineGrid";
import { displayCustomerName } from "@/shared/lib/customerDisplayName";
import {
  salonNowMinutes,
  salonWallTimeToUtcIso,
  utcIsoToSalonMinutesFromMidnight,
} from "@/shared/lib/salonTime";
import { minutesToLabel } from "@/shared/booking/getAvailableTimeSlots";
import { cn } from "@/shared/lib/cn";

const SLOT_MINUTES = 30;
// The approved reference keeps the full 9–7 workday visible in one desktop
// viewport. Thirty-two pixels per half-hour avoids the oversized,
// scroll-heavy Classic density; mobile keeps its separate touch-first view.
const SLOT_HEIGHT = 32;
const DEFAULT_OPEN_MINUTES = 9 * 60;
const DEFAULT_CLOSE_MINUTES = 19 * 60;
const STAFF_COLUMN_WIDTH = 178;
const TIME_RAIL_WIDTH = 72;

type AppleDayTimelineProps = {
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
  isViewingToday: boolean;
  openMinutes: number | null;
  closeMinutes: number | null;
  jumpToNowTrigger: number;
  language: "en" | "vi";
  onBookingClick: (bookingId: string) => void;
  onSlotClick: (staffId: string, slotStartUtc: string) => void;
  onEmptySlotClick: (
    staffId: string,
    ymd: string,
    timeLabel: string,
    anchor?: { x: number; y: number },
  ) => void;
};

function staffInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "—";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function statusLabel(
  status: GridBooking["status"],
  language: "en" | "vi",
): string {
  const labels = {
    pending: language === "vi" ? "Chờ xác nhận" : "Pending",
    confirmed: language === "vi" ? "Đã xác nhận" : "Confirmed",
    in_progress: language === "vi" ? "Đang làm" : "In service",
    completed: language === "vi" ? "Hoàn thành" : "Completed",
  } satisfies Record<GridBooking["status"], string>;
  return labels[status];
}

function bookingTone(booking: GridBooking): string {
  if (booking.status === "in_progress") return "rc-new-booking--green";
  if (booking.status === "completed") return "rc-new-booking--neutral";
  if (booking.status === "pending") return "rc-new-booking--amber";

  const tones = [
    "rc-new-booking--blue",
    "rc-new-booking--purple",
    "rc-new-booking--pink",
    "rc-new-booking--green",
  ];
  let checksum = 0;
  for (const char of booking.id) checksum += char.charCodeAt(0);
  return tones[checksum % tones.length] ?? tones[0];
}

export function AppleDayTimeline({
  staff,
  bookings,
  assigning,
  selectedDate,
  timezone,
  nowIso,
  isViewingToday,
  openMinutes,
  closeMinutes,
  jumpToNowTrigger,
  language,
  onBookingClick,
  onSlotClick,
  onEmptySlotClick,
}: AppleDayTimelineProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const startMinutes = openMinutes ?? DEFAULT_OPEN_MINUTES;
  const endMinutes = Math.max(
    closeMinutes ?? DEFAULT_CLOSE_MINUTES,
    startMinutes + SLOT_MINUTES,
  );
  const slotCount = Math.ceil((endMinutes - startMinutes) / SLOT_MINUTES);
  const bodyHeight = slotCount * SLOT_HEIGHT;
  const gridWidth =
    TIME_RAIL_WIDTH + Math.max(1, staff.length) * STAFF_COLUMN_WIDTH;
  const nowMinutes = nowIso ? salonNowMinutes(timezone, nowIso) : null;
  const nowTop =
    nowMinutes !== null &&
    nowMinutes >= startMinutes &&
    nowMinutes <= endMinutes
      ? ((nowMinutes - startMinutes) / SLOT_MINUTES) * SLOT_HEIGHT
      : null;

  const bookingsByStaff = useMemo(() => {
    const map = new Map<string, GridBooking[]>();
    for (const person of staff) map.set(person.id, []);
    for (const booking of bookings) {
      const rows = map.get(booking.staff_id);
      if (rows) rows.push(booking);
    }
    return map;
  }, [bookings, staff]);

  useEffect(() => {
    if (!jumpToNowTrigger || nowTop === null || !scrollerRef.current) return;
    scrollerRef.current.scrollTo({
      top: Math.max(0, nowTop - scrollerRef.current.clientHeight / 3),
      behavior: "smooth",
    });
  }, [jumpToNowTrigger, nowTop]);

  function activateSlot(
    event: MouseEvent<HTMLButtonElement>,
    staffId: string,
    minutes: number,
  ) {
    const slotStartUtc = salonWallTimeToUtcIso(
      selectedDate,
      minutes,
      timezone,
    );
    if (assigning) {
      onSlotClick(staffId, slotStartUtc);
      return;
    }
    onEmptySlotClick(staffId, selectedDate, minutesToLabel(minutes), {
      x: event.clientX,
      y: event.clientY,
    });
  }

  return (
    <div
      ref={scrollerRef}
      className="rc-new-timeline min-h-0 flex-1 overflow-auto"
      data-testid="preview-apple-timeline"
    >
      <div
        className="relative"
        style={{ minWidth: gridWidth, width: "100%" }}
      >
        <div
          className="sticky top-0 z-20 grid border-b border-[var(--rc-new-border)] bg-[var(--rc-new-surface)]"
          style={{
            gridTemplateColumns: `${TIME_RAIL_WIDTH}px repeat(${Math.max(1, staff.length)}, minmax(${STAFF_COLUMN_WIDTH}px, 1fr))`,
          }}
        >
          <div className="flex min-h-16 items-center px-4 text-xs font-medium text-[var(--rc-new-muted)]">
            {language === "vi" ? "Giờ" : "Time"}
          </div>
          {staff.length === 0 ? (
            <div className="flex min-h-16 items-center border-l border-[var(--rc-new-border)] px-4 text-sm text-[var(--rc-new-muted)]">
              {language === "vi" ? "Chưa có nhân viên" : "No staff"}
            </div>
          ) : (
            staff.map((person) => (
              <div
                key={person.id}
                className="flex min-h-16 items-center gap-3 border-l border-[var(--rc-new-border)] px-3"
              >
                <span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--rc-new-surface-subtle)] text-xs font-semibold text-[var(--rc-new-text)]">
                  {staffInitials(person.name)}
                  <span
                    className={cn(
                      "absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-[var(--rc-new-surface)]",
                      person.status === "available"
                        ? "bg-nq-success"
                        : person.status === "offline"
                          ? "bg-[var(--rc-new-muted)]"
                          : "bg-nq-warning",
                    )}
                    aria-hidden
                  />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-[var(--rc-new-text)]">
                    {person.name}
                  </span>
                  <span
                    className={cn(
                      "block truncate text-xs",
                      person.status === "available"
                        ? "text-nq-success"
                        : "text-[var(--rc-new-muted)]",
                    )}
                  >
                    {person.status === "available"
                      ? language === "vi"
                        ? "Sẵn sàng"
                        : "Available"
                      : person.status === "offline"
                        ? language === "vi"
                          ? "Ngoại tuyến"
                          : "Offline"
                        : language === "vi"
                          ? "Đang bận"
                          : "Busy"}
                  </span>
                </span>
              </div>
            ))
          )}
        </div>

        <div
          className="relative grid"
          style={{
            height: bodyHeight,
            gridTemplateColumns: `${TIME_RAIL_WIDTH}px repeat(${Math.max(1, staff.length)}, minmax(${STAFF_COLUMN_WIDTH}px, 1fr))`,
          }}
        >
          <div className="relative bg-[var(--rc-new-surface)]">
            {Array.from({ length: slotCount + 1 }, (_, index) => {
              const minutes = startMinutes + index * SLOT_MINUTES;
              const isHour = minutes % 60 === 0;
              return (
                <span
                  key={minutes}
                  className={cn(
                    "absolute right-3 -translate-y-1/2 text-[11px] font-medium",
                    isHour
                      ? "text-[var(--rc-new-text)]"
                      : "text-[var(--rc-new-muted)]",
                  )}
                  style={{ top: index * SLOT_HEIGHT }}
                >
                  {minutesToLabel(minutes).replace(":00 ", " ")}
                </span>
              );
            })}
          </div>

          {staff.length === 0 ? (
            <div className="border-l border-[var(--rc-new-border)] bg-[var(--rc-new-surface)]" />
          ) : (
            staff.map((person) => (
              <div
                key={person.id}
                className="relative border-l border-[var(--rc-new-border)] bg-[var(--rc-new-surface)]"
              >
                {Array.from({ length: slotCount }, (_, index) => {
                  const minutes = startMinutes + index * SLOT_MINUTES;
                  return (
                    <button
                      key={minutes}
                      type="button"
                      data-testid={`preview-slot-${person.id}-${minutes}`}
                      aria-label={`${person.name}, ${minutesToLabel(minutes)}`}
                      onClick={(event) =>
                        activateSlot(event, person.id, minutes)
                      }
                      className={cn(
                        "absolute inset-x-0 border-t text-left outline-none",
                        index % 2 === 0
                          ? "border-[var(--rc-new-border)]"
                          : "border-[var(--rc-new-border-subtle)]",
                        assigning
                          ? "cursor-pointer bg-nq-info/[0.03] hover:bg-nq-info/[0.09] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nq-info"
                          : "hover:bg-[var(--rc-new-surface-subtle)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nq-info",
                      )}
                      style={{
                        top: index * SLOT_HEIGHT,
                        height: SLOT_HEIGHT,
                      }}
                    />
                  );
                })}

                {(bookingsByStaff.get(person.id) ?? []).map((booking) => {
                  const start = utcIsoToSalonMinutesFromMidnight(
                    booking.start_time_utc,
                    timezone,
                  );
                  const end = utcIsoToSalonMinutesFromMidnight(
                    booking.end_time_utc,
                    timezone,
                  );
                  const top =
                    ((Math.max(start, startMinutes) - startMinutes) /
                      SLOT_MINUTES) *
                    SLOT_HEIGHT;
                  const height = Math.max(
                    28,
                    ((Math.min(end, endMinutes) - Math.max(start, startMinutes)) /
                      SLOT_MINUTES) *
                      SLOT_HEIGHT -
                      6,
                  );
                  if (end <= startMinutes || start >= endMinutes) return null;

                  return (
                    <button
                      key={booking.id}
                      type="button"
                      data-testid={`booking-block-${booking.id}`}
                      data-booking-source={booking.source}
                      onClick={() => onBookingClick(booking.id)}
                      className={cn(
                        "rc-new-booking absolute inset-x-2 z-10 overflow-hidden rounded-md border px-2.5 py-1.5 text-left shadow-sm outline-none",
                        "hover:-translate-y-px hover:shadow-md focus-visible:ring-2 focus-visible:ring-nq-info focus-visible:ring-offset-1",
                        bookingTone(booking),
                      )}
                      style={{ top, height }}
                    >
                      <span className="block truncate text-[10px] font-medium leading-tight opacity-75">
                        {minutesToLabel(start)} – {minutesToLabel(end)}
                      </span>
                      <span className="mt-0.5 block truncate text-sm font-semibold leading-tight">
                        {displayCustomerName(
                          booking.client_name,
                          language === "vi" ? "Khách đã xoá" : "Removed guest",
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] leading-tight opacity-70">
                        {booking.service_name}
                      </span>
                      <span className="sr-only">
                        {statusLabel(booking.status, language)}
                      </span>
                      <span
                        className="absolute right-2 bottom-2 h-1.5 w-1.5 rounded-full bg-current opacity-75"
                        aria-hidden
                      />
                    </button>
                  );
                })}
              </div>
            ))
          )}

          {isViewingToday && nowTop !== null ? (
            <div
              className="pointer-events-none absolute right-0 left-0 z-[15] flex items-center"
              style={{ top: nowTop }}
              data-testid="preview-now-line"
            >
              <span className="w-[72px] pr-3 text-right text-[10px] font-semibold text-nq-error">
                {minutesToLabel(nowMinutes ?? 0)}
              </span>
              <span className="h-2 w-2 -translate-x-1 rounded-full bg-nq-error" />
              <span className="-ml-1 h-px flex-1 bg-nq-error/70" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
