"use server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import type { GiftCard } from "./types";

export async function createGiftCard(
  slug: string,
  input: {
    valueCents: number;
    fromName?: string;
    message?: string;
    purchaserPhone?: string;
    recipientPhone?: string;
  },
): Promise<{ ok: boolean; error?: string; voucher?: GiftCard }> {
  void slug;
  void input;
  // Retired permanently: flipping a boolean must never recreate local
  // spendable value or an invented expiry. A future dashboard action must
  // consume the durable paid Square issuance receipt chain instead.
  return { ok: false, error: "gift_card_issuance_unavailable" };
}

export async function getGiftCard(_code: string): Promise<GiftCard | null> {
  void _code;
  // A gift-card code is a bearer secret, not authorization to return the
  // voucher row (which also contains tenant, purchaser and recipient data).
  // Restore only behind a bounded, single-use tenant capability that returns a
  // deliberately minimal balance/status projection.
  return null;
}

export async function redeemGiftCard(
  slug: string,
  code: string,
  bookingId?: string,
): Promise<{ ok: boolean; error?: string; discountCents?: number }> {
  void slug;
  void code;
  void bookingId;
  // Legacy NailIQ voucher redemption is not Square Gift Card redemption and
  // cannot be revived by a configuration flip.
  return { ok: false, error: "gift_card_redemption_unavailable" };
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
