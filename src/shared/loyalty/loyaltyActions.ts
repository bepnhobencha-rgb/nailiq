"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { getEffectivePlan } from "@/shared/lib/subscriptionPlans";
import type { LoyaltyCard, LoyaltyProgram, LoyaltyStats } from "./types";

type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };

async function requirePremiumSalon(slug: string) {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { resolved: null, error: "unauthorized" as const };

  const supabase = createServiceRoleClient();
  const { data: salonRow } = await supabase
    .from("salons")
    .select("id, subscription_plan, plan_override, feature_flags")
    .eq("id", resolved.salon.id)
    .maybeSingle();

  if (!salonRow) return { resolved: null, error: "not_found" as const };

  const plan = getEffectivePlan({
    subscription_plan: (salonRow as { subscription_plan?: unknown }).subscription_plan as string | null,
    plan_override: (salonRow as { plan_override?: unknown }).plan_override as string | null,
    feature_flags: (salonRow as { feature_flags?: unknown }).feature_flags as Record<string, unknown> | null,
  });

  if (plan !== "premium") return { resolved: null, error: "upgrade_required" as const };

  return { resolved, error: null };
}

export async function getLoyaltyProgram(
  slug: string,
): Promise<LoyaltyProgram | null> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return null;

  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("loyalty_programs" as never)
    .select("*")
    .eq("salon_id", resolved.salon.id)
    .maybeSingle();

  return (data as LoyaltyProgram | null) ?? null;
}

export async function createOrUpdateLoyaltyProgram(
  slug: string,
  input: {
    name: string;
    is_active: boolean;
    stamps_required: number;
    reward_type: "free_service" | "percent_off" | "amount_off";
    reward_service_id?: string | null;
    reward_percent_off?: number | null;
    reward_amount_off_cents?: number | null;
    stamps_per_visit: number;
    min_spend_cents: number;
    description?: string | null;
    color: string;
  },
): Promise<{ ok: boolean; error?: string; program?: LoyaltyProgram }> {
  const { resolved, error } = await requirePremiumSalon(slug);
  if (!resolved) return { ok: false, error };

  const supabase = createServiceRoleClient();
  const salonId = resolved.salon.id;

  const patch = {
    salon_id: salonId,
    name: input.name.trim() || "Loyalty Rewards",
    is_active: input.is_active,
    stamps_required: Math.min(50, Math.max(3, input.stamps_required)),
    reward_type: input.reward_type,
    reward_service_id: input.reward_service_id ?? null,
    reward_percent_off: input.reward_percent_off ?? null,
    reward_amount_off_cents: input.reward_amount_off_cents ?? null,
    stamps_per_visit: Math.min(5, Math.max(1, input.stamps_per_visit)),
    min_spend_cents: Math.max(0, input.min_spend_cents),
    description: input.description?.trim() || null,
    color: /^#[0-9A-Fa-f]{6}$/.test(input.color) ? input.color : "#D4AF37",
  };

  const { data, error: dbErr } = await supabase
    .from("loyalty_programs" as never)
    .upsert(patch, { onConflict: "salon_id" })
    .select()
    .maybeSingle();

  if (dbErr) {
    console.error("[createOrUpdateLoyaltyProgram]", dbErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, program: data as unknown as LoyaltyProgram };
}

export async function getClientLoyaltyCard(
  slug: string,
  phone: string,
): Promise<LoyaltyCard | null> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return null;

  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("loyalty_cards" as never)
    .select("*")
    .eq("salon_id", resolved.salon.id)
    .eq("client_phone", phone)
    .maybeSingle();

  return (data as LoyaltyCard | null) ?? null;
}

export async function getClientLoyaltyCardByPhone(
  salonId: string,
  phone: string,
): Promise<{ card: LoyaltyCard | null; program: LoyaltyProgram | null }> {
  const supabase = createServiceRoleClient();

  const [{ data: program }, { data: card }] = await Promise.all([
    supabase
      .from("loyalty_programs" as never)
      .select("*")
      .eq("salon_id", salonId)
      .eq("is_active", true)
      .maybeSingle(),
    supabase
      .from("loyalty_cards" as never)
      .select("*")
      .eq("salon_id", salonId)
      .eq("client_phone", phone)
      .maybeSingle(),
  ]);

  return {
    program: (program as LoyaltyProgram | null) ?? null,
    card: (card as LoyaltyCard | null) ?? null,
  };
}

