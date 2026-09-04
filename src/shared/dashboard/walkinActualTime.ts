import {
  resolveSalonWallTime,
  salonDateOffset,
  salonToday,
} from "@/shared/lib/salonTime";

export const WALKIN_ACTUAL_TIME_MAX_MINUTES = 30;
const WALKIN_ACTUAL_TIME_MAX_AGE_MS =
  WALKIN_ACTUAL_TIME_MAX_MINUTES * 60_000 + 59_999;
const WALKIN_ACTUAL_TIME_FUTURE_SKEW_MS = 5_000;

export type WalkinActualTimeError =
  | "invalid_actual_time"
  | "actual_time_too_old"
  | "actual_time_in_future";

export type WalkinActualTimeValidation =
  | { ok: true; actualTimeIso: string }
  | { ok: false; error: WalkinActualTimeError };

/**
 * Postgres may serialize the same timestamptz with `+00:00` while the browser
 * sends it with `Z`. Idempotency compares instants, not timestamp spelling.
 */
export function sameWalkinActualInstant(
  left: string | null | undefined,
  right: string,
): boolean {
  if (!left) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return (
    Number.isFinite(leftMs) &&
    Number.isFinite(rightMs) &&
    leftMs === rightMs
  );
}

/**
 * Server boundary for backdated walk-ins. The desk can correct an arrival time
 * only within the current 30-minute window and can never future-date it.
 * Minute-granularity input receives the remaining seconds of the oldest minute
 * as tolerance, so selecting 9:00 at 9:30:45 still means "30 minutes ago".
 */
export function validateWalkinActualTime(
  value: string,
  nowIso = new Date().toISOString(),
): WalkinActualTimeValidation {
  const actualMs = Date.parse(value);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(actualMs) || !Number.isFinite(nowMs)) {
    return { ok: false, error: "invalid_actual_time" };
  }
  if (actualMs > nowMs + WALKIN_ACTUAL_TIME_FUTURE_SKEW_MS) {
    return { ok: false, error: "actual_time_in_future" };
  }
  if (nowMs - actualMs > WALKIN_ACTUAL_TIME_MAX_AGE_MS) {
    return { ok: false, error: "actual_time_too_old" };
  }
  return { ok: true, actualTimeIso: new Date(actualMs).toISOString() };
}

function parseHm(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }
  return hours * 60 + minutes;
}

/**
 * Converts the receptionist's salon-wall-clock choice into the nearest safe
 * UTC instant. Today and yesterday are both considered so 11:55 PM entered at
 * 12:10 AM works without asking the receptionist to choose a date.
 */
export function resolveWalkinActualTime(
  timeHm: string,
  timezone: string,
  nowIso: string,
): WalkinActualTimeValidation {
  const minutes = parseHm(timeHm);
  const nowMs = Date.parse(nowIso);
  if (minutes === null || !timezone.trim() || !Number.isFinite(nowMs)) {
    return { ok: false, error: "invalid_actual_time" };
  }

  const today = salonToday(timezone, nowIso);
  const yesterday = salonDateOffset(
    timezone,
    -1,
    new Date(nowMs).toISOString(),
  );
  const candidates = [today, yesterday].flatMap((dateYmd) => {
    try {
      return resolveSalonWallTime(dateYmd, minutes, timezone).candidatesUtc;
    } catch {
      return [];
    }
  });

  const eligible = candidates
    .map((candidate) => ({ candidate, ms: Date.parse(candidate) }))
    .filter(({ ms }) => Number.isFinite(ms) && ms <= nowMs)
    .sort((a, b) => b.ms - a.ms);
  const nearest = eligible[0];
  if (!nearest) return { ok: false, error: "actual_time_in_future" };
  return validateWalkinActualTime(nearest.candidate, nowIso);
}

export function walkinActualTimeHm(
  timezone: string,
  nowIso: string,
): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowIso));
    const hour = parts.find((part) => part.type === "hour")?.value;
    const minute = parts.find((part) => part.type === "minute")?.value;
    return hour && minute ? `${hour}:${minute}` : "";
  } catch {
    return "";
  }
}
