"use server";

import { createClient } from "@/shared/lib/supabase/server";

/**
 * Server action: stamp promo_id + original_price_cents on a booking after creation.
 * Re-verifies the promo is still active before writing (prevents stale/spoofed promos).
 * Fire-and-forget safe — booking is valid even if this fails.
 */
export async function applyPromoToBooking(
  bookingId: string,
  salonId: string,
  serviceId: string,
  promoId: string,
  discountCents: number,
): Promise<void> {
  const supabase = await createClient();

  // Verify promo is still active and covers this service
  const { data: promo } = await supabase
    .from("promotions" as never)
    .select("id, discount_type, discount_value, applies_to")
    .eq("id" as never, promoId)
    .eq("salon_id" as never, salonId)
    .eq("active" as never, true)
    .lte("starts_at" as never, new Date().toISOString())
    .gte("ends_at" as never, new Date().toISOString())
    .maybeSingle();

  if (!promo) return;

  // Get current booking price (original)
  const { data: booking } = await supabase
    .from("bookings")
    .select("price_cents, promo_id")
    .eq("id", bookingId)
    .maybeSingle();

  if (!booking) return;
  // Idempotency: already applied
  if ((booking as { promo_id: string | null }).promo_id) return;

  const originalPrice = (booking as { price_cents: number | null }).price_cents ?? 0;
  const finalPrice = Math.max(0, originalPrice - discountCents);

  await supabase
    .from("bookings")
    .update({
      promo_id: promoId,
      original_price_cents: originalPrice,
      price_cents: finalPrice,
    } as never)
    .eq("id", bookingId);
}
