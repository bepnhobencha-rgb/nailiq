import "server-only";
import crypto from "node:crypto";
import type { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Twilio webhook signature validation, shared by the Voice and SMS inbound
 * routes. Twilio signs the FULL request URL (including any query string) plus
 * the sorted POST params with the account auth token; we recompute and compare.
 *
 * The auth token lives in platform_settings (admin-managed) with an env
 * fallback — same lookup both routes need, so it lives here once.
 */

export async function getTwilioAuthToken(
  supabase: ReturnType<typeof createServiceRoleClient>,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("platform_settings")
      .select("twilio_auth_token")
      .eq("id", "platform")
      .maybeSingle();
    const token = (data as { twilio_auth_token?: string | null } | null)?.twilio_auth_token?.trim();
    if (token) return token;
  } catch {
    /* fall through to env */
  }
  return process.env.TWILIO_AUTH_TOKEN?.trim() ?? null;
}

/** Recompute Twilio's HMAC-SHA1 signature and compare in constant time. */
export function validateTwilioSignature(
  fullUrl: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): boolean {
  const data = fullUrl + Object.keys(params).sort().map((k) => k + (params[k] ?? "")).join("");
  const computed = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}
