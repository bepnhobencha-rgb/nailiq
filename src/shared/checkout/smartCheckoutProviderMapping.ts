import type { SmartCheckoutDispatchInput } from "@/shared/checkout/smartCheckoutAdapter";

export type SquareTerminalCheckoutRequest = {
  idempotency_key: string;
  checkout: {
    amount_money: { amount: number; currency: string };
    device_options: { device_id: string };
    reference_id: string;
    note: string;
  };
};

export type StripeTerminalPaymentIntentRequest = {
  amount: number;
  currency: string;
  payment_method_types: ["card_present"];
  metadata: {
    nailiq_operation_id: string;
    nailiq_booking_id: string;
    nailiq_salon_id: string;
    nailiq_reference_id: string;
  };
};

function requireTerminalDevice(input: SmartCheckoutDispatchInput): string {
  const deviceId = input.providerDeviceId?.trim();
  if (!deviceId) throw new Error("smart_checkout_device_required");
  return deviceId;
}

/** Pure mapping only: it creates no checkout and performs no network call. */
export function buildSquareTerminalCheckoutRequest(
  input: SmartCheckoutDispatchInput,
): SquareTerminalCheckoutRequest {
  return {
    idempotency_key: input.idempotencyKey,
    checkout: {
      amount_money: {
        amount: input.amountCents,
        currency: input.currency.toUpperCase(),
      },
      device_options: { device_id: requireTerminalDevice(input) },
      reference_id: input.referenceId,
      note: `NailIQ booking ${input.bookingId}`,
    },
  };
}

/**
 * Pure Stripe mapping. The adapter must send this under the salon's connected
 * account and process it on a registered reader; this function never handles
 * API keys or performs a provider call.
 */
export function buildStripeTerminalPaymentIntentRequest(
  input: SmartCheckoutDispatchInput,
): StripeTerminalPaymentIntentRequest {
  requireTerminalDevice(input);
  return {
    amount: input.amountCents,
    currency: input.currency.toLowerCase(),
    payment_method_types: ["card_present"],
    metadata: {
      nailiq_operation_id: input.operationId,
      nailiq_booking_id: input.bookingId,
      nailiq_salon_id: input.salonId,
      nailiq_reference_id: input.referenceId,
    },
  };
}
