const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Maximum lateness from the nominal due instant, not from the window edge. */
export const REMINDER_RECOVERY_MINUTES = 60;

export function reminderRecoveryDeadline(startUtc: string, kind: "24h" | "3h"): string {
  return new Date(instantMs(startUtc) - (kind === "24h" ? 24 : 3) * HOUR_MS
    + REMINDER_RECOVERY_MINUTES * MINUTE_MS).toISOString();
}

export function reminderSendDeadlinePassed(deadline: string | undefined, now = Date.now()): boolean {
  return deadline !== undefined && (!Number.isFinite(Date.parse(deadline)) || now > Date.parse(deadline));
}

export function reminderRecoveryStart(now: Date | string | number, kind: "24h" | "3h"): string {
  return new Date(instantMs(now) + (kind === "24h" ? 24 : 3) * HOUR_MS
    - REMINDER_RECOVERY_MINUTES * MINUTE_MS).toISOString();
}

export function isReminderRecoveryDue(startUtc: string, kind: "24h" | "3h", now: Date | string | number): boolean {
  const start = Date.parse(startUtc);
  const current = instantMs(now);
  const late = current - (start - (kind === "24h" ? 24 : 3) * HOUR_MS);
  return Number.isFinite(start) && start > current && late > 15 * MINUTE_MS
    && late <= REMINDER_RECOVERY_MINUTES * MINUTE_MS;
}

export function formatReminderAppointmentLabel(startUtc: string, timezone: string, locale: "en" | "vi"): string {
  return new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", {
    timeZone: timezone, year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(instantMs(startUtc)));
}

export type ReminderDueWindows = {
  reminder24h: { startUtc: string; endUtc: string };
  reminder3h: { startUtc: string; endUtc: string };
};

function instantMs(value: Date | string | number): number {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("reminderSchedule: invalid instant");
  return ms;
}

/**
 * Absolute UTC due windows for a worker that runs every 15 minutes.
 *
 * Reminders mean 24 or 3 elapsed hours before the appointment, independent of
 * a salon's DST offset change. The ±15-minute overlap tolerates cron jitter;
 * durable sent markers own deduplication.
 */
export function reminderDueWindows(now: Date | string | number): ReminderDueWindows {
  const nowMs = instantMs(now);
  const window = (leadHours: number) => ({
    startUtc: new Date(nowMs + leadHours * HOUR_MS - 15 * MINUTE_MS).toISOString(),
    endUtc: new Date(nowMs + leadHours * HOUR_MS + 15 * MINUTE_MS).toISOString(),
  });
  return { reminder24h: window(24), reminder3h: window(3) };
}

/** Customer-facing local time with an offset-specific abbreviation. */
export function formatReminderTimeLabel(startUtc: string, timezone: string): string {
  const ms = Date.parse(startUtc);
  if (!Number.isFinite(ms)) throw new Error("reminderSchedule: invalid start instant");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date(ms));
}
