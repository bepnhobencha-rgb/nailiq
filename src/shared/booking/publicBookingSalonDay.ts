import { salonDayRangeUtc, salonToday } from "@/shared/lib/salonTime";

export type PublicBookingSalonDay = {
  dateYmd: string;
  startUtc: string;
  endUtc: string;
  isPast: boolean;
};

/** Strict salon-calendar boundary shared by public quote/create checks. */
export function resolvePublicBookingSalonDay(
  dateYmd: string,
  timezone: string,
  nowIso?: string,
): PublicBookingSalonDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) return null;
  try {
    const range = salonDayRangeUtc(dateYmd, timezone);
    return {
      dateYmd,
      startUtc: range.startUtc,
      endUtc: range.endUtc,
      isPast: dateYmd < salonToday(timezone, nowIso),
    };
  } catch {
    return null;
  }
}
