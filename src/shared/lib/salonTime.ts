/**
 * Timezone-aware salon date/time helpers using `Intl` only (no date-fns-tz).
 */

function parseUtcMs(utcIso: string): number {
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) {
    throw new Error(`salonTime: invalid ISO string ${utcIso}`);
  }
  return ms;
}

function ymdInTimeZone(ms: number, timeZone: string): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addCalendarDaysToYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + days));
  const yy = x.getUTCFullYear();
  const mm = String(x.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(x.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** First UTC instant where the calendar date in `timeZone` equals `ymd` (local midnight). */
function firstInstantOfSalonCalendarDayUtc(ymd: string, timeZone: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  let lo = Date.UTC(y, m - 1, d - 1, 12, 0, 0);
  let hi = Date.UTC(y, m - 1, d + 1, 12, 0, 0);
  while (ymdInTimeZone(lo, timeZone) > ymd) lo -= 24 * 60 * 60 * 1000;
  while (ymdInTimeZone(hi, timeZone) < ymd) hi += 24 * 60 * 60 * 1000;

  let left = lo;
  let right = hi;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (ymdInTimeZone(mid, timeZone) < ymd) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  if (ymdInTimeZone(left, timeZone) !== ymd) {
    throw new Error(`salonTime: could not resolve ${ymd} in ${timeZone}`);
  }
  return left;
}

/**
 * Format UTC ISO string in salon's timezone.
 * Returns localized time string per format spec.
 */
export function formatInSalonTz(
  utcIso: string,
  timezone: string,
  format: "time" | "date" | "datetime" | "shortTime",
): string {
  const d = new Date(parseUtcMs(utcIso));

  if (format === "time") {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(d);
  }

  if (format === "shortTime") {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).formatToParts(d);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? "";
    const hour = get("hour");
    const minute = get("minute");
    const dayPeriod = get("dayPeriod");
    const suffix = dayPeriod ? dayPeriod.charAt(0).toLowerCase() : "";
    return `${hour}:${minute}${suffix}`;
  }

  const dateStr = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);

  if (format === "date") {
    return dateStr;
  }

  const timeStr = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);

  return `${dateStr} · ${timeStr}`;
}

/**
 * Get YYYY-MM-DD for "today" in the given salon timezone.
 */
export function salonToday(timezone: string, nowIso?: string): string {
  const ms = nowIso !== undefined ? parseUtcMs(nowIso) : Date.now();
  return ymdInTimeZone(ms, timezone);
}

/**
 * Get YYYY-MM-DD offset by N days from today in salon timezone.
 * Used for date switcher: yesterday/today/tomorrow.
 */
export function salonDateOffset(timezone: string, offsetDays: number, nowIso?: string): string {
  const base = salonToday(timezone, nowIso);
  return addCalendarDaysToYmd(base, offsetDays);
}

/**
 * Convert YYYY-MM-DD (in salon tz) → [startUtcIso, endUtcIso] for that day.
 * Day = midnight to midnight in salon timezone, expressed as UTC for DB queries.
 * End is exclusive (start of next local day), suitable for `>= start AND < end`.
 */
export function salonDayRangeUtc(
  dateYmd: string,
  timezone: string,
): { startUtc: string; endUtc: string } {
  const startMs = firstInstantOfSalonCalendarDayUtc(dateYmd, timezone);
  const nextYmd = addCalendarDaysToYmd(dateYmd, 1);
  const endMs = firstInstantOfSalonCalendarDayUtc(nextYmd, timezone);
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
  };
}

function salonMinutesFromMidnightAt(utcMs: number, timezone: string): number {
  const d = new Date(utcMs);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(d).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const h = Number(parts.hour);
  const m = Number(parts.minute);
  if (Number.isNaN(h) || Number.isNaN(m)) {
    throw new Error("salonMinutesFromMidnightAt: could not parse hour/minute");
  }
  return h * 60 + m;
}

/**
 * Minutes from local midnight in `timezone` for a UTC instant.
 */
export function utcIsoToSalonMinutesFromMidnight(utcIso: string, timezone: string): number {
  return salonMinutesFromMidnightAt(parseUtcMs(utcIso), timezone);
}

/**
 * UTC ISO for a wall-clock time on a salon calendar day (DST-safe via search).
 * `minutesFromMidnight` is e.g. `8 * 60 + 30` for 08:30.
 */
export function salonWallTimeToUtcIso(
  dateYmd: string,
  minutesFromMidnight: number,
  timezone: string,
): string {
  const dayStart = firstInstantOfSalonCalendarDayUtc(dateYmd, timezone);
  const nextStart = firstInstantOfSalonCalendarDayUtc(addCalendarDaysToYmd(dateYmd, 1), timezone);
  let lo = dayStart;
  let hi = nextStart - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ymd = ymdInTimeZone(mid, timezone);
    const mins = salonMinutesFromMidnightAt(mid, timezone);
    if (ymd < dateYmd || (ymd === dateYmd && mins < minutesFromMidnight)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return new Date(lo).toISOString();
}

/**
 * Get current minutes-from-midnight in salon timezone.
 * Used for "now line" position on grid.
 */
export function salonNowMinutes(timezone: string, nowIso?: string): number {
  const ms = nowIso !== undefined ? parseUtcMs(nowIso) : Date.now();
  return salonMinutesFromMidnightAt(ms, timezone);
}
