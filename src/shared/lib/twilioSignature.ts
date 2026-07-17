import "server-only";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import type { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * The exact scheme+host Twilio actually reached us on. Twilio signs the FINAL
 * request URL — and an apex webhook (nailiq.ca) 307-redirects to the canonical
 * www host, so Twilio ends up signing `https://www.nailiq.ca/...`. Validating
 * against a hardcoded NEXT_PUBLIC_APP_URL (apex) would therefore mismatch. Read
 * the forwarded host instead so validation matches whatever host received the
 * request, regardless of apex/www/redirect. Falls back to the env only if no
 * proxy headers are present (e.g. a direct local call).
 */
export function twilioRequestBaseUrl(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") ?? "https";
    return `${proto}://${host}`;
  }
  return (process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca").replace(/\/$/, "");
}

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
