import { describe, expect, it, vi } from "vitest";

import type { SmartCheckoutDispatchInput } from "@/shared/checkout/smartCheckoutAdapter";
import {
  createSquareTerminalSandboxAdapter,
  createStripeTerminalSandboxAdapter,
  mapSquareTerminalSandboxStatus,
  mapStripeTerminalSandboxStatus,
  SmartCheckoutSandboxAdapterError,
  type SquareTerminalSandboxTransport,
  type StripeTerminalSandboxTransport,
} from "@/shared/checkout/smartCheckoutSandboxAdapters";

const dispatch: SmartCheckoutDispatchInput = {
  operationId: "op-1",
  bookingId: "booking-1",
  salonId: "salon-1",
  amountCents: 6350,
  currency: "CAD",
  providerAccountId: "account-1",
  providerLocationId: "location-1",
  providerDeviceId: "device-1",
  tender: "terminal",
  idempotencyKey: "smart-checkout-op-1-v1",
  referenceId: "NQ-1001",
};

const enabledGate = {
  environment: "sandbox",
  sandboxDispatchEnabled: true,
  sandboxProviderReadsEnabled: true,
} as const;

const squareEvidence = {
  amountCents: 6350,
  currency: "CAD",
  providerAccountId: "account-1",
  providerLocationId: "location-1",
  providerDeviceId: "device-1",
  occurredAt: "2026-08-31T17:00:00Z",
};

const stripeEvidence = {
  amountCents: 6350,
  currency: "cad",
  providerAccountId: "account-1",
  providerLocationId: null,
  providerDeviceId: "device-1",
  occurredAt: "2026-08-31T17:00:00Z",
};

function squareTransport(
  overrides: Partial<SquareTerminalSandboxTransport> = {},
): SquareTerminalSandboxTransport {
  return {
    createTerminalCheckout: vi.fn(async () => ({
      kind: "response" as const,
      response: { id: "sq-checkout-1", status: "PENDING", paymentIds: [], ...squareEvidence },
    })),
    retrieveTerminalCheckout: vi.fn(async () => ({
      kind: "response" as const,
      response: {
        id: "sq-checkout-1",
        status: "COMPLETED",
        paymentIds: ["sq-payment-1"],
        ...squareEvidence,
      },
    })),
    cancelTerminalCheckout: vi.fn(async () => ({
      kind: "response" as const,
      response: { id: "sq-checkout-1", status: "CANCELED", paymentIds: [], ...squareEvidence },
    })),
    ...overrides,
  };
}

function stripeTransport(
  overrides: Partial<StripeTerminalSandboxTransport> = {},
): StripeTerminalSandboxTransport {
  return {
    createPaymentIntent: vi.fn(async () => ({
      kind: "response" as const,
      response: {
        id: "pi_1",
        status: "requires_payment_method",
        latestChargeId: null,
        ...stripeEvidence,
      },
    })),
    processPaymentIntent: vi.fn(async () => ({
      kind: "response" as const,
      response: { id: "pi_1", status: "processing", latestChargeId: null, ...stripeEvidence },
    })),
    retrievePaymentIntent: vi.fn(async () => ({
      kind: "response" as const,
      response: { id: "pi_1", status: "succeeded", latestChargeId: "ch_1", ...stripeEvidence },
    })),
    cancelPaymentIntent: vi.fn(async () => ({
      kind: "response" as const,
      response: { id: "pi_1", status: "canceled", latestChargeId: null, ...stripeEvidence },
    })),
    ...overrides,
  };
}

