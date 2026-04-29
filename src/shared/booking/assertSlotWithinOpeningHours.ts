import type { OpeningHoursWeek } from "@/shared/dashboard/openingHoursDefaults";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";

/**
 * Server + client: booking block must fall entirely inside the salon day window.
 */
export function assertSlotWithinOpeningHours(
  week: OpeningHoursWeek,
  selectedDate: Date,
  startLocal: Date,
  endLocal: Date,
): void {
  const dayKey = dayKeyFromLocalDate(selectedDate);
  const cfg = week[dayKey];
  if (!cfg || cfg.closed) {
    throw new Error("salon_closed_day");
  }
  const openM = hmToMinutes(cfg.open);
  const closeM = hmToMinutes(cfg.close);
  if (closeM <= openM) {
    throw new Error("salon_hours_invalid");
  }

  const startM = startLocal.getHours() * 60 + startLocal.getMinutes();
  const endM = endLocal.getHours() * 60 + endLocal.getMinutes();

  if (startM < openM || endM > closeM) {
    throw new Error("outside_opening_hours");
  }
  if (endM <= startM) {
    throw new Error("outside_opening_hours");
  }
}
