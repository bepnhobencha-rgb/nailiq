import { getUserMessages } from "@/shared/i18n/user";
import type { LoadSalonDashboardResult } from "@/shared/dashboard/salonOwnerActions";
import {
  salonDayRangeUtc,
  salonToday,
  salonYmdOfUtc,
} from "@/shared/lib/salonTime";
import {
  OWNER_TODAY_LIST_STATUSES,
  type BookingStatus,
  type SalonDashboardBooking,
} from "@/shared/types";

const OWNER_TODAY_LIST_SET = new Set<BookingStatus>(OWNER_TODAY_LIST_STATUSES);

export type SalonDashboardStatsSlice = {
  totalToday: number;
  pending: number;
  confirmed: number;
  completed: number;
  revenueCents: number;
};

/** Server `allBookings` plus client-local day split (today / upcoming / stats). */
export type SalonOwnerDashboardViewPayload = Extract<
  LoadSalonDashboardResult,
  { ok: true }
> & {
  today: SalonDashboardBooking[];
  upcoming: SalonDashboardBooking[];
  stats: SalonDashboardStatsSlice;
};

export function nextBookingStatus(
  current: BookingStatus,
): BookingStatus | null {
  if (current === "pending") return "confirmed";
  if (current === "confirmed") return "completed";
  if (current === "in_progress") return "completed";
  return null;
}

export function salonBookingStatusLabel(
  s: BookingStatus,
  t: ReturnType<typeof getUserMessages>["salonDashboard"],
): string {
  if (s === "pending") return t.statusPending;
  if (s === "confirmed") return t.statusConfirmed;
  if (s === "completed") return t.statusCompleted;
  if (s === "in_progress") return t.statusInProgress;
  if (s === "waiting") return t.statusWaiting;
  if (s === "cancelled") return t.statusCancelled;
  return t.statusPending;
}

export function salonBookingStatusClass(s: BookingStatus): string {
  if (s === "pending") {
    return "border-nq-primary/35 bg-nq-primary/10 text-nq-primary ring-1 ring-nq-primary/25";
  }
  if (s === "confirmed") {
    return "border-nq-info/35 bg-nq-info/10 text-nq-info ring-1 ring-nq-info/25";
  }
  if (s === "completed") {
    return "border-nq-success/35 bg-nq-success/10 text-nq-success ring-1 ring-nq-success/25";
  }
  if (s === "in_progress") {
    return "border-nq-primary/45 bg-nq-primary/15 text-nq-primary ring-1 ring-nq-primary/30";
  }
  if (s === "waiting") {
    return "border-nq-border/50 bg-nq-surface/50 text-nq-muted ring-1 ring-nq-border/35";
  }
  if (s === "cancelled") {
    return "border-nq-border/40 bg-nq-surface/40 text-nq-muted line-through ring-1 ring-nq-border/25";
  }
  return "border-nq-border/35 bg-nq-surface/35 text-nq-muted ring-1 ring-nq-border/25";
}

export function formatSalonMoney(cents: number, lang: "en" | "vi"): string {
  const amount = cents / 100;
  return new Intl.NumberFormat(lang === "vi" ? "vi-VN" : "en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Split fetched bookings at midnight in the salon's configured timezone.
 * Explicit timezone boundaries keep SSR and hydration deterministic while
 * making "today" match the salon's operating day instead of UTC/viewer time. */
function safeSalonTimezone(timezone: string): string {
  const candidate = timezone.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
    return candidate;
  } catch {
    return "UTC";
  }
}

export function splitSalonDashboardBookings(
  allBookings: SalonDashboardBooking[],
  timezone: string,
  nowIso?: string,
): {
  today: SalonDashboardBooking[];
  upcoming: SalonDashboardBooking[];
  stats: SalonDashboardStatsSlice;
} {
  const tz = safeSalonTimezone(timezone);
  const todayYmd = salonToday(tz, nowIso);
  const { startUtc, endUtc } = salonDayRangeUtc(todayYmd, tz);
  const todayStartMs = Date.parse(startUtc);
  const todayEndExclusiveMs = Date.parse(endUtc);

  const todayInWindow = allBookings.filter((b) => {
    if (b.start_time_utc == null) return false;
    const t = Date.parse(b.start_time_utc);
    if (Number.isNaN(t)) return false;
    return t >= todayStartMs && t < todayEndExclusiveMs;
  });

  /** Agenda rows only (excludes completed / cancelled / queue-only). Stats still use full `todayInWindow`. */
  const today = todayInWindow.filter((b) => OWNER_TODAY_LIST_SET.has(b.status));

  const upcoming = allBookings.filter((b) => {
    if (b.start_time_utc == null) return false;
    const t = Date.parse(b.start_time_utc);
    if (Number.isNaN(t)) return false;
    return t >= todayEndExclusiveMs && b.status === "confirmed";
  });

  const pending = todayInWindow.filter((b) => b.status === "pending").length;
  const confirmed = todayInWindow.filter((b) => b.status === "confirmed").length;
  const completed = todayInWindow.filter((b) => b.status === "completed").length;
  const revenueCents = todayInWindow.reduce((sum, b) => sum + b.price_cents, 0);

  return {
    today,
    upcoming,
    stats: {
      totalToday: todayInWindow.length,
      pending,
      confirmed,
      completed,
      revenueCents,
    },
  };
}

export function groupUpcomingBookingsBySalonDay(
  bookings: SalonDashboardBooking[],
  timezone: string,
  locale: string,
): Array<{ label: string; items: SalonDashboardBooking[] }> {
  const tz = safeSalonTimezone(timezone);
  const labelFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const groups = new Map<
    string,
    { label: string; items: SalonDashboardBooking[] }
  >();

  for (const booking of bookings) {
    if (!booking.start_time_utc) continue;
    const timestamp = Date.parse(booking.start_time_utc);
    if (Number.isNaN(timestamp)) continue;
    const date = new Date(timestamp);
    const key = salonYmdOfUtc(date.toISOString(), tz);
    const group = groups.get(key);
    if (group) group.items.push(booking);
    else groups.set(key, { label: labelFormatter.format(date), items: [booking] });
  }

  return [...groups.values()].sort((a, b) => {
    const firstA = Date.parse(a.items[0]?.start_time_utc ?? "");
    const firstB = Date.parse(b.items[0]?.start_time_utc ?? "");
    return firstA - firstB;
  });
}
