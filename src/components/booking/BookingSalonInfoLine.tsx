import { parseOpeningHours, type DayKey } from "@/shared/dashboard/openingHoursDefaults";
import { salonToday } from "@/shared/lib/salonTime";

/** P2.7 — display-time uppercase for postal codes / ZIPs.
 *
 * Canadian format: A1A 1A1 (sometimes typed without the space:
 * A1A1A1). US ZIP+4: 12345 or 12345-1234 — already uppercase. We
 * keep the transform narrow + idempotent so a correctly-cased
 * input is a no-op. */
function uppercasePostal(addr: string): string {
  return addr.replace(
    /\b([A-Za-z]\d[A-Za-z])\s*(\d[A-Za-z]\d)\b/g,
    (_match, a: string, b: string) => `${a.toUpperCase()} ${b.toUpperCase()}`,
  );
}

type BookingSalonInfoLineProps = {
  address: string | null;
  openingHoursRaw: unknown | null;
  timezone: string;
  /** Render variant: "mobile" tunes spacing for the in-page mobile
   * hero; "desktop" tunes for the white-on-photo sidebar card. */
  variant: "mobile" | "desktop";
  /** P2.2 — pick localized strings instead of rendering bilingual
   * "Hôm nay · Today" pairs. Booking page now has a real EN/VI
   * toggle, so the info line follows the active locale. */
  lang: "vi" | "en";
  /** P2.5 — localized aria labels for the decorative emojis. */
  addressAriaLabel?: string;
  hoursAriaLabel?: string;
};

const DAY_KEY_BY_INDEX: readonly DayKey[] = [
  "sun",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
];

function todayDayKey(timezone: string): DayKey {
  const ymd = salonToday(timezone);
  const [y, m, d] = ymd.split("-").map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return "mon";
  }
  const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return DAY_KEY_BY_INDEX[idx] ?? "mon";
}

/** Convert "HH:MM" 24h to a localized clock display.
 *  - EN: "9:00 AM / 6:00 PM"
 *  - VI: "9:00 SA / 6:00 CH"  (sáng / chiều) */
function formatHm(hm: string, lang: "vi" | "en"): string {
  const [hStr, mStr] = hm.split(":");
  const h = Number.parseInt(hStr ?? "", 10);
  const m = Number.parseInt(mStr ?? "", 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hm;
  const hour12 = ((h + 11) % 12) + 1;
  const mm = String(m).padStart(2, "0");
  const period =
    lang === "vi" ? (h >= 12 ? "CH" : "SA") : h >= 12 ? "PM" : "AM";
  return `${hour12}:${mm} ${period}`;
}

function buildTodayHoursLine(
  openingHoursRaw: unknown | null,
  timezone: string,
  lang: "vi" | "en",
): { label: string; isClosed: boolean } | null {
  const week = parseOpeningHours(openingHoursRaw);
  if (!week) return null;
  const day = week[todayDayKey(timezone)];
  if (!day) return null;
  if (day.closed) {
    return {
      label: lang === "vi" ? "Đóng cửa hôm nay" : "Closed today",
      isClosed: true,
    };
  }
  const prefix = lang === "vi" ? "Hôm nay" : "Today";
  return {
    label: `${prefix}: ${formatHm(day.open, lang)} – ${formatHm(day.close, lang)}`,
    isClosed: false,
  };
}

/**
 * P0.7 — compact salon-info block rendered under the salon name on the
 * public booking page. Shows address + today's opening hours; hidden
 * entirely when both pieces of data are missing.
 *
 * P2.2 — copy follows the active booking locale (no more bilingual
 * "Hôm nay · Today" pairs).
 */
export function BookingSalonInfoLine({
  address,
  openingHoursRaw,
  timezone,
  variant,
  lang,
  addressAriaLabel,
  hoursAriaLabel,
}: BookingSalonInfoLineProps) {
  const today = buildTodayHoursLine(openingHoursRaw, timezone, lang);
  if (!address && !today) return null;

  const tone = "text-white/80";

  return (
    <div
      data-testid={`booking-salon-info-${variant}`}
      className={`mt-3 space-y-1 text-[13px] leading-snug ${tone}`}
    >
      {address ? (
        <p className="flex items-start gap-1.5">
          {/* P2.5 — emojis carry an aria label so screen readers
              read "Address: 9718 156 ST…" instead of nothing. */}
          <span role="img" aria-label={addressAriaLabel ?? (lang === "vi" ? "Địa chỉ" : "Address")}>
            📍
          </span>
          <span className="min-w-0 break-words">{uppercasePostal(address)}</span>
        </p>
      ) : null}
      {today ? (
        <p className="flex items-start gap-1.5">
          <span
            role="img"
            aria-label={
              hoursAriaLabel ?? (lang === "vi" ? "Giờ mở cửa" : "Opening hours")
            }
          >
            {today.isClosed ? "🚫" : "🕘"}
          </span>
          <span>{today.label}</span>
        </p>
      ) : null}
    </div>
  );
}
