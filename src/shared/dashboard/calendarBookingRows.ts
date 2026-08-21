import { salonYmdOfUtc } from "@/shared/lib/salonTime";
import type { BookingStatus } from "@/shared/types";

export const CALENDAR_STATUSES = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
] as const;

export type CalendarBooking = {
  calendar_entry_id: string;
  booking_id: string;
  id: string;
  client_name: string;
  service_name: string;
  start_time_utc: string;
  end_time_utc: string;
  occupied_start_time_utc: string;
  occupied_end_time_utc: string;
  prep_minutes: number;
  staff_id: string | null;
  resource_id: string | null;
  schedule_model: "single" | "segments_v1";
  segment_id: string | null;
  position: number | null;
  status: Extract<BookingStatus, "pending" | "confirmed" | "in_progress" | "completed">;
};

export type SequenceCalendarRow = {
  id: string;
  booking_id: string;
  position: number;
  staff_id: string;
  resource_id: string | null;
  service_name: string;
  customer_start_utc: string;
  customer_end_utc: string;
  occupied_start_utc: string;
  occupied_end_utc: string;
  prep_minutes: number;
  reservation_status: CalendarBooking["status"];
  booking:
    | { client_name?: string | null; status?: string | null; schedule_model?: string | null }
    | Array<{ client_name?: string | null; status?: string | null; schedule_model?: string | null }>
    | null;
};

/** Calendar entries may be segment identities; navigation always targets the parent. */
export function calendarBookingTargetId(booking: CalendarBooking): string {
  return booking.booking_id;
}

export function groupCalendarRowsByDay(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  singleRows: Array<Record<string, any>>,
  segmentRows: SequenceCalendarRow[],
  timezone: string,
): { ok: true; days: Record<string, CalendarBooking[]>; timezone: string } {
  const days: Record<string, CalendarBooking[]> = {};
  for (const row of singleRows) {
    if (row.schedule_model != null && row.schedule_model !== "single") continue;
    const st = row.start_time_utc as string | null | undefined;
    if (!st) continue;
    const ymd = salonYmdOfUtc(st, timezone);
    if (!ymd) continue;
    const svcRaw = row.services as { name?: string } | { name?: string }[] | null;
    const serviceName = (Array.isArray(svcRaw) ? svcRaw[0]?.name : svcRaw?.name)?.trim() ?? "";
    (days[ymd] ??= []).push({
      calendar_entry_id: String(row.id),
      booking_id: String(row.id),
      id: row.id,
      client_name: String(row.client_name ?? "").trim(),
      service_name: serviceName,
      start_time_utc: st,
      end_time_utc: String(row.end_time_utc ?? ""),
      occupied_start_time_utc: st,
      occupied_end_time_utc: String(row.end_time_utc ?? ""),
      prep_minutes: 0,
      staff_id: typeof row.staff_id === "string" ? row.staff_id : null,
      resource_id: typeof row.resource_id === "string" ? row.resource_id : null,
      schedule_model: "single",
      segment_id: null,
      position: null,
      status: row.status as CalendarBooking["status"],
    });
  }

  for (const row of segmentRows) {
    const parent = Array.isArray(row.booking) ? row.booking[0] : row.booking;
    if (!parent || parent.schedule_model !== "segments_v1") continue;
    const ymd = salonYmdOfUtc(row.customer_start_utc, timezone);
    if (!ymd) continue;
    const status = parent.status as CalendarBooking["status"];
    if (!CALENDAR_STATUSES.includes(status)) continue;
    (days[ymd] ??= []).push({
      calendar_entry_id: row.id,
      booking_id: row.booking_id,
      id: row.booking_id,
      client_name: String(parent.client_name ?? "").trim(),
      service_name: String(row.service_name ?? "").trim(),
      start_time_utc: row.customer_start_utc,
      end_time_utc: row.customer_end_utc,
      occupied_start_time_utc: row.occupied_start_utc,
      occupied_end_time_utc: row.occupied_end_utc,
      prep_minutes: row.prep_minutes,
      staff_id: row.staff_id,
      resource_id: row.resource_id,
      schedule_model: "segments_v1",
      segment_id: row.id,
      position: row.position,
      status,
    });
  }
  for (const rows of Object.values(days)) {
    rows.sort((a, b) => Date.parse(a.start_time_utc) - Date.parse(b.start_time_utc));
  }
  return { ok: true, days, timezone };
}
