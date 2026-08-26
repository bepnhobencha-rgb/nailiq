import "server-only";

import { durableRateLimitKey } from "@/shared/lib/inAppRateLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type FinancialReportRateLimitResult = "allowed" | "rate_limited" | "unavailable";

async function hit(key: string, limit: number, windowSeconds: number): Promise<FinancialReportRateLimitResult> {
  try {
    const admin = createServiceRoleClient();
    const { data, error } = await admin.rpc("rate_limit_hit", {
      p_key: key, p_limit: limit, p_window_seconds: windowSeconds,
    });
    if (error || typeof data !== "boolean") return "unavailable";
    return data ? "allowed" : "rate_limited";
  } catch { return "unavailable"; }
}

/** Durable, PII-free actor and tenant meters. Every meter fails closed. */
export async function checkFinancialReportRateLimits(
  actorUserId: string,
  salonId: string,
  operation: "load" | "export",
): Promise<FinancialReportRateLimitResult> {
  const limits = operation === "load"
    ? { actor: [30, 300] as const, salon: [120, 300] as const }
    : { actor: [8, 300] as const, salon: [30, 3600] as const };
  for (const [scope, material, config] of [
    ["actor", actorUserId, limits.actor], ["salon", salonId, limits.salon],
  ] as const) {
    const result = await hit(durableRateLimitKey(`financial_report:${operation}:${scope}`, material), config[0], config[1]);
    if (result !== "allowed") return result;
  }
  return "allowed";
}
