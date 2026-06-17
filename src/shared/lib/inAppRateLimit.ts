import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * App-level rate limit (DB-backed, atomic fixed-window) — independent of the
 * Vercel WAF, so it enforces on any plan and we control + verify it. Returns
 * true when the caller is OVER the limit and should be blocked (429).
 *
 * FAILS OPEN: any DB error returns false (allowed). A rate-limiter outage must
 * never block a paying customer's flow — the WAF rule is the other layer.
 */
export async function isOverRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const sb = createServiceRoleClient();
    const { data, error } = await sb.rpc("rate_limit_hit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) return false; // fail open
    // RPC returns true when ALLOWED → over-limit is the negation.
    return data === false;
  } catch {
    return false;
  }
}

/** Best-effort client IP from the proxy headers (Vercel sets x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}
