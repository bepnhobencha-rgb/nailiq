import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";

/**
 * Link a referral code to the referee's booking. Called fire-and-forget from the
 * public-booking side-effects when the customer arrived via `/<slug>?ref=CODE`.
 *
 * Server-side reimplementation of the `referral-claim` edge function, which was
 * never wired up (nothing consumed `?ref=`). NEVER throws — a bad / expired /
 * self / already-claimed code is a silent no-op, so it can't affect the booking.
 */
export async function claimReferral(input: {
  salonId: string;
  code: string;
  refereePhone: string;
  refereeBookingId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  try {
    const code = input.code.trim().toUpperCase();
    const refereePhone = toCanonicalPhone(input.refereePhone);
    if (!code || !refereePhone) return { ok: false, reason: "missing" };

    const db = createServiceRoleClient();
    const { data: referral } = await db
      .from("referrals")
      .select("id, referrer_phone, referee_phone, status, expires_at")
      .eq("salon_id", input.salonId)
      .eq("code", code)
      .maybeSingle();

    if (!referral) return { ok: false, reason: "invalid_code" };
    const r = referral as {
      id: string;
      referrer_phone: string;
      referee_phone: string | null;
      status: string;
      expires_at: string | null;
    };

    if (r.status !== "pending") return { ok: false, reason: "already_used" };
    if (r.expires_at && new Date(r.expires_at) < new Date()) {
      return { ok: false, reason: "expired" };
    }
    // No self-referral (compare canonical forms).
    if (toCanonicalPhone(r.referrer_phone) === refereePhone) {
      return { ok: false, reason: "self_referral" };
    }
    // The referee slot must be free (or the same person retrying).
    if (r.referee_phone && toCanonicalPhone(r.referee_phone) !== refereePhone) {
      return { ok: false, reason: "already_assigned" };
    }

    const { error } = await db
      .from("referrals")
      .update({
        referee_phone: refereePhone,
        referee_booking_id: input.refereeBookingId,
        status: "used",
        used_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as never)
      .eq("id", r.id)
      .eq("status", "pending"); // atomic guard against a double-claim race
    if (error) return { ok: false, reason: "update_failed" };
    return { ok: true };
  } catch (e) {
    console.error("[claimReferral]", e);
    return { ok: false, reason: "error" };
  }
}