describe("Smart Checkout sandbox runtime gate", () => {
  it.each([
    [{ environment: "production", sandboxDispatchEnabled: true, sandboxProviderReadsEnabled: true } as const, "smart_checkout_sandbox_only"],
    [{ environment: "sandbox", sandboxDispatchEnabled: false, sandboxProviderReadsEnabled: true } as const, "smart_checkout_sandbox_disabled"],
  ])("fails before touching the transport for %o", async (gate, code) => {
    const transport = squareTransport();
    const adapter = createSquareTerminalSandboxAdapter({ gate, transport });

    await expect(adapter.createCheckout(dispatch)).rejects.toMatchObject({ code });
    expect(transport.createTerminalCheckout).not.toHaveBeenCalled();
  });

  it("allows reconciliation reads while payment dispatch stays off", async () => {
    const transport = squareTransport();
    const adapter = createSquareTerminalSandboxAdapter({
      gate: {
        environment: "sandbox",
        sandboxDispatchEnabled: false,
        sandboxProviderReadsEnabled: true,
      },
      transport,
    });
    await expect(adapter.createCheckout(dispatch)).rejects.toMatchObject({
      code: "smart_checkout_sandbox_disabled",
    });
    await expect(adapter.retrieveCheckout({
      checkoutId: "sq-checkout-1",
      providerAccountId: "account-1",
      providerLocationId: "location-1",
    })).resolves.toMatchObject({ status: "paid" });
    expect(transport.createTerminalCheckout).not.toHaveBeenCalled();
    expect(transport.retrieveTerminalCheckout).toHaveBeenCalledTimes(1);
  });
});

describe("Square Terminal sandbox adapter", () => {
  it("maps create, retrieve, and cancel without exposing provider credentials", async () => {
    const transport = squareTransport();
    const adapter = createSquareTerminalSandboxAdapter({ gate: enabledGate, transport });

    await expect(adapter.createCheckout(dispatch)).resolves.toMatchObject({
      provider: "square",
      checkoutId: "sq-checkout-1",
      providerStatus: "PENDING",
      status: "awaiting_customer",
      evidence: squareEvidence,
    });
    expect(transport.createTerminalCheckout).toHaveBeenCalledWith({
      providerAccountId: "account-1",
      providerLocationId: "location-1",
      request: expect.objectContaining({ idempotency_key: "smart-checkout-op-1-v1" }),
    });

    await expect(adapter.retrieveCheckout({
      checkoutId: "sq-checkout-1",
      providerAccountId: "account-1",
      providerLocationId: "location-1",
    })).resolves.toMatchObject({ status: "paid", paymentId: "sq-payment-1" });

    await expect(adapter.cancelCheckout({
      checkoutId: "sq-checkout-1",
      providerAccountId: "account-1",
      providerLocationId: "location-1",
      idempotencyKey: "cancel-1",
    })).resolves.toMatchObject({ status: "cancelled", providerStatus: "CANCELED" });
  });

  it("never marks COMPLETED paid without a payment receipt", () => {
    expect(mapSquareTerminalSandboxStatus({
      id: "sq-checkout-1",
      status: "COMPLETED",
      paymentIds: [],
      ...squareEvidence,
    }).status).toBe("outcome_unknown");
  });
});

describe("Stripe Terminal sandbox adapter", () => {
  it("creates then processes one PaymentIntent on the selected reader", async () => {
    const transport = stripeTransport();
    const adapter = createStripeTerminalSandboxAdapter({ gate: enabledGate, transport });

    await expect(adapter.createCheckout(dispatch)).resolves.toMatchObject({
      provider: "stripe",
      checkoutId: "pi_1",
      providerStatus: "processing",
      status: "pending_provider",
    });
    expect(transport.createPaymentIntent).toHaveBeenCalledWith(expect.objectContaining({
      providerAccountId: "account-1",
      idempotencyKey: "smart-checkout-op-1-v1",
    }));
    expect(transport.processPaymentIntent).toHaveBeenCalledWith({
      providerAccountId: "account-1",
      readerId: "device-1",
      paymentIntentId: "pi_1",
      idempotencyKey: "smart-checkout-op-1-v1",
    });

    await expect(adapter.retrieveCheckout({
      checkoutId: "pi_1",
      providerAccountId: "account-1",
      providerLocationId: null,
    })).resolves.toMatchObject({ status: "paid", paymentId: "ch_1" });
  });

  it("never marks succeeded paid without an authoritative charge", () => {
    expect(mapStripeTerminalSandboxStatus({
      id: "pi_1",
      status: "succeeded",
      latestChargeId: null,
      ...stripeEvidence,
    }).status).toBe("outcome_unknown");
  });
});

