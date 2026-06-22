"use server";

import { createClient } from "@/shared/lib/supabase/server";

const EMAIL_DISCOUNT_CENTS = 200; // $2.00

/**
 * Server action: apply the one-time $2 email capture discount.
 * Stamps client_profiles.email_discount_claimed_at to prevent double-redemption.
 * Fire-and-forget safe.
 */
export async function applyEmailCaptureDiscount(
  bookingId: string,
  salonId: string,
  clientPhone: string,
): Promise<void> {
  const supabase = await createClient();

  // Check if already claimed (per phone/profile)
  const { data: profile } = await supabase
    .from("client_profiles")
    .select("id, email_discount_claimed_at")
    .eq("phone", clientPhone)
    .maybeSingle();

  if (!profile) return;
  if ((profile as { email_discount_claimed_at: string | null }).email_discount_claimed_at) return;

  // Get booking price
  const { data: booking } = await supabase
    .from("bookings")
    .select("price_cents, promo_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return;

  const currentPrice = (booking as { price_cents: number | null }).price_cents ?? 0;
  const finalPrice = Math.max(0, currentPrice - EMAIL_DISCOUNT_CENTS);
  const actualDiscount = currentPrice - finalPrice;
  if (actualDiscount <= 0) return;

  // Stamp claim (idempotent — concurrent writes just race to set same timestamp)
  await supabase
    .from("client_profiles")
    .update({ email_discount_claimed_at: new Date().toISOString() } as never)
    .eq("id", (profile as { id: string }).id);

  // Update booking price — stack on top of any promo already applied
  await supabase
    .from("bookings")
    .update({
      price_cents: finalPrice,
      // Preserve original_price_cents if a promo was already applied (M11 stacks)
      original_price_cents: (booking as { promo_id: string | null }).promo_id
        ? undefined
        : currentPrice,
    } as never)
    .eq("id", bookingId);
}
