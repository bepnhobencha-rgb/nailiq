import "server-only";

import type { NextRequest } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/** Browser-only capability boundary. Missing Origin is denied deliberately. */
export function isAllowedGroupBookingOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
  const allowed = new Set<string>([request.nextUrl.origin]);
  for (const candidate of [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
    process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : null,
  ]) {
    if (!candidate) continue;
    try {
      allowed.add(new URL(candidate).origin);
    } catch {
      // A malformed deployment URL never expands the allow-list.
    }
  }
  return allowed.has(origin);
}

/** `null` means the security dependency failed, so callers must fail closed. */
export async function groupBookingRateLimitAllowed(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean | null> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "rate_limit_hit",
      { p_key: key, p_limit: limit, p_window_seconds: windowSeconds },
    );
    if (error || typeof data !== "boolean") return null;
    return data;
  } catch {
    return null;
  }
}