describe("sandbox transport ambiguity", () => {
  it("returns outcome_unknown only when the fake supplies a reconcilable checkout id", async () => {
    const adapter = createSquareTerminalSandboxAdapter({
      gate: enabledGate,
      transport: squareTransport({
        createTerminalCheckout: vi.fn(async () => ({
          kind: "ambiguous" as const,
          checkoutId: "sq-checkout-ambiguous",
          paymentId: null,
          providerStatus: "transport_response_lost",
          evidence: squareEvidence,
        })),
      }),
    });

    await expect(adapter.createCheckout(dispatch)).resolves.toEqual({
      provider: "square",
      checkoutId: "sq-checkout-ambiguous",
      paymentId: null,
      providerStatus: "transport_response_lost",
      evidence: squareEvidence,
      status: "outcome_unknown",
    });
  });

  it("converts thrown transport details into a safe code only", async () => {
    const adapter = createStripeTerminalSandboxAdapter({
      gate: enabledGate,
      transport: stripeTransport({
        createPaymentIntent: vi.fn(async () => {
          throw new Error("sk_test_do_not_leak raw provider body");
        }),
      }),
    });

    const error = await adapter.createCheckout(dispatch).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SmartCheckoutSandboxAdapterError);
    expect(error).toMatchObject({ code: "smart_checkout_transport_outcome_unknown" });
    expect(String(error)).not.toContain("sk_test_do_not_leak");
  });

  it("keeps a known checkout reconcilable when a retrieve response is lost", async () => {
    const adapter = createSquareTerminalSandboxAdapter({
      gate: enabledGate,
      transport: squareTransport({
        retrieveTerminalCheckout: vi.fn(async () => {
          throw new Error("raw provider response must not escape");
        }),
      }),
    });

    await expect(adapter.retrieveCheckout({
      checkoutId: "sq-known-1",
      providerAccountId: "account-1",
      providerLocationId: "location-1",
    })).resolves.toMatchObject({
      checkoutId: "sq-known-1",
      providerStatus: "transport_response_lost",
      status: "outcome_unknown",
    });
  });

  it("keeps the created Stripe PaymentIntent reconcilable when reader processing is ambiguous", async () => {
    const adapter = createStripeTerminalSandboxAdapter({
      gate: enabledGate,
      transport: stripeTransport({
        processPaymentIntent: vi.fn(async () => {
          throw new Error("reader timeout with provider detail");
        }),
      }),
    });

    await expect(adapter.createCheckout(dispatch)).resolves.toMatchObject({
      checkoutId: "pi_1",
      providerStatus: "transport_response_lost",
      status: "outcome_unknown",
    });
  });
});

describe("provider status parsers", () => {
  it.each([
    ["PENDING", "awaiting_customer"],
    ["IN_PROGRESS", "awaiting_customer"],
    ["CANCEL_REQUESTED", "pending_provider"],
    ["CANCELED", "cancelled"],
    ["UNRECOGNIZED", "outcome_unknown"],
  ])("maps Square %s to %s", (providerStatus, status) => {
    expect(mapSquareTerminalSandboxStatus({
      id: "sq-1",
      status: providerStatus,
      paymentIds: [],
      ...squareEvidence,
    }).status).toBe(status);
  });

  it.each([
    ["requires_payment_method", "awaiting_customer"],
    ["requires_confirmation", "awaiting_customer"],
    ["requires_action", "awaiting_customer"],
    ["processing", "pending_provider"],
    ["requires_capture", "pending_provider"],
    ["canceled", "cancelled"],
    ["unrecognized", "outcome_unknown"],
  ])("maps Stripe %s to %s", (providerStatus, status) => {
    expect(mapStripeTerminalSandboxStatus({
      id: "pi_1",
      status: providerStatus,
      latestChargeId: null,
      ...stripeEvidence,
    }).status).toBe(status);
  });
});