export async function addStampsManually(
  slug: string,
  phone: string,
  stamps: number,
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const { resolved, error } = await requirePremiumSalon(slug);
  if (!resolved) return { ok: false, error };

  if (stamps === 0 || Math.abs(stamps) > 20) return { ok: false, error: "invalid_stamps" };

  const supabase = createServiceRoleClient();
  const salonId = resolved.salon.id;

  const { data: program } = await supabase
    .from("loyalty_programs" as never)
    .select("id, stamps_required")
    .eq("salon_id", salonId)
    .eq("is_active", true)
    .maybeSingle();

  if (!program) return { ok: false, error: "no_program" };

  const { data: card } = await supabase
    .from("loyalty_cards" as never)
    .select("id, stamps_current")
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    .maybeSingle();

  if (!card) return { ok: false, error: "no_card" };

  const newStamps = Math.max(0, (card as { stamps_current: number }).stamps_current + stamps);

  const { error: upErr } = await supabase
    .from("loyalty_cards" as never)
    .update({ stamps_current: newStamps, updated_at: new Date().toISOString() })
    .eq("id", (card as { id: string }).id);

  if (upErr) return { ok: false, error: "server_error" };

  await supabase
    .from("loyalty_stamp_events" as never)
    .insert({
      salon_id: salonId,
      card_id: (card as { id: string }).id,
      event_type: stamps > 0 ? "manual_add" : "manual_remove",
      stamps_delta: stamps,
      stamps_after: newStamps,
      note: note ?? null,
    });

  return { ok: true };
}

