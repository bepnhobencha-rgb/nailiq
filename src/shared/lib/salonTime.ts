/**
 * Timezone-aware salon date/time helpers using `Intl` only (no date-fns-tz).
 *
 * ## DST handling (Task #04-D FIX 05)
 *
 * `Intl.DateTimeFormat` resolves UTC instants in the requested IANA zone, so
 * DST shifts are baked into every conversion below. Wall-clock → UTC is the
 * one direction that is not always one-to-one: a spring-forward minute may
 * not exist and a fall-back minute may occur twice. `resolveSalonWallTime`
 * enumerates the exact salon day once and reports those states explicitly.
 *
 * Edge cases handled explicitly:
 *
 * 1. **Spring-forward** (e.g. `America/Vancouver` 2026-03-08):
 *    local clocks jump 02:00 → 03:00. Wall-times in the skipped
 *    hour (02:00–02:59) **do not exist** in salon local time. The resolver
 *    returns `nonexistent`; the conversion helper throws instead of silently
 *    moving a booking to 03:00.
 *
 * 2. **Fall-back** (e.g. `America/Vancouver` 2026-11-01):
 *    local clocks repeat 02:00 → 01:00. The wall-time `01:30`
 *    happens twice. The resolver returns both UTC instants. Callers can choose
 *    `earlier`, `later`, or `reject`; the compatibility default is `earlier`.
 *
 * 3. **Booking across a DST boundary**: service durations remain absolute UTC
 *    durations. Calendar-day queries use exact salon midnights, yielding 23-
 *    and 25-hour half-open ranges where appropriate.
 */

function parseUtcMs(utcIso: string): number {
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) {
    throw new Error(`salonTime: invalid ISO string ${utcIso}`);
  }
  return ms;
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

export type SalonWallTimeResolution =
  | { kind: "exact"; candidatesUtc: [string] }
  | { kind: "ambiguous"; candidatesUtc: [string, string] }
  | { kind: "nonexistent"; candidatesUtc: [] };

export type SalonWallTimeDisambiguation = "earlier" | "later" | "reject";

const WALL_TIME_DAY_CACHE_LIMIT = 32;
const wallTimeDayCache = new Map<string, Map<number, number[]>>();

function salonWallMinuteIndex(dateYmd: string, timezone: string): Map<number, number[]> {
  const key = `${timezone}\u0000${dateYmd}`;
  const cached = wallTimeDayCache.get(key);
  if (cached) {
    // Refresh insertion order so the bounded map behaves as a tiny LRU.
    wallTimeDayCache.delete(key);
    wallTimeDayCache.set(key, cached);
    return cached;
  }

  const startMs = firstInstantOfSalonCalendarDayUtc(dateYmd, timezone);
  const endMs = firstInstantOfSalonCalendarDayUtc(
    addCalendarDaysToYmd(dateYmd, 1),
    timezone,
  );
  const index = new Map<number, number[]>();
  for (let instant = startMs; instant < endMs; instant += 60_000) {
    const minute = salonMinutesFromMidnightAt(instant, timezone);
    const candidates = index.get(minute);
    if (candidates) candidates.push(instant);
    else index.set(minute, [instant]);
  }

  wallTimeDayCache.set(key, index);
  while (wallTimeDayCache.size > WALL_TIME_DAY_CACHE_LIMIT) {
    const oldest = wallTimeDayCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    wallTimeDayCache.delete(oldest);
  }
  return index;
}

/**
 * Resolve an exact salon wall-clock minute without normalizing DST gaps.
 *
 * A normal minute has one candidate, a fall-back minute has two, and a
 * spring-forward gap has none. Results are sorted chronologically.
 */
export function resolveSalonWallTime(
  dateYmd: string,
  minutesFromMidnight: number,
  timezone: string,
): SalonWallTimeResolution {
  if (!Number.isInteger(minutesFromMidnight) || minutesFromMidnight < 0 || minutesFromMidnight >= 1440) {
    throw new Error("salonTime: minutesFromMidnight must be an integer from 0 to 1439");
  }
  const candidates = salonWallMinuteIndex(dateYmd, timezone).get(minutesFromMidnight) ?? [];
  const candidatesUtc = candidates.map((instant) => new Date(instant).toISOString());
  if (candidatesUtc.length === 0) return { kind: "nonexistent", candidatesUtc: [] };
  if (candidatesUtc.length === 1) {
    return { kind: "exact", candidatesUtc: [candidatesUtc[0]] };
  }
  if (candidatesUtc.length === 2) {
    return { kind: "ambiguous", candidatesUtc: [candidatesUtc[0], candidatesUtc[1]] };
  }
  throw new Error(`salonTime: unsupported wall-time multiplicity in ${timezone}`);
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
  disambiguation: SalonWallTimeDisambiguation = "earlier",
): string {
  const resolution = resolveSalonWallTime(dateYmd, minutesFromMidnight, timezone);
  if (resolution.kind === "nonexistent") {
    throw new Error(`salonTime: nonexistent wall time ${dateYmd} ${minutesFromMidnight} in ${timezone}`);
  }
  if (resolution.kind === "ambiguous") {
    if (disambiguation === "reject") {
      throw new Error(`salonTime: ambiguous wall time ${dateYmd} ${minutesFromMidnight} in ${timezone}`);
    }
    return disambiguation === "later"
      ? resolution.candidatesUtc[1]
      : resolution.candidatesUtc[0];
  }
  return resolution.candidatesUtc[0];
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
