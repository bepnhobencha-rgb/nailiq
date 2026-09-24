import type { UserLanguage } from "@/shared/i18n/user/types";

const dateFormatters = {
  en: new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeZone: "UTC" }),
  vi: new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeZone: "UTC" }),
};

/** A salon calendar date, not an instant. UTC preserves its day on every device. */
export function formatWaitlistDate(value: string, language: UserLanguage): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "—";
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return "—";
  return dateFormatters[language].format(date);
}

/** Presentation only: never changes the elapsed minutes used for queue urgency. */
export function waitlistDurationParts(value: number) {
  if (!Number.isFinite(value) || value < 0) return null;
  const totalMinutes = Math.floor(value);
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  };
}
