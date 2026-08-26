import type { PublicBookingPricingQuote } from "@/shared/booking/publicBookingPricing";
import type { GroupBookingPricingQuote } from "@/shared/booking/groupBookingPricing";

export type VoicePendingPricing = {
  pricing_fingerprint: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  discount_lines: { label: string; amount_cents: number }[];
};

function normalizeConsent(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fail-closed approval check over the trusted phone-bridge utterance. */
export function isClearVoicePricingConfirmation(value: string | null): boolean {
  if (!value) return false;
  const text = normalizeConsent(value);
  if (!text) return false;
  if (/\b(no|not|dont|wait|maybe|stop|khong|khoan|thoi|chua)\b/.test(text)) {
    return false;
  }
  return /^(yes|yeah|yep|sure|ok|okay|confirm|go ahead|book it|please book it|da|vang|dong y|duoc|uh|xac nhan|dat di|dat luon)(\b|$)/.test(text);
}

export function toVoicePendingPricing(
  quote: PublicBookingPricingQuote,
): VoicePendingPricing {
  return {
    pricing_fingerprint: quote.pricingFingerprint,
    currency: quote.currency,
    subtotal_cents: quote.subtotalCents,
    tax_cents: quote.taxCents,
    total_cents: quote.totalCents,
    discount_lines: quote.discountLines.map((line) => ({
      label: line.label,
      amount_cents: line.amountCents,
    })),
  };
}

export function toVoicePendingGroupPricing(
  quote: GroupBookingPricingQuote,
): VoicePendingPricing {
  return {
    pricing_fingerprint: quote.pricingFingerprint,
    currency: quote.currency,
    subtotal_cents: quote.subtotalCents,
    tax_cents: quote.taxCents,
    total_cents: quote.totalCents,
    discount_lines: quote.discountLines.map((line) => ({
      label: line.label,
      amount_cents: line.amountCents,
    })),
  };
}
