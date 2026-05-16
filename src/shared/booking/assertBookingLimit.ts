import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canCreateBooking,
  getEffectivePlanLimits,
  type PlanCheckSalon,
} from "@/shared/lib/subscriptionPlans";

/**
 * Enforce the per-plan monthly booking cap before a row is inserted.
 *
 * Free tier is capped at 50 non-cancelled bookings per calendar month
 * (UTC) per landing-page promise. Pro / Premium are unlimited. The
 * count includes both public-booking and walk-in inserts because
 * `public.bookings` is the single source of truth — the cap is "rows
 * landing in this table", not source-of-traffic specific.
 *
 * Throws `monthly_booking_limit_reached` so the caller can surface a
 * friendly upgrade prompt. Soft-fails (treats counting error as "OK
 * to proceed") so a transient query glitch doesn't lock out paying
 * tenants — the worst case is one over-cap booking, not a fleet-wide
 * outage. A Sentry breadcrumb is left on the soft-fail path.
 */
export async function assertBookingLimitAvailable(
  supabase: SupabaseClient,
  salon: PlanCheckSalon & { id: string },
  /** Number of new bookings this caller is about to create. Group
   *  bookings pass `group_size`; single-row inserts default to 1. */
  additional: number = 1,
): Promise<void> {
  // Skip the count round-trip entirely when the plan is unlimited.
  // The helper recognises feature-flag escapes too, so SuperAdmin
  // `unlimited_bookings` flips this branch as well.
  const limits = getEffectivePlanLimits(salon);
  if (!Number.isFinite(limits.maxBookingsPerMonth)) {
    return;
  }

  const monthStart = startOfCurrentUtcMonth();

  const { count, error } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", salon.id)
    .gte("start_time_utc", monthStart.toISOString())
    .neq("status", "cancelled");

  if (error) {
    // Don't block bookings if we can't read the count — surface to
    // Sentry but let the booking through.
    console.error("[assertBookingLimit] count query failed", error);
    return;
  }

  const projected = Number(count ?? 0) + Math.max(1, additional) - 1;
  if (!canCreateBooking(salon, projected)) {
    throw new Error("monthly_booking_limit_reached");
  }
}

function startOfCurrentUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
