import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { buildEmailExperience } from "@/shared/lib/emailExperience";

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

export async function sendEmailVerification(input: {
  salonId: string;
  salonName: string;
  email: string;
}): Promise<SendEmailVerificationResult> {
  let resend: ReturnType<typeof getResendClient>;
  try {
    resend = getResendClient();
  } catch {
    // `getResendClient` intentionally throws when production is missing its
    // credential. Verification delivery is best-effort, so convert that
    // configuration fault into explicit delivery truth for the caller rather
    // than crashing the settings page after the email address was saved.
    return { ok: false, reason: "no_client" };
  }
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
  const experience = buildEmailExperience({
    key: "email_verification",
    locale: "en",
    subject: "Verify your NailIQ email",
    preheader: "Confirm your recovery email. This link expires in 24 hours.",
    salonName: input.salonName,
    recipientEmail: input.email,
    badge: "SECURE RECOVERY",
    heading: "Verify your NailIQ email",
    paragraphs: [`Please confirm this is the recovery email for ${input.salonName} on NailIQ.`],
    callout: {
      title: "Account protection",
      body: "Opening this email changes nothing. The recovery address is verified only after you use the secure button.",
    },
    actions: [{ label: "Verify email", url: verifyUrl }],
    note: "This link expires in 24 hours. If you didn't request it, ignore this message.",
  });

  try {
    const res = await resend.emails.send({
      from: getResendFrom(),
      to: input.email,
      subject: "Verify your NailIQ email",
      html: experience.html,
      text: experience.text,
      headers: experience.headers,
      tags: experience.tags,
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
