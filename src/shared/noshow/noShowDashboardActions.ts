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
               services!bookings_service_id_fkey(name), staff(name)`)
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
    sms_reminders_enabled?: boolean;
    deposit_high_value_cents?: number;
    deposit_pct_no_show?: number;
    deposit_pct_high_value?: number;
    deposit_pct_new_customer?: number;
    /** Minutes a deposit-held slot waits for payment before auto-release. */
    deposit_hold_grace_minutes?: number;
    /** Master ON/OFF for Square deposits (lives on square_integrations). */
    deposit_enabled?: boolean;
    /** Bilingual cancellation/no-show policy { en, vi }. */
    cancellation_policy?: { en?: string; vi?: string };
    /** Override the per-vertical health-acknowledgment requirement (salons col). */
    health_ack_required?: boolean;
  },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || ctx.role !== "owner") return { ok: false, error: "unauthorized" };

  // Clamp deposit percentages to 0–100 (defense-in-depth; the DB also CHECKs).
  const clampPct = (v: number | undefined) =>
    v == null ? undefined : Math.min(100, Math.max(0, Math.round(v)));
  // deposit_enabled lives on square_integrations, not salons — pull it out.
  const { deposit_enabled, ...salonSettings } = settings;
  const patch = { ...salonSettings } as Record<string, unknown>;
  for (const k of ["deposit_pct_no_show", "deposit_pct_high_value", "deposit_pct_new_customer"]) {
    if (patch[k] !== undefined) patch[k] = clampPct(patch[k] as number | undefined);
  }
  if (patch.deposit_hold_grace_minutes !== undefined) {
    const g = Math.round(Number(patch.deposit_hold_grace_minutes) || 30);
    patch.deposit_hold_grace_minutes = Math.min(1440, Math.max(5, g));
  }
  // Cancellation policy: cap each language at 8k chars (defense-in-depth).
  if (patch.cancellation_policy !== undefined) {
    const cp = (patch.cancellation_policy ?? {}) as { en?: string; vi?: string };
    patch.cancellation_policy = {
      en: typeof cp.en === "string" ? cp.en.slice(0, 8000) : "",
      vi: typeof cp.vi === "string" ? cp.vi.slice(0, 8000) : "",
    };
  }

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("salons" as never)
    .update(patch as never)
    .eq("id", ctx.salon.id);
  if (error) return { ok: false, error: error.message };

  // Master deposit toggle → square_integrations (only if a Square connection row
  // exists; otherwise there's nothing to enable yet).
  if (deposit_enabled !== undefined) {
    const { error: sqErr } = await supabase
      .from("square_integrations" as never)
      .update({ deposit_enabled } as never)
      .eq("salon_id", ctx.salon.id);
    if (sqErr) return { ok: false, error: sqErr.message };
  }

  return { ok: true };
}

/** Update the provider choice + no-show card-on-file policy (provider-agnostic).
 *  Owner only. Provider is locked elsewhere once a card exists; this just sets it. */
export async function updateNoShowCardSettings(
  slug: string,
  settings: {
    payment_provider?: "square" | "stripe";
    noshow_protection_enabled?: boolean;
    noshow_fee_percent?: number;
    noshow_risk_threshold?: number;
  },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx || ctx.role !== "owner") return { ok: false, error: "unauthorized" };

  const clampPct = (v: number) => Math.min(100, Math.max(0, Math.round(v)));
  const patch: Record<string, unknown> = {};
  if (settings.payment_provider === "square" || settings.payment_provider === "stripe") {
    patch.payment_provider = settings.payment_provider;
  }
  if (typeof settings.noshow_protection_enabled === "boolean") {
    patch.noshow_protection_enabled = settings.noshow_protection_enabled;
  }
  if (settings.noshow_fee_percent != null) {
    patch.noshow_fee_percent = clampPct(settings.noshow_fee_percent);
  }
  if (settings.noshow_risk_threshold != null) {
    patch.noshow_risk_threshold = clampPct(settings.noshow_risk_threshold);
  }
  if (Object.keys(patch).length === 0) return { ok: true };

  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("salons" as never)
    .update(patch as never)
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
