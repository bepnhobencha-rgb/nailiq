import { describe, expect, it } from "vitest";

import type { SmartCheckoutDispatchInput } from "@/shared/checkout/smartCheckoutAdapter";
import {
  buildSquareTerminalCheckoutRequest,
  buildStripeTerminalPaymentIntentRequest,
} from "@/shared/checkout/smartCheckoutProviderMapping";

const input: SmartCheckoutDispatchInput = {
  operationId: "op-1",
  bookingId: "booking-1",
  salonId: "salon-1",
  amountCents: 6350,
  currency: "CAD",
  providerAccountId: "connected-account",
  providerLocationId: "location-1",
  providerDeviceId: "device-1",
  tender: "terminal",
  idempotencyKey: "smart-checkout-op-1-v1",
  referenceId: "NQ-1001",
};

describe("Smart Checkout provider request mapping", () => {
  it("maps the same exact amount and idempotency key to Square Terminal", () => {
    expect(buildSquareTerminalCheckoutRequest(input)).toEqual({
      idempotency_key: "smart-checkout-op-1-v1",
      checkout: {
        amount_money: { amount: 6350, currency: "CAD" },
        device_options: { device_id: "device-1" },
        reference_id: "NQ-1001",
        note: "NailIQ booking booking-1",
      },
    });
  });

  it("maps card-present Stripe metadata without leaking provider credentials", () => {
    expect(buildStripeTerminalPaymentIntentRequest(input)).toEqual({
      amount: 6350,
      currency: "cad",
      payment_method_types: ["card_present"],
      metadata: {
        nailiq_operation_id: "op-1",
        nailiq_booking_id: "booking-1",
        nailiq_salon_id: "salon-1",
        nailiq_reference_id: "NQ-1001",
      },
    });
  });

  it("fails closed when no registered device is selected", () => {
    expect(() =>
      buildSquareTerminalCheckoutRequest({ ...input, providerDeviceId: null }),
    ).toThrow("smart_checkout_device_required");
    expect(() =>
      buildStripeTerminalPaymentIntentRequest({
        ...input,
        providerDeviceId: " ",
      }),
    ).toThrow("smart_checkout_device_required");
  });
});
