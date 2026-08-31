import { describe, expect, it } from "vitest";

import {
  evaluateSmartCheckoutReadiness,
  quoteSmartCheckout,
} from "@/shared/checkout/smartCheckout";

describe("Smart Checkout canonical quote", () => {
  it("calculates service, add-on, discount, tax, tip, and deposit credit once", () => {
    const result = quoteSmartCheckout({
      currency: "cad",
      items: [
        { id: "service-1", label: "Classic", kind: "service", quantity: 1, unitAmountCents: 6000 },
        { id: "addon-1", label: "Extra massage", kind: "addon", quantity: 1, unitAmountCents: 1500 },
      ],
      discountCents: 500,
      taxCents: 350,
      tipCents: 1000,
      depositPaidCents: 2000,
    });

    expect(result).toEqual({
      ok: true,
      quote: expect.objectContaining({
        currency: "CAD",
        subtotalCents: 7500,
        discountCents: 500,
        taxCents: 350,
        tipCents: 1000,
        depositCreditCents: 2000,
        amountDueCents: 6350,
        lineCount: 2,
      }),
    });
  });

  it("never silently turns excess deposit into tip", () => {
    const result = quoteSmartCheckout({
      currency: "USD",
      items: [{ id: "s", label: "Service", kind: "service", quantity: 1, unitAmountCents: 1000 }],
      tipCents: 300,
      depositPaidCents: 2000,
    });
    expect(result).toEqual({
      ok: true,
      quote: expect.objectContaining({ depositCreditCents: 1000, amountDueCents: 300 }),
    });
  });

  it("rejects negative money, invalid lines, and over-discounting", () => {
    expect(quoteSmartCheckout({ currency: "USD", items: [] })).toEqual({ ok: false, error: "empty_cart" });
    expect(quoteSmartCheckout({
      currency: "USD",
      items: [{ id: "s", label: "Service", kind: "service", quantity: 1, unitAmountCents: 1000 }],
      tipCents: -1,
    })).toEqual({ ok: false, error: "invalid_amount" });
    expect(quoteSmartCheckout({
      currency: "USD",
      items: [{ id: "s", label: "Service", kind: "service", quantity: 1, unitAmountCents: 1000 }],
      discountCents: 1001,
    })).toEqual({ ok: false, error: "discount_exceeds_subtotal" });
  });
});

describe("Smart Checkout readiness", () => {
  it("stays fail-closed until every money and device gate is proven", () => {
    expect(evaluateSmartCheckoutReadiness({
      selectedProvider: "stripe",
      providerConnected: true,
      payoutsReady: true,
      webhooksReady: false,
      deviceReady: false,
      dispatchEnabled: false,
    })).toEqual({
      readyForSimulation: true,
      readyForLiveMoney: false,
      blockers: ["webhooks_not_ready", "device_not_ready", "dispatch_disabled"],
    });
  });

  it("reports live-ready only when all evidence gates pass", () => {
    expect(evaluateSmartCheckoutReadiness({
      selectedProvider: "square",
      providerConnected: true,
      payoutsReady: true,
      webhooksReady: true,
      deviceReady: true,
      dispatchEnabled: true,
    }).readyForLiveMoney).toBe(true);
  });
});

