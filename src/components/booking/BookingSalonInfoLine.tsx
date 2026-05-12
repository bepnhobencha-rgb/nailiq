import { parseOpeningHours, type DayKey } from "@/shared/dashboard/openingHoursDefaults";
import { salonToday } from "@/shared/lib/salonTime";

type BookingSalonInfoLineProps = {
  address: string | null;
  openingHoursRaw: unknown | null;
  timezone: string;
  /** Render variant: "mobile" tunes spacing for the in-page mobile
   * hero; "desktop" tunes for the white-on-photo sidebar card. */
  variant: "mobile" | "desktop";
};

const DAY_KEY_BY_INDEX: readonly DayKey[] = [
  // JS getUTCDay(): 0 = Sun, 1 = Mon, ..., 6 = Sat
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

function todayDayKey(timezone: string): DayKey {
  // `salonToday()` returns `YYYY-MM-DD` in salon-local time. Treat that
  // calendar date as a UTC date so `getUTCDay()` returns the salon-local
  // weekday rather than the runtime's (which can drift by ±1 across
  // timezones).
  const ymd = salonToday(timezone);
  const [y, m, d] = ymd.split("-").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return "mon";
  }
  const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return DAY_KEY_BY_INDEX[idx] ?? "mon";
}

/** Convert "HH:MM" 24h to "h:mm AM/PM". */
function formatHm(hm: string): string {
  const [hStr, mStr] = hm.split(":");
  const h = Number.parseInt(hStr ?? "", 10);
  const m = Number.parseInt(mStr ?? "", 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hm;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = ((h + 11) % 12) + 1;
  const mm = String(m).padStart(2, "0");
  return `${hour12}:${mm} ${period}`;
}

function buildTodayHoursLine(
  openingHoursRaw: unknown | null,
  timezone: string,
): { label: string; isClosed: boolean } | null {
  const week = parseOpeningHours(openingHoursRaw);
  if (!week) return null;
  const day = week[todayDayKey(timezone)];
  if (!day) return null;
  if (day.closed) {
    return { label: "Đóng cửa hôm nay · Closed today", isClosed: true };
  }
  return {
    label: `Hôm nay · Today: ${formatHm(day.open)} – ${formatHm(day.close)}`,
    isClosed: false,
  };
}

/**
 * P0.7 — compact salon-info block rendered under the salon name on the
 * public booking page. Shows address + today's opening hours; hidden
 * entirely when both pieces of data are missing.
 *
 * Bilingual VI · EN inline labels because the booking flow itself is
 * currently English-only (see `bookingEn.ts` leading comment). A real
 * language toggle requires porting the full booking i18n bundle to VI
 * — flagged as follow-up; out of scope for this PR.
 */
export function BookingSalonInfoLine({
  address,
  openingHoursRaw,
  timezone,
  variant,
}: BookingSalonInfoLineProps) {
  const today = buildTodayHoursLine(openingHoursRaw, timezone);
  if (!address && !today) return null;

  // Both call-sites (mobile hero + desktop hero) render against a
  // dark/photo background, so white-tinted text is correct in both.
  const tone = "text-white/80";

  return (
    <div
      data-testid={`booking-salon-info-${variant}`}
      className={`mt-3 space-y-1 text-[13px] leading-snug ${tone}`}
    >
      {address ? (
        <p className="flex items-start gap-1.5">
          <span aria-hidden>📍</span>
          <span className="min-w-0 break-words">{address}</span>
        </p>
      ) : null}
      {today ? (
        <p className="flex items-start gap-1.5">
          <span aria-hidden>{today.isClosed ? "🚫" : "🕘"}</span>
          <span>{today.label}</span>
        </p>
      ) : null}
    </div>
  );
}
