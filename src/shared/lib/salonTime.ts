/**
 * Timezone-aware salon date/time helpers using `Intl` only (no date-fns-tz).
 *
 * ## DST handling (Task #04-D FIX 05)
 *
 * `Intl.DateTimeFormat` resolves UTC instants into wall-clock parts for the
 * given IANA zone, so DST shifts are baked into every conversion below. There
 * is no extra `isDst()` branch: `salonWallTimeToUtcIso` samples the nearby UTC
 * offsets and accepts only candidates that round-trip to the requested wall
 * time.
 *
 * Edge cases handled by the wall-time resolver:
 *
 * 1. **Spring-forward** (e.g. `America/Vancouver` 2026-03-08):
 *    local clocks jump 02:00 → 03:00. Wall-times in the skipped
 *    hour (02:00–02:59) **do not exist** in salon local time. These
 *    inputs fail closed instead of silently moving a booking to 03:00.
 *
 * 2. **Fall-back** (e.g. `America/Vancouver` 2026-11-01):
 *    local clocks repeat 02:00 → 01:00. The wall-time `01:30`
 *    happens twice. Both candidates round-trip, and the resolver chooses the
 *    earlier UTC instant — the PDT (pre-fall-back) occurrence — to keep the
 *    choice deterministic.
 *
 * 3. **Booking across a DST boundary**: durations are computed in
 *    UTC ms (see `submitGroupBooking.ts:354`,
 *    `submitPublicBooking.ts`), so a 60-min service starting at the first
 *    01:30 on a fall-back day ends at the second 01:30 when rendered locally.
 *
 * Dedicated Vitest coverage locks the Canada/DST boundaries. Booking
 * durations still use elapsed UTC milliseconds; only wall-time selection
 * needs ambiguity/non-existence handling here.
 */

function parseUtcMs(utcIso: string): number {
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) {
    throw new Error(`salonTime: invalid ISO string ${utcIso}`);
  }
  return ms;
}

type CalendarYmdParts = { year: number; month: number; day: number };

function utcDateFromCalendarParts(parts: CalendarYmdParts): Date {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return date;
}

function parseCalendarYmd(ymd: string): CalendarYmdParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) {
    throw new Error(`salonTime: invalid calendar date ${ymd}`);
  }
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const date = utcDateFromCalendarParts(parts);
  if (
    date.getUTCFullYear() !== parts.year ||
    date.getUTCMonth() !== parts.month - 1 ||
    date.getUTCDate() !== parts.day
  ) {
    throw new Error(`salonTime: invalid calendar date ${ymd}`);
  }
  return parts;
}

/**
 * Resolve the "now" instant for helpers that accept an OPTIONAL `nowIso`.
 *
 * An omitted value means "use the current time". A blank string is treated
 * identically: client components that SSR-render with an empty placeholder
 * (e.g. `useState<string>("")` to avoid a React #418 hydration mismatch on
 * `new Date()`) pass `""` during the server pass. Without this, every
 * `salonToday("", …)` / `salonNowMinutes("", …)` call would throw
 * "invalid ISO string" and crash SSR (React #419). A non-blank but
 * malformed value still throws — that's a real bug worth surfacing.
 */
