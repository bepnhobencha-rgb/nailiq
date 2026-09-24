import { utcIsoToSalonMinutesFromMidnight } from "@/shared/lib/salonTime";

/** Calendar-only values (e.g. a voucher expiry date) must not shift a day. */
export function formatClientProfileDate(
  iso: string | null,
  lang: "en" | "vi",
  timezone: string,
  month: "numeric" | "short" = "numeric",
): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  if (!timezone) return "—";
  try {
    return new Intl.DateTimeFormat(lang === "vi" ? "vi-VN" : "en-US", {
      timeZone: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? "UTC" : timezone,
      day: "numeric", month, year: "numeric",
    }).format(new Date(ms));
  } catch {
    // Never substitute the viewer's zone when salon metadata is invalid.
    return "—";
  }
}

export function formatClientProfileDateShort(iso: string | null, lang: "en" | "vi", timezone: string): string {
  return formatClientProfileDate(iso, lang, timezone, "short");
}

/** Keep the drawer's existing 24-hour clock, using the authenticated salon. */
export function formatClientProfileTime(iso: string, timezone: string): string {
  if (!Number.isFinite(Date.parse(iso)) || !timezone) return "";
  try {
    const minutes = utcIsoToSalonMinutesFromMidnight(iso, timezone);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  } catch {
    return "";
  }
}
