import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Email verification redirect endpoint.
 *
 * GET /api/verify-email?token=<uuid>
 *   - Looks up the token (service role; RLS denies all client roles).
 *   - If valid + unused + unexpired AND the salon's current email
 *     matches the token's email → flips `salons.email_verified = true`,
 *     burns the token (`used_at`), redirects to the salon's settings
 *     page with `?verified=1`.
 *   - On any failure → redirects to `/dashboard?verify_error=<reason>`
 *     (the dashboard route will fall through its own auth gate; we
 *     don't expose token-lookup errors to anonymous callers).
 *
 * Token mismatch on the salon's email column (e.g. owner saved a new
 * email while the old verify link was outstanding) is treated as
 * `mismatch` — we don't blindly mark verified for the new address.
 */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const token = (url.searchParams.get("token") ?? "").trim();

  const fail = (reason: string) =>
    NextResponse.redirect(
      new URL(`/dashboard?verify_error=${encodeURIComponent(reason)}`, url),
    );

  if (!token) return fail("missing_token");

  const supabase = createServiceRoleClient();
  const { data: row, error: rowErr } = await supabase
    .from("email_verification_tokens")
    .select("token, salon_id, email, used_at, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (rowErr) {
    console.error("[verify-email] token lookup", rowErr);
    return fail("server_error");
  }
  if (!row) return fail("not_found");

  const r = row as {
    token: string;
    salon_id: string;
    email: string;
    used_at: string | null;
    expires_at: string | null;
  };

  if (r.used_at) return fail("already_used");
  const exp = r.expires_at ? Date.parse(r.expires_at) : NaN;
  if (!Number.isFinite(exp) || exp < Date.now()) return fail("expired");

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .select("id, slug, email")
    .eq("id", r.salon_id)
    .maybeSingle();
  if (salonErr || !salon) {
    console.error("[verify-email] salon lookup", salonErr);
    return fail("server_error");
  }

  // Tokens carry the email at the time of issue. If the owner has
  // since changed the salon's email, this token is for an obsolete
  // address — refuse to verify the now-current value.
  const salonEmail =
    typeof salon.email === "string" ? salon.email.trim() : "";
  if (salonEmail.toLowerCase() !== r.email.trim().toLowerCase()) {
    return fail("mismatch");
  }

  const { error: upErr } = await supabase
    .from("salons")
    .update({ email_verified: true })
    .eq("id", r.salon_id);
  if (upErr) {
    console.error("[verify-email] salon update", upErr);
    return fail("server_error");
  }

  // Burn the token. Failure here is non-fatal — verification is
  // already applied; worst case a re-click hits `already_used`.
  await supabase
    .from("email_verification_tokens")
    .update({ used_at: new Date().toISOString() } as never)
    .eq("token", token);

  const slug = String(salon.slug ?? "");
  const redirectPath =
    slug.length > 0
      ? `/dashboard/${encodeURIComponent(slug)}/settings?verified=1`
      : "/dashboard?verified=1";
  return NextResponse.redirect(new URL(redirectPath, url));
}
