import { getUserMessages } from "@/shared/i18n/user";
import type { LoadSalonDashboardResult } from "@/shared/dashboard/salonOwnerActions";
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

/**
 * Split fetched bookings using UTC calendar-day boundaries.
 *
 * Previously this used `Date#setHours(0,0,0,0)`, which interprets the boundary
 * in the runtime's local timezone — server (TZ=UTC) and browser (TZ=viewer)
 * produced different start/end timestamps, so SSR and client hydration computed
 * different stats counts and React threw a hydration mismatch (e.g. server
 * "Bookings: 4" vs client "Bookings: 1"). Using `Date.UTC(...)` makes the
 * boundary identical on both sides. Trade-off: "today" is UTC today, not the
 * viewer's local today; for salons in extreme timezones, prefer threading the
 * salon timezone through and using `salonDayRangeUtc` instead.
 */
export function splitSalonDashboardBookings(
  allBookings: SalonDashboardBooking[],
): {
  today: SalonDashboardBooking[];
  upcoming: SalonDashboardBooking[];
  stats: SalonDashboardStatsSlice;
} {
  const now = new Date();
  const todayStartMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0, 0, 0, 0,
  );
  const todayEndMs = todayStartMs + 24 * 60 * 60 * 1000 - 1;

  const todayInWindow = allBookings.filter((b) => {
    if (b.start_time_utc == null) return false;
    const t = Date.parse(b.start_time_utc);
    if (Number.isNaN(t)) return false;
    return t >= todayStartMs && t <= todayEndMs;
  });

  /** Agenda rows only (excludes completed / cancelled / queue-only). Stats still use full `todayInWindow`. */
  const today = todayInWindow.filter((b) => OWNER_TODAY_LIST_SET.has(b.status));

  const upcoming = allBookings.filter((b) => {
    if (b.start_time_utc == null) return false;
    const t = Date.parse(b.start_time_utc);
    if (Number.isNaN(t)) return false;
    return t > todayEndMs && b.status === "confirmed";
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
