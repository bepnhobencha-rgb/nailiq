/**
 * Timezone-aware salon date/time helpers using `Intl` only (no date-fns-tz).
 *
 * ## DST handling (Task #04-D FIX 05)
 *
 * `Intl.DateTimeFormat` resolves wall-clock time → UTC offset for the
 * given IANA zone *at the rendered instant*, so DST shifts are
 * already baked into every conversion below. There is no extra
 * `isDst()` branch anywhere in this file — the binary search in
 * `salonWallTimeToUtcIso` walks the candidate millisecond range and
 * trusts `Intl` to report the correct local time at each probe.
 *
 * Edge cases the search handles correctly today:
 *
 * 1. **Spring-forward** (e.g. `America/Vancouver` 2026-03-08):
 *    local clocks jump 02:00 → 03:00. Wall-times in the skipped
 *    hour (02:00–02:59) **do not exist** in salon local time. The
 *    binary search converges on the first millisecond at-or-after
 *    03:00 PST — i.e., asking for `minutesFromMidnight = 150`
 *    (02:30) returns an ISO that formats as 03:00 PDT. This is
 *    acceptable for our use because: (a) salons aren't open at
 *    02:30 anyway, (b) the slot generator only ever asks for
 *    minutes inside `opening_hours`, which never spans 02:00–03:00
 *    on a DST night for any real tenant.
 *
 * 2. **Fall-back** (e.g. `America/Vancouver` 2026-11-01):
 *    local clocks repeat 02:00 → 01:00. The wall-time `01:30`
 *    happens twice. The search converges on the **first** instant
 *    where local time ≥ 01:30 — that's the PDT (pre-fall-back)
 *    occurrence. Same justification: salons are closed at 01:30,
 *    so this ambiguity never reaches a booking.
 *
 * 3. **Booking across a DST boundary**: durations are computed in
 *    UTC ms (see `submitGroupBooking.ts:354`,
 *    `submitPublicBooking.ts`), so a 60-min service starting at
 *    01:30 PST on a fall-back day correctly ends at 02:30 PST
 *    (which is 01:30 PST a second time when rendered locally —
 *    again, never seen because salons are closed).
 *
 * **Why no unit tests yet:** the repo has no JS unit-test runner
 * (Playwright e2e only — see `CLAUDE.md` "Testing" section).
 * Adding one is out-of-scope for FIX 05; the cases above are
 * covered indirectly by the e2e flow which seeds bookings near
 * salon-open hours and never trips on the 02:00 boundary. A
 * follow-up task is spawned to add vitest + a dedicated
 * `salonTime.test.ts` that asserts the three scenarios above
 * against a fixed `America/Vancouver` calendar.
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
