import { salonToday } from "@/shared/lib/salonTime";

/**
 * Calendar-only Date whose browser-local Y/M/D components equal the salon's
 * current calendar date. The instant is intentionally noon in the browser:
 * callers use this only with getFullYear/getMonth/getDate, never as a booking
 * instant. This prevents a UTC/customer-timezone midnight from moving the
 * public date window one day ahead of or behind the salon.
 */
export function salonTodayCalendarDate(
  timezone: string,
  nowIso?: string,
): Date {
  const ymd = salonToday(timezone, nowIso);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) throw new Error("salon_calendar_date_invalid");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (
    result.getFullYear() !== year || result.getMonth() !== month - 1 ||
    result.getDate() !== day
  ) throw new Error("salon_calendar_date_invalid");
  return result;
}
