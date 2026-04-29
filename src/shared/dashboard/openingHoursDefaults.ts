/** Matches Supabase default `salons.opening_hours` seed (UTC display labels computed in UI). */
export const DEFAULT_OPENING_HOURS_JSON =
  '{"mon":{"open":"09:00","close":"18:00","closed":false},"tue":{"open":"09:00","close":"18:00","closed":false},"wed":{"open":"09:00","close":"18:00","closed":false},"thu":{"open":"09:00","close":"18:00","closed":false},"fri":{"open":"09:00","close":"18:00","closed":false},"sat":{"open":"09:00","close":"18:00","closed":false},"sun":{"open":"09:00","close":"18:00","closed":true}}';

export type DayHours = { open: string; close: string; closed: boolean };

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export type OpeningHoursWeek = Record<DayKey, DayHours>;

function isDayHours(x: unknown): x is DayHours {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.open === "string" &&
    typeof o.close === "string" &&
    typeof o.closed === "boolean"
  );
}

export function parseOpeningHours(raw: unknown): OpeningHoursWeek | null {
  if (raw === null || raw === undefined) return null;
  const obj = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!obj || typeof obj !== "object") return null;
  const out = {} as Partial<OpeningHoursWeek>;
  for (const k of DAY_KEYS) {
    const v = (obj as Record<string, unknown>)[k];
    if (!isDayHours(v)) return null;
    out[k] = v;
  }
  return out as OpeningHoursWeek;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

export function stableOpeningHoursJson(h: OpeningHoursWeek): string {
  const o: Record<string, DayHours> = {};
  for (const k of DAY_KEYS) {
    o[k] = h[k];
  }
  return JSON.stringify(o);
}

const HM_RE = /^(\d{1,2}):(\d{2})$/;

/** Normalize HH:MM for storage against a fallback when client sends incomplete day rows. */
export function normalizeHmString(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const m = HM_RE.exec(raw.trim());
  if (!m) return fallback;
  let h = Number(m[1]);
  let min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return fallback;
  h = Math.min(23, Math.max(0, Math.floor(h)));
  min = Math.min(59, Math.max(0, Math.floor(min)));
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function coerceWeekDayHours(v: unknown, defaults: DayHours): DayHours {
  if (!v || typeof v !== "object") return defaults;
  const o = v as Record<string, unknown>;
  const closed =
    typeof o.closed === "boolean" ? o.closed : defaults.closed;
  const openSrc = typeof o.open === "string" ? o.open : defaults.open;
  const closeSrc = typeof o.close === "string" ? o.close : defaults.close;
  return {
    closed,
    open: normalizeHmString(openSrc, defaults.open),
    close: normalizeHmString(closeSrc, defaults.close),
  };
}

/**
 * Merge server-actions / client payloads into a complete week so partial JSON
 * (e.g. a single edited day after serialization) cannot throw or omit keys.
 */
export function mergeOpeningHoursFromClient(input: unknown): OpeningHoursWeek {
  const base = defaultOpeningHoursWeek();
  if (!input || typeof input !== "object") return base;
  const o = input as Record<string, unknown>;
  for (const k of DAY_KEYS) {
    base[k] = coerceWeekDayHours(o[k], base[k]);
  }
  return base;
}

/** True when saved JSON differs from platform default template (normalized). */
export function isOpeningHoursCustomized(raw: unknown): boolean {
  const parsed = parseOpeningHours(raw);
  if (!parsed) return false;
  return stableOpeningHoursJson(parsed) !== DEFAULT_OPENING_HOURS_JSON;
}

export function defaultOpeningHoursWeek(): OpeningHoursWeek {
  return parseOpeningHours(JSON.parse(DEFAULT_OPENING_HOURS_JSON))!;
}

/** Human preview for salon setup (locale-friendly times). */
export function compactOpeningHoursLabel(hours: OpeningHoursWeek): string {
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function fmtHm(hm: string) {
    const [a0, b0] = hm.split(":");
    const h = Number(a0);
    const m = Number(b0);
    const d = new Date(
      2000,
      0,
      1,
      Number.isFinite(h) ? h : 9,
      Number.isFinite(m) ? m : 0,
    );
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  let i = 0;
  const parts: string[] = [];
  while (i < 7) {
    const k = DAY_KEYS[i];
    const b = hours[k];
    if (b.closed) {
      let j = i + 1;
      while (j < 7 && hours[DAY_KEYS[j]].closed) j++;
      parts.push(
        j - i === 1
          ? `${labels[i]}: Closed`
          : `${labels[i]}–${labels[j - 1]}: Closed`,
      );
      i = j;
      continue;
    }
    let j = i + 1;
    while (
      j < 7 &&
      !hours[DAY_KEYS[j]].closed &&
      hours[DAY_KEYS[j]].open === b.open &&
      hours[DAY_KEYS[j]].close === b.close
    ) {
      j++;
    }
    const rng =
      j - i === 1 ? labels[i] : `${labels[i]}–${labels[j - 1]}`;
    parts.push(`${rng}: ${fmtHm(b.open)} – ${fmtHm(b.close)}`);
    i = j;
  }

  return parts.join(" · ");
}
