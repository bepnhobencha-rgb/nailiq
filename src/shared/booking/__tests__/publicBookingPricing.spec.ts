import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildPublicBookingPricingQuoteKey,
  parsePublicBookingPricingQuote,
} from "@/shared/booking/publicBookingPricing";

const rawQuote = {
  success: true,
  pricing_fingerprint: "a".repeat(64),
  salon_id: "11111111-1111-4111-8111-111111111111",
  service_id: "22222222-2222-4222-8222-222222222222",
  start_time_utc: "2026-08-21T17:00:00.000Z",
  end_time_utc: "2026-08-21T18:00:00.000Z",
  combo_id: null,
  voucher_id: "33333333-3333-4333-8333-333333333333",
  currency: "CAD",
  original_price_cents: 10_000,
  service_pre_voucher_cents: 8_800,
  price_cents: 8_300,
  addon_pre_voucher_cents: 1_200,
  addon_price_cents: 1_200,
  promo_id: "44444444-4444-4444-8444-444444444444",
  promo_name: "Summer",
  promo_discount_cents: 1_000,
  email_discount_cents: 200,
  voucher_discount_cents: 500,
  pre_voucher_subtotal_cents: 10_000,
  subtotal_cents: 9_500,
  tax_cents: 475,
  total_cents: 9_975,
  tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: 475 }],
  addon_lines: [{
    service_id: "55555555-5555-4555-8555-555555555555",
    name: "Art",
    price_cents: 1_200,
    duration_minutes: 15,
    buffer_minutes: 0,
    addon_timing: "sequential",
  }],
};

