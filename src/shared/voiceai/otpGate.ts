import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";

/**
 * Adaptive identity gate for a MUTATING AI-receptionist action (book / cancel /
 * reschedule / group). Server-authoritative: the model's word that a caller is
 * "verified" is never trusted — proof is checked here, against the same
 * `phone_otp_sessions` capability tokens the public booking flow uses.
 *
 * Two tiers (fastest sufficient one wins):
 *  1. Caller-ID — phone channel only. The inbound call's `From` number is
 *     carrier-authenticated for that call, so a match to the action's phone
 *     proves the caller controls it (no code). `callerVerifiedPhone` is set ONLY
 *     by the trusted phone bridge (Twilio `From`); it is never accepted from the
 *     web/model, so a web caller cannot spoof it. (Module 2 adds SHAKEN/STIR.)
 *  2. OTP session — the default (all web actions, and phone actions whose number
 *     does not match the caller-ID). Requires a still-valid `phone_otp_sessions`
 *     row for exactly (salon, phone).
 *
 * IMPORTANT for cancel/reschedule: pass the phone that OWNS the booking (its
 * `client_phone`), NOT a phone the caller merely spoke — that is what stops a
 * caller cancelling someone else's appointment.
 */
export type OtpGateResult =
  | { ok: true; via: "caller_id" | "otp" }
  | { ok: false; error: "invalid_phone" | "otp_required"; hint: string };

const RETRY_HINT =
  "Verify the phone that owns this appointment first: call request_otp(phone), " +
  "have the customer read back the code, call verify_otp(phone, code), then retry " +
  "this action with the returned otp_session_id.";

export async function requirePhoneVerified(
  supabase: SupabaseClient,
  salonId: string,
  actionPhone: string,
  opts?: { otpSessionId?: string | null; callerVerifiedPhone?: string | null },
): Promise<OtpGateResult> {
  const phone = toCanonicalPhone(actionPhone);
  if (!phone) {
    return {
      ok: false,
      error: "invalid_phone",
      hint: "The phone number is not valid; confirm it with the customer.",
    };
  }

  // Tier 1 — carrier-verified caller-ID (phone channel only, set server-side).
  const caller = opts?.callerVerifiedPhone
    ? toCanonicalPhone(opts.callerVerifiedPhone)
    : null;
  if (caller && caller === phone) return { ok: true, via: "caller_id" };

  // Tier 2 — OTP capability token, bound to (salon, phone), unconsumed, unexpired.
  const id = (opts?.otpSessionId ?? "").trim();
  if (!id) return { ok: false, error: "otp_required", hint: RETRY_HINT };

  const { data } = await supabase
    .from("phone_otp_sessions")
    .select("phone, consumed_at, expires_at")
    .eq("id", id)
    .eq("salon_id", salonId)
    .maybeSingle();

  const row = data as
    | { phone: string; consumed_at: string | null; expires_at: string }
    | null;

  if (
    !row ||
    toCanonicalPhone(row.phone) !== phone ||
    row.consumed_at !== null ||
    new Date(row.expires_at).getTime() < Date.now()
  ) {
    return { ok: false, error: "otp_required", hint: RETRY_HINT };
  }

  return { ok: true, via: "otp" };
}
