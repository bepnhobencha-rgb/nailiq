import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { SavedCard, PaymentProviderKind } from "@/shared/integrations/payments/types";
import type { buildNoShowConsentPolicy } from "@/shared/noshow/noShowConsentPolicy";

/** The caller has just read exactly one enabled, owned Square card and proved
 * current consent. This transaction records that read receipt and the booking
 * together. A lost DB reply can safely repeat a read; it never creates a card. */
export async function persistExistingSquareCardReceipt(input: {
  bookingId: string; salonId: string; provider: PaymentProviderKind; card: SavedCard;
  policy: ReturnType<typeof buildNoShowConsentPolicy>;
  source: "explicit_reuse" | "prior_matching_consent";
}): Promise<boolean> {
  const { card, policy } = input;
  // Stripe's legacy lookup does not supply this ownership receipt yet. Fresh
  // SetupIntent capture remains available through the secure recovery link.
  if (input.provider !== "square" || !card.binding || !policy.ready || !policy.version ||
      card.customerId !== card.binding.customerId) return false;
  try {
    const { data, error } = await createServiceRoleClient().rpc("record_booking_existing_square_card" as never, {
      p_booking_id:input.bookingId,p_salon_id:input.salonId,p_customer_id:card.customerId,p_card_id:card.cardId,
      p_merchant_id:card.binding.merchantId,p_environment:card.binding.environment,
      p_brand:card.brand,p_last4:card.last4,p_consent_meta:{ v:2,source:input.source,receiptSource:"existing_card_read",
        policyVersion:policy.version,feeCents:policy.feeCents,currency:policy.currency,scope:policy.scope,
        policyEn:policy.policyEn,policyVi:policy.policyVi },
    } as never);
    return !error && (data as { ok?: boolean } | null)?.ok === true;
  } catch { return false; }
}
