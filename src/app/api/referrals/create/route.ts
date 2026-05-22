import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { hasFeature } from "@/lib/feature-gating";
import type { Database } from "@/lib/database.types";

export const dynamic = "force-dynamic";

type SalonRow = Database["public"]["Tables"]["salons"]["Row"];

/**
 * POST /api/referrals/create
 * Body: { salon_id, phone, salon_slug }
 *
 * Returns existing active referral or creates a new one.
 */
export async function POST(req: Request) {
  const { salon_id, phone, salon_slug } = await req.json().catch(() => ({}));
  if (!salon_id || !phone) {
    return NextResponse.json({ ok: false, error: "missing_fields" }, { status: 400 });
  }

  const db = createServiceRoleClient();

  const { data: salon } = await db
    .from("salons")
    .select("subscription_plan, plan_override, feature_flags, slug")
    .eq("id", salon_id)
    .single();

  if (!salon || !hasFeature(salon as SalonRow, "bring_a_friend")) {
    return NextResponse.json({ ok: false, error: "not_available" }, { status: 403 });
  }

  const slug = salon_slug ?? salon.slug;

  // Check for existing active referral
  const { data: existing } = await db
    .from("referrals")
    .select("id, code, referrer_reward_percent_off, referee_reward_percent_off")
    .eq("salon_id", salon_id)
    .eq("referrer_phone", phone)
    .eq("status", "pending")
    .gte("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({
      ok: true,
      code: existing.code,
      share_url: `https://nailiq.ca/${slug}?ref=${existing.code}`,
      referrer_reward: existing.referrer_reward_percent_off ?? 10,
      referee_reward: existing.referee_reward_percent_off ?? 10,
      is_new: false,
    });
  }

  // Create new referral code via RPC
  const { data: result, error } = await db.rpc("create_referral_code" as never, {
    p_salon_id: salon_id,
    p_referrer_phone: phone,
    p_referrer_reward: 10,
    p_referee_reward: 10,
  }) as { data: { id: string; code: string } | null; error: unknown };

  if (error || !result) {
    return NextResponse.json({ ok: false, error: "create_failed" }, { status: 500 });
  }

  // Update share_url on the newly created referral
  const shareUrl = `https://nailiq.ca/${slug}?ref=${result.code}`;
  await db.from("referrals").update({ share_url: shareUrl }).eq("id", result.id);

  return NextResponse.json({
    ok: true,
    code: result.code,
    share_url: shareUrl,
    referrer_reward: 10,
    referee_reward: 10,
    is_new: true,
  });
}
