import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type BookingRow = {
  id: string;
  salon_id: string;
  noshow_card_id: string | null;
  noshow_customer_id: string | null;
  noshow_fee_cents: number;
  noshow_charge_status: string;
  noshow_charge_attempts: number;
  noshow_consent_at: string | null;
};

const state = vi.hoisted(() => ({
  booking: {
    id: "11111111-1111-4111-8111-111111111111",
    salon_id: "22222222-2222-4222-8222-222222222222",
    noshow_card_id: "card-1",
    noshow_customer_id: "customer-1",
    noshow_fee_cents: 1_700,
    noshow_charge_status: "failed",
    noshow_charge_attempts: 1,
    noshow_consent_at: "2026-08-12T00:00:00.000Z",
  } as BookingRow,
  providerKind: "square" as "square" | "stripe",
  updates: [] as Array<Record<string, unknown>>,
}));

const mocks = vi.hoisted(() => ({
  chargeSavedCard: vi.fn(),
  findSuccessfulPaymentByReference: vi.fn(),
  getSquareConfig: vi.fn(),
}));

vi.mock("@/shared/integrations/payments", () => ({
  resolvePaymentProvider: vi.fn(async () => ({
    kind: state.providerKind,
    chargeSavedCard: mocks.chargeSavedCard,
  })),
}));

type Builder = {
  select: (...args: unknown[]) => Builder;
  eq: (...args: unknown[]) => Builder;
  update: (patch: Record<string, unknown>) => Builder;
  maybeSingle: () => Promise<{ data: BookingRow }>;
};

vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({
    from: () => {
      const builder: Builder = {
        select: () => builder,
        eq: () => builder,
        update: (patch) => {
          state.updates.push(patch);
          return builder;
        },
        maybeSingle: async () => ({ data: { ...state.booking } }),
      };
      return builder;
    },
  }),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: vi.fn(),
}));

vi.mock("@/shared/integrations/square/client", () => ({
  createPaymentLink: vi.fn(),
  getOrder: vi.fn(),
  getSquareConfig: mocks.getSquareConfig,
  findSuccessfulPaymentByReference: mocks.findSuccessfulPaymentByReference,
}));

import { chargeNoShowFee } from "@/shared/integrations/square/noshow";

describe("no-show charge retry safety", () => {
  beforeEach(() => {
    state.booking.noshow_charge_status = "failed";
    state.booking.noshow_consent_at = "2026-08-12T00:00:00.000Z";
    state.providerKind = "square";
    state.updates.length = 0;
    mocks.chargeSavedCard.mockReset().mockResolvedValue({
      paymentId: "payment-new",
      status: "COMPLETED",
    });
    mocks.getSquareConfig.mockReset().mockResolvedValue({
      salonId: state.booking.salon_id,
      merchantId: "merchant-1",
      locationId: "location-1",
      accessToken: "test-token",
      applicationId: "app-1",
      environment: "sandbox",
      currency: "USD",
      sync: {},
    });
    mocks.findSuccessfulPaymentByReference.mockReset().mockResolvedValue(null);
  });

  it("uses the stable booking key on the first attempt without a provider scan", async () => {
    const result = await chargeNoShowFee(state.booking.id);

    expect(result).toMatchObject({ charged: true, paymentId: "payment-new" });
    expect(mocks.findSuccessfulPaymentByReference).not.toHaveBeenCalled();
    expect(mocks.chargeSavedCard).toHaveBeenCalledOnce();
    expect(mocks.chargeSavedCard).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `noshow:${state.booking.id}` }),
    );
  });

  it("adopts an already-completed Square payment instead of charging again", async () => {
    mocks.findSuccessfulPaymentByReference.mockResolvedValue({
      id: "payment-existing",
      status: "COMPLETED",
      amount_money: { amount: 1_500, currency: "USD" },
    });

    const result = await chargeNoShowFee(state.booking.id, {
      idempotencySuffix: "retry-2",
    });

    expect(result).toEqual({
      charged: false,
      reason: "already_charged_reconciled",
      paymentId: "payment-existing",
    });
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        noshow_charge_status: "charged",
        noshow_payment_id: "payment-existing",
        noshow_fee_cents: 1_500,
      }),
    );
  });

  it("permits a fresh Square retry only after reconciliation finds no payment", async () => {
    const result = await chargeNoShowFee(state.booking.id, {
      idempotencySuffix: "retry-2",
    });

    expect(result).toMatchObject({ charged: true, paymentId: "payment-new" });
    expect(mocks.findSuccessfulPaymentByReference).toHaveBeenCalledOnce();
    expect(mocks.chargeSavedCard).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `noshow:${state.booking.id}:retry-2`,
      }),
    );
  });

  it("fails closed when Square reconciliation is unavailable", async () => {
    mocks.findSuccessfulPaymentByReference.mockRejectedValue(
      new Error("Square timeout"),
    );

    const result = await chargeNoShowFee(state.booking.id, {
      idempotencySuffix: "retry-2",
    });

    expect(result).toEqual({
      charged: false,
      reason: "retry reconciliation unavailable",
    });
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    expect(state.updates).toContainEqual(
      expect.objectContaining({
        noshow_charge_error:
          "retry reconciliation failed: Square timeout",
      }),
    );
  });

  it("blocks rotated retries for a provider without reconciliation support", async () => {
    state.providerKind = "stripe";

    const result = await chargeNoShowFee(state.booking.id, {
      idempotencySuffix: "retry-2",
    });

    expect(result).toEqual({
      charged: false,
      reason: "retry reconciliation unavailable",
    });
    expect(mocks.findSuccessfulPaymentByReference).not.toHaveBeenCalled();
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });

  it("never charges when the saved-card consent evidence is missing", async () => {
    state.booking.noshow_consent_at = null;

    const result = await chargeNoShowFee(state.booking.id);

    expect(result).toEqual({ charged: false, reason: "no consent on file" });
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
  });
});
