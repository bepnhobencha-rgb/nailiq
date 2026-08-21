"use server";

import {
  getEffectivePlan,
  getEffectivePlanLimits,
  type PlanCheckSalon,
  type SubscriptionPlan,
} from "@/shared/lib/subscriptionPlans";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";

/**
 * Booking-limit status for the Receptionist Center upsell banner
 * (Phase B follow-up to the Free-tier limit enforcement landed in
 * PR #186).
 *
 * Returns enough state for the UI to render three banner variants:
 *   - Hidden when the plan is unlimited
 *   - "Approaching limit" warning at >= 80% of cap
 *   - "Limit hit" reactive banner at == cap (also blocks new bookings
 *     server-side, but the banner is the upsell surface)
 */
export type BookingLimitStatus = {
  /** Non-cancelled bookings created since start of current UTC month. */
  count: number;
  /** Effective cap from plan + feature flags; `Infinity` when unlimited. */
  cap: number;
  /** The plan after `plan_override` resolution. */
  plan: SubscriptionPlan;
  /** Convenience: cap === Infinity. */
  isUnlimited: boolean;
  /** Convenience: count / cap when capped; `null` when unlimited. */
  pctUsed: number | null;
};

export type LoadBookingLimitStatusResult =
  | { ok: true; status: BookingLimitStatus }
  | { ok: false; error: "unauthorized" | "server_error" };

export async function loadBookingLimitStatus(
  slug: string,
): Promise<LoadBookingLimitStatusResult> {
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return { ok: false, error: "unauthorized" };

  const supabase = ctx.supabase;

  const planFields = ctx.salon as PlanCheckSalon;
  const plan = getEffectivePlan(planFields);
  const cap = getEffectivePlanLimits(planFields).maxBookingsPerMonth;

  if (!Number.isFinite(cap)) {
    return {
      ok: true,
      status: {
        count: 0,
        cap,
        plan,
        isUnlimited: true,
        pctUsed: null,
      },
    };
  }

  const monthStart = startOfCurrentUtcMonth();
  const { count, error: countErr } = await supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("salon_id", ctx.salon.id)
    .gte("start_time_utc", monthStart.toISOString())
    .neq("status", "cancelled");
  if (countErr) {
    console.error("[loadBookingLimitStatus] count", countErr);
    // Don't fail the page render — degrade to unknown count (treated
    // as 0 by the banner, so it stays hidden).
    return {
      ok: true,
      status: {
        count: 0,
        cap,
        plan,
        isUnlimited: false,
        pctUsed: 0,
      },
    };
  }

  const current = Number(count ?? 0);
  return {
    ok: true,
    status: {
      count: current,
      cap,
      plan,
      isUnlimited: false,
      pctUsed: cap > 0 ? current / cap : 0,
    },
  };
}

function startOfCurrentUtcMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
