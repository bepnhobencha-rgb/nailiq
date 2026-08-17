import { normalizeBookingClosedDateList } from "@/shared/booking/parseBookingClosedDates";
import { salonToday } from "@/shared/lib/salonTime";

/**
 * True when at least one entry in `booking_closed_dates` is today or later
 * in the salon's own timezone — i.e. there's a current/upcoming closure
 * worth telling a customer about. Self-expiring: once every listed date is
 * in the past, this flips false with no manual cleanup needed.
 */
export function hasUpcomingClosure(closedDatesRaw: unknown, timezone: string): boolean {
  const dates = normalizeBookingClosedDateList(closedDatesRaw);
  if (dates.length === 0) return false;
  const todayYmd = salonToday(timezone);
  return dates[dates.length - 1]! >= todayYmd;
}
