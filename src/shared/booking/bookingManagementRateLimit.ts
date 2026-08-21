import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { clientIp, durableRateLimitKey } from "@/shared/lib/inAppRateLimit";
import type { IndividualBookingManagementAction } from "@/shared/booking/bookingManagementCapabilities";

export type BookingManagementRateLimitResult = "allowed" | "limited" | "unavailable";

export async function consumeBookingManagementRateLimit(input: {
  request: Request;
  tokenId: string;
  action: IndividualBookingManagementAction | "waitlist_claim";
  phase: "inspect" | "mutate";
}): Promise<BookingManagementRateLimitResult> {
  const statusInspect = input.action === "status" && input.phase === "inspect";
  const limit = statusInspect ? 120 : input.phase === "inspect" ? 30 : 12;
  const windowSeconds = 300;
  const key = durableRateLimitKey(
    "booking-management",
    clientIp(input.request),
    input.tokenId.trim().toLowerCase(),
    input.action,
    input.phase,
  );
  try {
    const { data, error } = await createServiceRoleClient().rpc("rate_limit_hit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error || typeof data !== "boolean") return "unavailable";
    return data ? "allowed" : "limited";
  } catch {
    return "unavailable";
  }
}
