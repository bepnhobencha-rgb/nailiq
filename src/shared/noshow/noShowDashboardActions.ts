"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

export type NoShowSummary = {
  unconfirmedCount: number;
  highRiskCount: number;
  depositRequiredCount: number;
  cancelledTodayCount: number;
  waitingWaitlistCount: number;
  recoveredThisWeekCount: number;
};

export type UnconfirmedBooking = {
  id: string;
  clientName: string;
  serviceName: string;
  staffName: string;
  startTimeUtc: string;
  riskScore: number | null;
  depositStatus: string;
};

export type WaitlistOpportunity = {
  id: string;
  clientName: string;
  serviceName: string;
  bookingDate: string;
  status: string;
  createdAt: string;
};

export async function loadNoShowDashboard(slug: string): Promise<{
  ok: boolean;
  summary?: NoShowSummary;
  unconfirmed?: UnconfirmedBooking[];
  waitlist?: WaitlistOpportunity[];
  error?: string;
}> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const supabase = createServiceRoleClient();
  const salonId = String(ctx.salon.id);
  const now = new Date().toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [
    { data: unconfirmedRows },
    { count: highRiskCount },
    { count: depositCount },
    { count: cancelledToday },
    { count: waitingWaitlist },
    { count: recoveredThisWeek },
    { data: waitlistRows },
  ] = await Promise.all([
    // Upcoming unconfirmed bookings (next 48h)
    supabase
      .from("bookings" as never)
      .select(`id, client_name, start_time_utc, deposit_status, no_show_risk_score,
               services(name), staff(name)`)
      .eq("salon_id", salonId)
      .in("status", ["pending", "confirmed"])
      .gte("start_time_utc", now)
      .lte("start_time_utc", new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString())
      .order("start_time_utc", { ascending: true })
      .limit(20),

    // High risk (score >= 60)
    supabase
      .from("bookings" as never)
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salonId)
      .in("status", ["pending", "confirmed"])
      .gte("start_time_utc", now)
      .gte("no_show_risk_score", 60),

    // Deposit required
    supabase
      .from("bookings" as never)
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salonId)
      .eq("deposit_status", "required")
      .in("status", ["pending", "confirmed"])
      .gte("start_time_utc", now),

    // Cancelled today
    supabase
      .from("bookings" as never)
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salonId)
      .eq("status", "cancelled")
      .gte("start_time_utc", todayStart.toISOString()),

    // Waitlist opportunities (waiting status)
    supabase
      .from("booking_waitlist_entries" as never)
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salonId)
      .eq("status", "waiting"),

    // Recovered slots this week (waitlist claimed)
    supabase
      .from("booking_waitlist_entries" as never)
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salonId)
      .eq("status", "claimed")
      .gte("claimed_at", weekAgo),

    // Waitlist list
    supabase
      .from("booking_waitlist_entries" as never)
      .select(`id, client_name, booking_date, status, created_at, services(name)`)
      .eq("salon_id", salonId)
      .in("status", ["waiting", "notified"])
      .order("created_at", { ascending: true })
      .limit(10),
  ]);

  type RawBooking = {
    id: string; client_name: string; start_time_utc: string;
    deposit_status: string; no_show_risk_score: number | null;
    services: { name: string } | null; staff: { name: string } | null;
  };

  type RawWaitlist = {
    id: string; client_name: string; booking_date: string;
    status: string; created_at: string; services: { name: string } | null;
  };

  const unconfirmed: UnconfirmedBooking[] = ((unconfirmedRows ?? []) as RawBooking[]).map((b) => ({
    id: b.id,
    clientName: b.client_name,
    serviceName: b.services?.name ?? "—",
    staffName: b.staff?.name ?? "—",
    startTimeUtc: b.start_time_utc,
    riskScore: b.no_show_risk_score,
    depositStatus: b.deposit_status,
  }));

  const waitlist: WaitlistOpportunity[] = ((waitlistRows ?? []) as RawWaitlist[]).map((w) => ({
    id: w.id,
    clientName: w.client_name,
    serviceName: w.services?.name ?? "—",
    bookingDate: w.booking_date,
    status: w.status,
    createdAt: w.created_at,
  }));

  return {
    ok: true,
    summary: {
      unconfirmedCount: unconfirmed.length,
      highRiskCount: highRiskCount ?? 0,
      depositRequiredCount: depositCount ?? 0,
      cancelledTodayCount: cancelledToday ?? 0,
      waitingWaitlistCount: waitingWaitlist ?? 0,
      recoveredThisWeekCount: recoveredThisWeek ?? 0,
    },
    unconfirmed,
    waitlist,
  };
}

/** Toggle reminders_enabled for a salon. */
export async function updateRemindersEnabled(
  slug: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || ctx.role !== "owner") return { ok: false, error: "unauthorized" };

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("salons" as never)
    .update({ reminders_enabled: enabled } as never)
    .eq("id", ctx.salon.id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Update per-salon reminder + deposit settings. */
export async function updateReminderSettings(
  slug: string,
  settings: {
    reminder_24h_enabled?: boolean;
    reminder_3h_enabled?: boolean;
    deposit_high_value_cents?: number;
  },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || ctx.role !== "owner") return { ok: false, error: "unauthorized" };

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("salons" as never)
    .update(settings as never)
    .eq("id", ctx.salon.id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Mark a booking's deposit as waived (owner override). */
export async function waiveBookingDeposit(
  slug: string,
  bookingId: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || ctx.role !== "owner") return { ok: false, error: "unauthorized" };

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("bookings" as never)
    .update({ deposit_status: "waived", deposit_required: false } as never)
    .eq("id", bookingId)
    .eq("salon_id", ctx.salon.id);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
