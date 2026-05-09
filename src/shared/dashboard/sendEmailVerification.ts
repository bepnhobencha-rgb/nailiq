import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Create a verification token for `(salonId, email)` and send the
 * verify-link email via Resend.
 *
 * Best-effort: returns { ok: false, reason } when Resend is missing or
 * the send fails. Callers (`addSalonEmail`) should log + continue —
 * the underlying email-update mutation already succeeded; the
 * verification flow can be retried by re-saving the same email.
 *
 * Token TTL: 24 hours (long enough for the recipient to find the email
 * in spam, short enough that unused tokens don't accumulate).
 */

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export type SendEmailVerificationResult =
  | { ok: true; token: string }
  | { ok: false; reason: "no_client" | "insert_failed" | "send_failed" };

function buildVerifyUrl(token: string): string {
  const base =
    (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  const origin = base.length > 0 ? base : "http://localhost:3000";
  return `${origin.replace(/\/$/, "")}/api/verify-email?token=${encodeURIComponent(
    token,
  )}`;
}

function buildHtml(salonName: string, verifyUrl: string): string {
  // Plain HTML, no template engine. Keep it minimal — most clients
  // strip styles aggressively. The verify link is the operative
  // element; the rest is courtesy framing.
  return `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #111;">
  <h2 style="margin: 0 0 12px;">Verify your NailIQ email</h2>
  <p style="margin: 0 0 12px;">Hi! Please confirm this is the recovery email for <strong>${escapeHtml(
    salonName,
  )}</strong> on NailIQ.</p>
  <p style="margin: 0 0 16px;">
    <a href="${verifyUrl}" style="display: inline-block; padding: 10px 16px; background: #D4AF37; color: #0B0C10; text-decoration: none; border-radius: 6px; font-weight: 600;">Verify email</a>
  </p>
  <p style="margin: 0 0 12px; color: #666; font-size: 13px;">
    Or copy this link into your browser:<br>
    <a href="${verifyUrl}" style="color: #666;">${verifyUrl}</a>
  </p>
  <p style="margin: 24px 0 0; color: #999; font-size: 12px;">
    This link expires in 24 hours. If you didn't request it, ignore this message.
  </p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendEmailVerification(input: {
  salonId: string;
  salonName: string;
  email: string;
}): Promise<SendEmailVerificationResult> {
  const resend = getResendClient();
  if (!resend) {
    // Dev-only path; production throws inside getResendClient.
    return { ok: false, reason: "no_client" };
  }

  const supabase = createServiceRoleClient();
  // `email_verification_tokens` is not in the auto-generated DB types
  // until the next regeneration; cast the patch object so the insert
  // typechecks. Will become a typed call later.
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const { data: inserted, error: insErr } = await supabase
    .from("email_verification_tokens")
    .insert({
      salon_id: input.salonId,
      email: input.email,
      expires_at: expiresAt,
    } as never)
    .select("token")
    .maybeSingle();

  if (insErr || !inserted) {
    console.error("[sendEmailVerification] insert", insErr);
    return { ok: false, reason: "insert_failed" };
  }

  const token = String((inserted as { token: string }).token);
  const verifyUrl = buildVerifyUrl(token);

  try {
    const res = await resend.emails.send({
      from: getResendFrom(),
      to: input.email,
      subject: "Verify your NailIQ email",
      html: buildHtml(input.salonName, verifyUrl),
    });
    if (res.error) {
      console.error("[sendEmailVerification] resend send", res.error);
      return { ok: false, reason: "send_failed" };
    }
  } catch (e) {
    console.error("[sendEmailVerification] resend threw", e);
    return { ok: false, reason: "send_failed" };
  }

  return { ok: true, token };
}
