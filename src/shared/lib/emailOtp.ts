import "server-only";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getResendClient, getResendFrom } from "@/shared/lib/resend";
import {
  complianceFooterHtml,
  listUnsubscribeHeaders,
} from "@/shared/lib/emailCompliance";

/**
 * Self-contained EMAIL fallback for the booking phone-OTP.
 *
 * Why not Twilio Verify's email channel: that needs a SendGrid integration
 * configured Twilio-side, and leaning on Twilio for the fallback when Twilio's
 * SMS is the thing failing is fragile. So we mint + verify our own 6-digit code
 * and email it through Resend (the working channel). On success the caller mints
 * the SAME `phone_otp_sessions` row the SMS path creates — downstream unchanged.
 *
 * Security: only the HMAC of the code is stored; codes expire in 10 min; max 5
 * attempts; sends are rate-limited per (salon, phone). Constant-time compare.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_SENDS = 5;

function secret(): string {
  return (process.env.INTERNAL_API_SECRET ?? "").trim() || "nailiq-fallback-key";
}

function hashCode(code: string): string {
  return createHmac("sha256", secret()).update(code).digest("hex");
}

/** Cryptographically-random zero-padded 6-digit code. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Generate, store, and EMAIL a fresh code for (salon, phone, email).
 * Rate-limited. Returns ok even when Resend is unconfigured in dev (no-op).
 */
export async function createAndSendEmailOtp(args: {
  salonId: string;
  phone: string; // digits only
  email: string;
  salonName: string;
  salonAddress?: string | null;
  lang?: "en" | "vi";
}): Promise<{ ok: boolean; error?: string }> {
  const email = args.email.trim().toLowerCase();
  if (!email) return { ok: false, error: "no_email" };

  const supabase = createServiceRoleClient();

  // Rate limit: cap sends per (salon, phone) within the window.
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const { count } = await supabase
    .from("email_otp_codes" as never)
    .select("id", { count: "exact", head: true })
    .eq("salon_id", args.salonId)
    .eq("phone", args.phone)
    .gte("created_at", since);
  if ((count ?? 0) >= RATE_MAX_SENDS) {
    return { ok: false, error: "rate_limited" };
  }

  const code = generateCode();
  const { error: insErr } = await supabase.from("email_otp_codes" as never).insert({
    salon_id: args.salonId,
    phone: args.phone,
    email,
    code_hash: hashCode(code),
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  } as never);
  if (insErr) {
    console.error("[emailOtp] insert", insErr);
    return { ok: false, error: "server_error" };
  }

  const sent = await sendOtpCodeEmail({
    email,
    code,
    salonName: args.salonName,
    salonAddress: args.salonAddress,
    lang: args.lang === "en" ? "en" : "vi",
  });
  // In dev (no Resend key) sent is false but the code row exists — treat as ok
  // so the rest of the flow is testable; prod throws on missing key upstream.
  if (!sent.ok && sent.error !== "resend_not_configured") {
    return { ok: false, error: "send_failed" };
  }
  return { ok: true };
}

/**
 * Verify a code against the active row for (salon, phone, email). Increments the
 * attempt counter; consumes the row on success or when attempts are exhausted.
 */
export async function checkEmailOtp(args: {
  salonId: string;
  phone: string;
  email: string;
  code: string;
}): Promise<{ ok: boolean; error?: string }> {
  const email = args.email.trim().toLowerCase();
  const code = args.code.replace(/\D/g, "");
  if (!email || !/^\d{4,8}$/.test(code)) return { ok: false, error: "invalid_code" };

  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("email_otp_codes" as never)
    .select("id, code_hash, attempts, expires_at")
    .eq("salon_id", args.salonId)
    .eq("phone", args.phone)
    .eq("email", email)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const row = data as
    | { id: string; code_hash: string; attempts: number; expires_at: string }
    | null;
  if (!row) return { ok: false, error: "expired_or_max_attempts" };

  // Out of attempts → consume + reject.
  if (row.attempts >= MAX_ATTEMPTS) {
    await supabase
      .from("email_otp_codes" as never)
      .update({ consumed_at: new Date().toISOString() } as never)
      .eq("id", row.id);
    return { ok: false, error: "expired_or_max_attempts" };
  }

  const match = constantTimeEqual(row.code_hash, hashCode(code));
  if (!match) {
    await supabase
      .from("email_otp_codes" as never)
      .update({ attempts: row.attempts + 1 } as never)
      .eq("id", row.id);
    return { ok: false, error: "invalid_code" };
  }

  // Success — consume so the code can't be reused.
  await supabase
    .from("email_otp_codes" as never)
    .update({ consumed_at: new Date().toISOString() } as never)
    .eq("id", row.id);
  return { ok: true };
}

/** The code email itself (big code, bilingual, CASL footer). */
async function sendOtpCodeEmail(input: {
  email: string;
  code: string;
  salonName: string;
  salonAddress?: string | null;
  lang: "en" | "vi";
}): Promise<{ ok: boolean; error?: string }> {
  // getResendClient() THROWS when the key is missing in a production build (e.g.
  // a preview deployment without the Preview-env key). Treat that as "not
  // configured" rather than a 500 — the SMS channel still works.
  let resend: ReturnType<typeof getResendClient>;
  try {
    resend = getResendClient();
  } catch {
    return { ok: false, error: "resend_not_configured" };
  }
  if (!resend) return { ok: false, error: "resend_not_configured" };

  const en = input.lang === "en";
  const subject = en
    ? `Your verification code: ${input.code} · ${input.salonName}`
    : `Mã xác thực của bạn: ${input.code} · ${input.salonName}`;
  const lead = en
    ? `Enter this code to confirm your booking at ${esc(input.salonName)}. It expires in 10 minutes.`
    : `Nhập mã này để xác nhận lịch hẹn tại ${esc(input.salonName)}. Mã hết hạn sau 10 phút.`;
  const ignore = en
    ? "If you didn't request this, you can ignore this email."
    : "Nếu bạn không yêu cầu mã này, có thể bỏ qua email.";

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#faf9f7;">
  <div style="max-width:440px;margin:0 auto;padding:30px 22px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#2a2a2a;text-align:center;">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.55;">${lead}</p>
    <div style="font-size:34px;font-weight:700;letter-spacing:10px;background:#0a0a0a;color:#fff;border-radius:12px;padding:16px 0;margin:0 0 16px;">${esc(input.code)}</div>
    <p style="margin:0;font-size:12px;color:#999;">${ignore}</p>
  </div>
</body></html>`.replace(
    "</body>",
    `${complianceFooterHtml({
      email: input.email,
      salonName: input.salonName,
      salonAddress: input.salonAddress,
      lang: input.lang,
    })}</body>`,
  );

  try {
    const { error } = await resend.emails.send({
      from: getResendFrom(),
      to: input.email,
      subject,
      html,
      headers: listUnsubscribeHeaders(input.email),
    });
    if (error) {
      console.error("[emailOtp] resend", error);
      return { ok: false, error: String(error) };
    }
    return { ok: true };
  } catch (e) {
    console.error("[emailOtp] resend threw", e);
    return { ok: false, error: String(e) };
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