describe("public booking authoritative pricing", () => {
  it("accepts one reconciled server receipt and derives discount lines", () => {
    const quote = parsePublicBookingPricingQuote(rawQuote, {
      resolvedStaffId: "66666666-6666-4666-8666-666666666666",
      resolvedStaffName: "Mai",
      voucherCode: "SAVE5",
    });
    expect(quote).not.toBeNull();
    expect(quote?.totalCents).toBe(9_975);
    expect(quote?.discountLines.map((line) => line.kind)).toEqual([
      "promotion",
      "email_incentive",
      "voucher",
    ]);
  });

  it("fails closed when any arithmetic is inconsistent", () => {
    expect(parsePublicBookingPricingQuote(
      { ...rawQuote, total_cents: 9_974 },
      { resolvedStaffId: "66666666-6666-4666-8666-666666666666" },
    )).toBeNull();
  });

  it("invalidates the browser quote for every material input", () => {
    const base = {
      shopSlug: "salon",
      serviceId: "service-a",
      staffId: "staff-a",
      bookingDateYmd: "2026-08-21",
      timeSlot: "2:00 PM",
      clientPhone: "16045551234",
      clientEmail: "a@example.com",
      addonServiceIds: ["addon-a"],
      comboId: "combo-a",
      voucherCode: "SAVE",
      applyEmailDiscount: true,
    };
    const original = buildPublicBookingPricingQuoteKey(base);
    const mutations = [
      { shopSlug: "other" }, { serviceId: "service-b" }, { staffId: "staff-b" },
      { bookingDateYmd: "2026-08-22" }, { timeSlot: "3:00 PM" },
      { clientPhone: "16045550000" }, { clientEmail: null },
      { addonServiceIds: ["addon-b"] }, { comboId: null },
      { voucherCode: null }, { applyEmailDiscount: false },
    ];
    for (const mutation of mutations) {
      expect(buildPublicBookingPricingQuoteKey({ ...base, ...mutation })).not.toBe(original);
    }
  });

  it("keeps confirm/create/done on the authoritative path", () => {
    const submit = readFileSync("src/shared/booking/submitPublicBooking.ts", "utf8");
    const confirm = readFileSync("src/components/booking/BookingFlowConfirmPanel.tsx", "utf8");
    const done = readFileSync("src/components/booking/BookingFlowDonePanel.tsx", "utf8");
    const voice = readFileSync("src/shared/voiceai/toolExecutor.ts", "utf8");
    const receptionist = readFileSync(
      "src/shared/dashboard/receptionistActions.ts",
      "utf8",
    );
    const quoteRoute = readFileSync("src/app/api/booking/quote/route.ts", "utf8");
    const flowState = readFileSync("src/components/booking/useBookingFlowState.ts", "utf8");
    expect(submit).toContain("p_expected_pricing_fingerprint");
    expect(submit).toContain("BookingPricingChangedError");
    expect(submit).not.toContain("Older create_public_booking returning");
    expect(confirm).not.toContain("computeTax");
    expect(confirm).toContain("pricingQuote.totalCents");
    expect(done).toContain("pricing.totalCents");
    expect(done).toContain("formatBookingPrice(a.priceCents, pricing.currency)");
    expect(done).not.toContain("formatBookingPrice(a.priceCents, currency)");
    expect(voice).toContain("resolve_public_booking_pricing");
    expect(voice).toContain("voiceBookingLogicalIdempotencyKey");
    expect(voice).toContain("p_expected_pricing_fingerprint");
    expect(voice).toContain("confirmed_pricing_fingerprint");
    const normalDeskCreate = receptionist.slice(
      receptionist.indexOf("} else if (!recovery)"),
      receptionist.indexOf("} else {", receptionist.indexOf("} else if (!recovery)")),
    );
    expect(normalDeskCreate).toContain('"quote_public_booking"');
    expect(normalDeskCreate).toContain("p_addon_service_ids: addonIds");
    expect(normalDeskCreate).toContain("p_expected_pricing_fingerprint");
    expect(normalDeskCreate).not.toContain("p_price_cents");
    expect(quoteRoute).toContain("publicBookingQuoteRequestSchema.safeParse");
    expect(quoteRoute).toContain("rateLimitAllowed");
    expect(quoteRoute).toContain("quote_unavailable");
    const voiceHandoff = flowState.slice(
      flowState.indexOf("const applyWebVoiceBookingHandoff"),
      flowState.indexOf("useEffect(() => {", flowState.indexOf("const applyWebVoiceBookingHandoff")),
    );
    expect(voiceHandoff).toContain('setStep("time")');
    expect(voiceHandoff).not.toContain("submitPublicBooking(");
    expect(voiceHandoff).not.toContain("quotePublicBooking(");
    const voiceSlotHandoff = flowState.slice(
      flowState.indexOf("const requested = pendingWebVoiceTimeSlotRef.current"),
      flowState.indexOf("const pricingQuoteRequest"),
    );
    expect(voiceSlotHandoff).toContain('setStep("verify")');
    expect(voiceSlotHandoff).not.toContain("submitPublicBooking(");
    expect(voiceSlotHandoff).not.toContain("quotePublicBooking(");
    expect(flowState).toContain("stablePublicBookingRequestId(bookingRequestMaterial)");
    expect(flowState).toContain("acknowledgePublicBookingRequestId(");
    expect(submit).toContain("svcPriceCents: authoritativePricing.subtotalCents");
    expect(submit).toContain("totalPriceCents: authoritativePricing.totalCents");
  });

  it("rehearses abuse throttling and a stored two-sequential-addon block", () => {
    const migration = readFileSync(
      "supabase/migrations/20260820083748_authorize_public_booking_pricing.sql",
      "utf8",
    );
    const rehearsal = readFileSync(
      "scripts/security/rehearse-public-booking-pricing.sql",
      "utf8",
    );
    expect(migration).toContain("public-booking-pricing-attempt:phone:");
    expect(migration).toContain(
      "v_promo_discount := coalesce(v_promo_discount, 0);",
    );
    expect(migration.indexOf("public-booking-pricing-attempt:phone:")).toBeLessThan(
      migration.indexOf("v_quote := public.resolve_public_booking_pricing", migration.indexOf("CREATE OR REPLACE FUNCTION public.create_public_booking(")),
    );
    expect(rehearsal).toContain("ARRAY[v_addon_two, v_addon_three]");
    expect(rehearsal).toContain("v_multi_end := v_multi_start + interval '80 minutes'");
    expect(rehearsal).toContain("v_result ? 'quote'");
  });
});