export async function redeemReward(
  slug: string,
  phone: string,
): Promise<{ ok: boolean; error?: string; voucherId?: string; code?: string }> {
  const { resolved, error } = await requirePremiumSalon(slug);
  if (!resolved) return { ok: false, error };

  const supabase = createServiceRoleClient();
  const salonId = resolved.salon.id;

  const { data: program } = await supabase
    .from("loyalty_programs" as never)
    .select("*")
    .eq("salon_id", salonId)
    .eq("is_active", true)
    .maybeSingle();

  if (!program) return { ok: false, error: "no_program" };

  const { data: card } = await supabase
    .from("loyalty_cards" as never)
    .select("*")
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    .maybeSingle();

  const typedCard = card as LoyaltyCard | null;
  const typedProgram = program as LoyaltyProgram;

  if (!typedCard) return { ok: false, error: "no_card" };
  if (typedCard.rewards_earned <= typedCard.rewards_redeemed) {
    return { ok: false, error: "no_reward" };
  }

  const code = `LYL-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  const voucherPatch: Record<string, unknown> = {
    salon_id: salonId,
    code,
    kind: "promo",
    client_phone: phone,
    expires_at: expiresAt,
    max_uses: 1,
    valid_from: new Date().toISOString(),
  };

  if (typedProgram.reward_type === "percent_off" && typedProgram.reward_percent_off) {
    voucherPatch.percent_off = typedProgram.reward_percent_off;
  } else if (typedProgram.reward_type === "amount_off" && typedProgram.reward_amount_off_cents) {
    voucherPatch.amount_off_cents = typedProgram.reward_amount_off_cents;
  } else if (typedProgram.reward_type === "free_service" && typedProgram.reward_service_id) {
    voucherPatch.free_service_id = typedProgram.reward_service_id;
  }

  const { data: voucher, error: vErr } = await supabase
    .from("vouchers" as never)
    .insert(voucherPatch)
    .select("id")
    .maybeSingle();

  if (vErr || !voucher) {
    console.error("[redeemReward] voucher insert", vErr);
    return { ok: false, error: "server_error" };
  }

  await Promise.all([
    supabase
      .from("loyalty_cards" as never)
      .update({ rewards_redeemed: typedCard.rewards_redeemed + 1, updated_at: new Date().toISOString() })
      .eq("id", typedCard.id),
    supabase
      .from("loyalty_stamp_events" as never)
      .insert({
        salon_id: salonId,
        card_id: typedCard.id,
        event_type: "redeem",
        stamps_delta: 0,
        stamps_after: typedCard.stamps_current,
        note: `Voucher issued: ${code}`,
      }),
  ]);

  return { ok: true, voucherId: (voucher as { id: string }).id, code };
}

export async function getLoyaltyStats(
  slug: string,
): Promise<LoyaltyStats | null> {
  const { resolved, error } = await requirePremiumSalon(slug);
  if (!resolved || error) return null;

  const supabase = createServiceRoleClient();
  const salonId = resolved.salon.id;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    { count: totalCards },
    { count: activeCards },
    { count: stampsToday },
    { count: rewardsMonth },
  ] = await Promise.all([
    supabase.from("loyalty_cards" as never).select("id", { count: "exact", head: true }).eq("salon_id", salonId),
    supabase.from("loyalty_cards" as never).select("id", { count: "exact", head: true }).eq("salon_id", salonId).gt("stamps_lifetime", 0),
    supabase.from("loyalty_stamp_events" as never).select("id", { count: "exact", head: true }).eq("salon_id", salonId).eq("event_type", "earn").gte("created_at", todayStart.toISOString()),
    supabase.from("loyalty_stamp_events" as never).select("id", { count: "exact", head: true }).eq("salon_id", salonId).eq("event_type", "redeem").gte("created_at", monthStart.toISOString()),
  ]);

  return {
    totalCards: totalCards ?? 0,
    activeCards: activeCards ?? 0,
    stampsIssuedToday: stampsToday ?? 0,
    rewardsRedeemedThisMonth: rewardsMonth ?? 0,
  };
}

export async function issueLoyaltyVoucherIfEarned(
  salonId: string,
  clientPhone: string,
): Promise<{ issued: boolean; code?: string }> {
  if (!clientPhone) return { issued: false };

  const supabase = createServiceRoleClient();

  const { data: card } = await supabase
    .from("loyalty_cards" as never)
    .select("id, rewards_earned, rewards_redeemed, stamps_current")
    .eq("salon_id", salonId)
    .eq("client_phone", clientPhone)
    .maybeSingle();

  const typedCard = card as (LoyaltyCard & { stamps_current: number }) | null;
  if (!typedCard) return { issued: false };
  if (typedCard.rewards_earned <= typedCard.rewards_redeemed) return { issued: false };

  const { data: program } = await supabase
    .from("loyalty_programs" as never)
    .select("*")
    .eq("salon_id", salonId)
    .eq("is_active", true)
    .maybeSingle();

  if (!program) return { issued: false };
  const typedProgram = program as LoyaltyProgram;

  const code = `LYL-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  const voucherPatch: Record<string, unknown> = {
    salon_id: salonId,
    code,
    kind: "promo",
    client_phone: clientPhone,
    expires_at: expiresAt,
    max_uses: 1,
    valid_from: new Date().toISOString(),
  };

  if (typedProgram.reward_type === "percent_off" && typedProgram.reward_percent_off) {
    voucherPatch.percent_off = typedProgram.reward_percent_off;
  } else if (typedProgram.reward_type === "amount_off" && typedProgram.reward_amount_off_cents) {
    voucherPatch.amount_off_cents = typedProgram.reward_amount_off_cents;
  } else if (typedProgram.reward_type === "free_service" && typedProgram.reward_service_id) {
    voucherPatch.free_service_id = typedProgram.reward_service_id;
  }

  const { error: vErr } = await supabase
    .from("vouchers" as never)
    .insert(voucherPatch);

  if (vErr) {
    console.error("[issueLoyaltyVoucherIfEarned]", vErr);
    return { issued: false };
  }

  await supabase
    .from("loyalty_cards" as never)
    .update({ rewards_redeemed: typedCard.rewards_redeemed + 1, updated_at: new Date().toISOString() })
    .eq("id", typedCard.id);

  await supabase
    .from("loyalty_stamp_events" as never)
    .insert({
      salon_id: salonId,
      card_id: typedCard.id,
      event_type: "redeem",
      stamps_delta: 0,
      stamps_after: typedCard.stamps_current,
      note: `Auto-issued on reward: ${code}`,
    });

  return { issued: true, code };
}
