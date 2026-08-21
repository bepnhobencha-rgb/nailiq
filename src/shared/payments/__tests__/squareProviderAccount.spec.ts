import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  charge: vi.fn(),
  refund: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/integrations/square/client", () => ({
  chargeSavedCard: mocks.charge,
  refundPayment: mocks.refund,
  ensureSquareCustomer: vi.fn(),
  saveCardOnFile: vi.fn(),
  disableCard: vi.fn(),
  findSquareCustomerByPhone: vi.fn(),
  listCards: vi.fn(),
}));

import { SquareProvider } from "@/shared/integrations/payments/square";

const config = {
  salonId: "11111111-1111-4111-8111-111111111111",
  merchantId: "merchant-current",
  locationId: "location-current",
  accessToken: "test-token",
  applicationId: "sandbox-app",
  environment: "sandbox" as const,
  currency: "CAD",
  sync: {
    pullCreate: false,
    pullUpdate: false,
    pullCancel: false,
    pushCreate: false,
    pushUpdate: false,
    pushCancel: false,
  },
};

describe("SquareProvider DB-bound account identity", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not dispatch a charge or refund after the salon merchant changed", async () => {
    const provider = new SquareProvider(config);
    await expect(provider.chargeSavedCard({
      customerId: "customer",
      cardId: "card",
      amountCents: 2_500,
      idempotencyKey: "nq:op",
      providerAccountId: "merchant-from-claim",
    })).rejects.toThrow("square_provider_account_mismatch");
    await expect(provider.refund({
      paymentId: "payment",
      amountCents: 1_000,
      reason: "refund",
      idempotencyKey: "nq:refund",
      providerAccountId: "merchant-from-claim",
    })).rejects.toThrow("square_provider_account_mismatch");
    expect(mocks.charge).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });
});