function resolveNowMs(nowIso?: string): number {
  return nowIso != null && nowIso.trim() !== "" ? parseUtcMs(nowIso) : Date.now();
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
  const parts = parseCalendarYmd(ymd);
  const x = utcDateFromCalendarParts({ ...parts, day: parts.day + days });
  const yy = x.getUTCFullYear();
  const mm = String(x.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(x.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** First UTC instant where the calendar date in `timeZone` equals `ymd` (local midnight). */
function firstInstantOfSalonCalendarDayUtc(ymd: string, timeZone: string): number {
  const parts = parseCalendarYmd(ymd);
  const priorNoon = utcDateFromCalendarParts({ ...parts, day: parts.day - 1 });
  priorNoon.setUTCHours(12, 0, 0, 0);
  const followingNoon = utcDateFromCalendarParts({ ...parts, day: parts.day + 1 });
  followingNoon.setUTCHours(12, 0, 0, 0);
  let lo = priorNoon.getTime();
  let hi = followingNoon.getTime();
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
  // Blank/empty input is the SSR-placeholder case: client components render
  // with an empty time string (e.g. `nowIso`/`lastSyncedIso` seeded as "" to
  // avoid a React #418 hydration mismatch on `new Date()`), and that same ""
  // flows through this formatter during the server pass and the first client
  // render. A display formatter MUST degrade to an empty label here rather
  // than throw — a single unguarded call site otherwise crashes the entire
  // receptionist surface (React #419). The empty SSR label matches the empty
  // first-client-render label, so hydration stays consistent; the real time
  // appears once the client effect populates it. A NON-blank but malformed
  // value still throws via parseUtcMs below — that's a genuine data bug worth
  // surfacing, not the benign placeholder case.
  if (utcIso == null || utcIso.trim() === "") return "";
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
  return ymdInTimeZone(resolveNowMs(nowIso), timezone);
}

/**
 * YYYY-MM-DD (in salon timezone) for an arbitrary UTC instant.
 * Used by the desk's optimistic insert to decide whether a freshly-created
 * booking belongs to the day the receptionist is currently viewing.
 */
export function salonYmdOfUtc(utcIso: string, timezone: string): string {
  return ymdInTimeZone(parseUtcMs(utcIso), timezone);
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

type SalonWallParts = CalendarYmdParts & {
  hour: number;
  minute: number;
  second: number;
};

const wallPartsFormatters = new Map<string, Intl.DateTimeFormat>();
const wallOffsetCandidates = new Map<string, readonly number[]>();
const MAX_WALL_OFFSET_CACHE_ENTRIES = 2_048;

function salonWallPartsAt(utcMs: number, timezone: string): SalonWallParts {
  let formatter = wallPartsFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    wallPartsFormatters.set(timezone, formatter);
  }
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  const result = {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
  if (Object.values(result).some((value) => !Number.isFinite(value))) {
    throw new Error(`salonTime: could not resolve wall time in ${timezone}`);
  }
  return result;
}

function timezoneOffsetMsAt(utcMs: number, timezone: string): number {
  const wholeSecondUtcMs = Math.floor(utcMs / 1000) * 1000;
  const wall = salonWallPartsAt(wholeSecondUtcMs, timezone);
  const wallAsUtc = utcDateFromCalendarParts(wall);
  wallAsUtc.setUTCHours(wall.hour, wall.minute, wall.second, 0);
  return wallAsUtc.getTime() - wholeSecondUtcMs;
}

function timezoneOffsetsNearWallDate(
  dateYmd: string,
  naiveWallUtcMs: number,
  timezone: string,
): readonly number[] {
  const cacheKey = `${timezone}|${dateYmd}`;
  const cached = wallOffsetCandidates.get(cacheKey);
  if (cached) return cached;

  const offsets = new Set<number>();
  const sampleRadiusMs = 48 * 60 * 60 * 1000;
  const sampleStepMs = 6 * 60 * 60 * 1000;
  for (
    let sampleMs = naiveWallUtcMs - sampleRadiusMs;
    sampleMs <= naiveWallUtcMs + sampleRadiusMs;
    sampleMs += sampleStepMs
  ) {
    offsets.add(timezoneOffsetMsAt(sampleMs, timezone));
  }
  const result = Array.from(offsets);
  if (wallOffsetCandidates.size >= MAX_WALL_OFFSET_CACHE_ENTRIES) {
    const oldest = wallOffsetCandidates.keys().next().value;
    if (oldest !== undefined) wallOffsetCandidates.delete(oldest);
  }
  wallOffsetCandidates.set(cacheKey, result);
  return result;
}

/**
 * Minutes from local midnight in `timezone` for a UTC instant.
 */
export function utcIsoToSalonMinutesFromMidnight(utcIso: string, timezone: string): number {
  return salonMinutesFromMidnightAt(parseUtcMs(utcIso), timezone);
}

/**
 * UTC ISO for a wall-clock time on a salon calendar day (DST-safe round trip).
 * `minutesFromMidnight` is e.g. `8 * 60 + 30` for 08:30.
 */
export function salonWallTimeToUtcIso(
  dateYmd: string,
  minutesFromMidnight: number,
  timezone: string,
): string {
  const date = parseCalendarYmd(dateYmd);
  if (
    !Number.isInteger(minutesFromMidnight) ||
    minutesFromMidnight < 0 ||
    minutesFromMidnight >= 24 * 60
  ) {
    throw new Error(`salonTime: invalid minutes from midnight ${minutesFromMidnight}`);
  }

  const hour = Math.floor(minutesFromMidnight / 60);
  const minute = minutesFromMidnight % 60;
  const naiveWallDate = utcDateFromCalendarParts(date);
  naiveWallDate.setUTCHours(hour, minute, 0, 0);
  const naiveWallUtcMs = naiveWallDate.getTime();

  // A UTC offset can change inside the requested salon day. Sample both sides
  // of the wall date, then validate every resulting candidate by rendering it
  // back through Intl. A repeated wall time yields two candidates; sorting
  // chooses the first occurrence. A skipped wall time yields none and fails
  // closed instead of silently moving the appointment.
  const matches = timezoneOffsetsNearWallDate(
    dateYmd,
    naiveWallUtcMs,
    timezone,
  )
    .map((offsetMs) => naiveWallUtcMs - offsetMs)
    .filter((candidateMs) => {
      const wall = salonWallPartsAt(candidateMs, timezone);
      return (
        wall.year === date.year &&
        wall.month === date.month &&
        wall.day === date.day &&
        wall.hour === hour &&
        wall.minute === minute &&
        wall.second === 0
      );
    })
    .sort((a, b) => a - b);

  if (matches.length === 0) {
    throw new Error(
      `salonTime: ${dateYmd} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} does not exist in ${timezone}`,
    );
  }
  return new Date(matches[0]).toISOString();
}

/**
 * Get current minutes-from-midnight in salon timezone.
 * Used for "now line" position on grid.
 */
export function salonNowMinutes(timezone: string, nowIso?: string): number {
  return salonMinutesFromMidnightAt(resolveNowMs(nowIso), timezone);
}

/**
 * Short timezone-name token for `timezone` at the given instant
 * (defaults to "now"). Anchored so DST returns the correct variant —
 * e.g. "PDT" in summer vs "PST" in winter for `America/Los_Angeles`.
 *
 * Falls back to a `GMT±N` form for non-Anglophone zones (e.g.
 * `Asia/Ho_Chi_Minh` → "GMT+7"). Returns `""` if the runtime can't
 * resolve a zone label at all (treat empty as "no abbreviation").
 */
export function salonTimezoneAbbreviation(
  timezone: string,
  atIso?: string,
): string {
  try {
    const ms = atIso !== undefined ? parseUtcMs(atIso) : Date.now();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(new Date(ms));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}
