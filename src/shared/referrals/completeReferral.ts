import "server-only";
import { randomUUID } from "node:crypto";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendReferralRewardEmail } from "@/shared/referrals/sendReferralRewardEmail";

function voucherCode(): string {
  return "REF" + randomUUID().replace(/-/g, "").toUpperCase().slice(0, 6);
}

/**
 * When a referred customer's booking completes, issue the reward vouchers for
 * both the referrer and the referee, mark the referral completed, and email both
 * their codes. Called fire-and-forget from `updateBookingStatus` when a booking
 * flips to `completed` (mirrors `sendReviewRequest`).
 *
 * Server-side reimplementation of the orphaned `referral-complete` edge function.
 * Idempotent + race-safe: the completion is claimed with an atomic
 * `status='used' → 'completed'` transition BEFORE minting, so concurrent calls
 * (or a re-completed booking) never double-issue vouchers. Never throws.
 */
export async function completeReferral(bookingId: string): Promise<void> {
  try {
    const db = createServiceRoleClient();

    const { data: referral } = await db
      .from("referrals")
      .select(
        "id, salon_id, referrer_phone, referee_phone, referrer_reward_percent_off, referee_reward_percent_off",
      )
      .eq("referee_booking_id", bookingId)
      .eq("status", "used")
      .maybeSingle();
    if (!referral) return; // no pending referral for this booking — normal
    const r = referral as {
      id: string;
      salon_id: string;
      referrer_phone: string;
      referee_phone: string | null;
      referrer_reward_percent_off: number | null;
      referee_reward_percent_off: number | null;
    };

    const now = new Date();
    const nowIso = now.toISOString();

    // Claim the completion atomically so a concurrent call can't double-issue.
    const { data: claimed } = await db
      .from("referrals")
      .update({ status: "completed", completed_at: nowIso, updated_at: nowIso } as never)
      .eq("id", r.id)
      .eq("status", "used")
      .select("id");
    if (!claimed || (claimed as unknown[]).length === 0) return; // lost the race / already done

    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const referrerPercent = r.referrer_reward_percent_off ?? 10;
    const refereePercent = r.referee_reward_percent_off ?? 10;

    async function mint(phone: string | null, percent: number): Promise<{ id: string; code: string } | null> {
      const code = voucherCode();
      const { data, error } = await db
        .from("vouchers")
        .insert({
          salon_id: r.salon_id,
          code,
          kind: "referral_reward",
          percent_off: percent,
          max_uses: 1,
          valid_from: nowIso,
          expires_at: expiresAt,
          client_phone: phone ?? undefined,
        } as never)
        .select("id, code")
        .single();
      if (error) {
        console.error("[completeReferral] voucher mint", error);
        return null;
      }
      return data as { id: string; code: string };
    }

    const referrerVoucher = await mint(r.referrer_phone, referrerPercent);
    const refereeVoucher = await mint(r.referee_phone, refereePercent);

    if (referrerVoucher || refereeVoucher) {
      await db
        .from("referrals")
        .update({
          referrer_voucher_id: referrerVoucher?.id ?? null,
          referee_voucher_id: refereeVoucher?.id ?? null,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id", r.id);
    }

    // Best-effort reward emails — never block, never throw.
    void sendReferralRewardEmail({
      bookingId,
      salonId: r.salon_id,
      referrerPhone: r.referrer_phone,
      refereePhone: r.referee_phone,
      referrerCode: referrerVoucher?.code ?? null,
      refereeCode: refereeVoucher?.code ?? null,
      referrerPercent,
      refereePercent,
    }).catch((e) => console.error("[completeReferral] email", e));
  } catch (e) {
    console.error("[completeReferral]", e);
  }
}
