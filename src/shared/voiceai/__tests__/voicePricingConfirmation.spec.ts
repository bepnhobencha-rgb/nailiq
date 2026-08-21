import { describe, expect, it } from "vitest";
import type { PublicBookingPricingQuote } from "@/shared/booking/publicBookingPricing";
import {
  isClearVoicePricingConfirmation,
  toVoicePendingPricing,
} from "@/shared/voiceai/voicePricingConfirmation";

describe("voice price confirmation gate", () => {
  it("accepts only clear affirmative trusted utterances", () => {
    expect(isClearVoicePricingConfirmation("Yes, please book it")).toBe(true);
    expect(isClearVoicePricingConfirmation("Dạ được ạ")).toBe(true);
    expect(isClearVoicePricingConfirmation("maybe later")).toBe(false);
    expect(isClearVoicePricingConfirmation("yes, but wait")).toBe(false);
    expect(isClearVoicePricingConfirmation(null)).toBe(false);
  });

  it("returns only the sanitized receipt material needed for readback", () => {
    const pending = toVoicePendingPricing({
      pricingFingerprint: "a".repeat(64),
      currency: "CAD",
      subtotalCents: 9_500,
      taxCents: 475,
      totalCents: 9_975,
      discountLines: [{ kind: "voucher", label: "Voucher", amountCents: 500 }],
    } as PublicBookingPricingQuote);
    expect(pending).toEqual({
      pricing_fingerprint: "a".repeat(64),
      currency: "CAD",
      subtotal_cents: 9_500,
      tax_cents: 475,
      total_cents: 9_975,
      discount_lines: [{ label: "Voucher", amount_cents: 500 }],
    });
    expect(pending).not.toHaveProperty("salonId");
    expect(pending).not.toHaveProperty("clientPhone");
  });
});
