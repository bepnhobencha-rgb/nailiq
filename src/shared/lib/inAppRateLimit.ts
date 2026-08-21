import "server-only";

import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * App-level rate limit (DB-backed, atomic fixed-window) — independent of the
 * Vercel WAF, so it enforces on any plan and we control + verify it. Returns
 * true when the caller is OVER the limit and should be blocked (429).
 *
 * Callers must choose whether a limiter outage allows or blocks the request.
 * Cost, PII and provider endpoints use `failureMode: "block"`; low-risk UX
 * surfaces may retain the explicit compatibility default (`allow`).
 */
export async function isOverRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  options: { failureMode?: "allow" | "block" } = {},
): Promise<boolean> {
  const blockOnFailure = options.failureMode === "block";
  try {
    const sb = createServiceRoleClient();
    const { data, error } = await sb.rpc("rate_limit_hit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error || typeof data !== "boolean") return blockOnFailure;
    // RPC returns true when ALLOWED → over-limit is the negation.
    return data === false;
  } catch {
    return blockOnFailure;
  }
}

/**
 * Stable, non-reversible key for the durable limiter. Raw IP addresses,
 * booking IDs, phone numbers, and other caller material must not be persisted
 * in `rate_limits.key`.
 */
export function durableRateLimitKey(
  scope: string,
  ...material: string[]
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(material))
    .digest("hex");
  return `${scope}:${digest}`;
}

/** Best-effort client IP from the proxy headers (Vercel sets x-forwarded-for). */
export function clientIpFromHeaders(headers: Pick<Headers, "get">): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip") ?? "unknown";
}

export function clientIp(req: Request): string {
  return clientIpFromHeaders(req.headers);
}
