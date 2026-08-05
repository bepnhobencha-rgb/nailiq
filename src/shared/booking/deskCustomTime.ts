import { minutesToLabel } from "@/shared/booking/getAvailableTimeSlots";

/** Convert the native time input's 24-hour value into NailIQ's booking label. */
export function deskCustomTimeLabel(value: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value).trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return minutesToLabel(hour * 60 + minute);
}
