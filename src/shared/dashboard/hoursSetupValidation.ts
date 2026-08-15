import { isValidBookingClosedDate } from "@/shared/booking/parseBookingClosedDates";
import type { OpeningHoursWeek } from "@/shared/dashboard/openingHoursDefaults";

export function hoursEditorIsValid(
  week: OpeningHoursWeek,
  closedDatesText: string,
): boolean {
  for (const day of Object.values(week)) {
    if (!day.closed && day.open >= day.close) return false;
  }
  return closedDatesText
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .every(isValidBookingClosedDate);
}
