"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import type { GiftCard } from "./types";

function generateGiftCode(): string {
  const hex = crypto.randomUUID().replace(/-/g, "").toUpperCase();
  return `GFT-${hex.slice(0, 4)}${hex.slice(4, 8)}`;
}

export async function createGiftCard(
  slug: string,
  input: {
    valueCents: number;
    fromName?: string;
    message?: string;
    purchaserPhone?: string;
    recipientPhone?: string;
    expiryDays?: number;
  },
): Promise<{ ok: boolean; error?: string; voucher?: GiftCard }> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };

  if (input.valueCents < 100 || input.valueCents > 100_000_00) {
    return { ok: false, error: "invalid_value" };
  }

  const supabase = createServiceRoleClient();
  const salonId = resolved.salon.id;
  const code = generateGiftCode();
  const expiryDays = input.expiryDays ?? 365;
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();

  const patch = {
    salon_id: salonId,
    code,
    kind: "gift",
    amount_off_cents: input.valueCents,
    gift_card_value_cents: input.valueCents,
    gift_card_from_name: input.fromName?.trim() || null,
    gift_card_message: input.message?.trim() || null,
    gift_card_purchaser_phone: input.purchaserPhone?.trim() || null,
    client_phone: input.recipientPhone?.trim() || null,
    expires_at: expiresAt,
    max_uses: 1,
    valid_from: new Date().toISOString(),
  };

  const { data, error: dbErr } = await supabase
    .from("vouchers" as never)
    .insert(patch)
    .select()
    .maybeSingle();

  if (dbErr || !data) {
    console.error("[createGiftCard]", dbErr);
    return { ok: false, error: "server_error" };
  }

  return { ok: true, voucher: data as GiftCard };
}

export async function getGiftCard(code: string): Promise<GiftCard | null> {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("vouchers" as never)
    .select("*")
    .eq("code", code.trim().toUpperCase())
    .eq("kind", "gift")
    .maybeSingle();
  return (data as GiftCard | null) ?? null;
}

export async function redeemGiftCard(
  slug: string,
  code: string,
  bookingId?: string,
): Promise<{ ok: boolean; error?: string; discountCents?: number }> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };

  const supabase = createServiceRoleClient();
  const { data: voucher } = await supabase
    .from("vouchers" as never)
    .select("*")
    .eq("code", code.trim().toUpperCase())
    .eq("kind", "gift")
    .eq("salon_id", resolved.salon.id)
    .maybeSingle();

  const v = voucher as GiftCard | null;
  if (!v) return { ok: false, error: "not_found" };
  if (v.revoked_at) return { ok: false, error: "revoked" };
  if (v.used_count >= v.max_uses) return { ok: false, error: "already_used" };
  if (new Date(v.expires_at) < new Date()) return { ok: false, error: "expired" };

  const discountCents = v.amount_off_cents ?? v.gift_card_value_cents ?? 0;

  await supabase
    .from("vouchers" as never)
    .update({ used_count: v.used_count + 1, updated_at: new Date().toISOString() })
    .eq("id", v.id);

  void supabase
    .from("voucher_redemptions" as never)
    .insert({
      voucher_id: v.id,
      salon_id: resolved.salon.id,
      booking_id: bookingId ?? null,
      discount_applied_cents: discountCents,
    });

  return { ok: true, discountCents };
}

export async function listGiftCards(
  slug: string,
  limit = 20,
): Promise<GiftCard[]> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return [];

  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("vouchers" as never)
    .select("*")
    .eq("salon_id", resolved.salon.id)
    .eq("kind", "gift")
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data as GiftCard[]) ?? [];
}
