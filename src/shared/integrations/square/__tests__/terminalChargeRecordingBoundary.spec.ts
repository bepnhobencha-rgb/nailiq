import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  booking: {} as Record<string, unknown>,
  resolvePaymentProvider: vi.fn(),
  chargeSavedCard: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: mocks.booking }),
    };
    return { from: () => builder };
  },
}));

vi.mock("@/shared/integrations/payments", () => ({
  resolvePaymentProvider: mocks.resolvePaymentProvider,
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

vi.mock("@/shared/integrations/square/client", () => ({
  createPaymentLink: vi.fn(),
  getOrder: vi.fn(),
  getSquareConfig: vi.fn(),
  findSuccessfulPaymentByReference: vi.fn(),
}));

import {
  chargeNoShowFee,
  noShowCardDecision,
} from "@/shared/integrations/square/noshow";

const TERMINAL_BOOKING = {
  id: "11111111-1111-4111-8111-111111111111",
  salon_id: "22222222-2222-4222-8222-222222222222",
  status: "no_show",
  noshow_card_id: "card-test",
  noshow_customer_id: "customer-test",
  noshow_fee_cents: 1_700,
  noshow_charge_status: "saved",
  noshow_charge_attempts: 0,
  noshow_consent_at: "2026-08-14T00:00:00.000Z",
};

describe("terminal no-show charge recording boundary", () => {
  beforeEach(() => {
    delete process.env.NOSHOW_RECONCILE_BEFORE_CHARGE;
    mocks.booking = { ...TERMINAL_BOOKING };
    mocks.resolvePaymentProvider.mockReset();
    mocks.chargeSavedCard.mockReset();
    mocks.rpc.mockReset();
    mocks.resolvePaymentProvider.mockResolvedValue({
      kind: "square",
      chargeSavedCard: mocks.chargeSavedCard,
    });
    mocks.rpc.mockResolvedValue({
      data: { success: true, charge_status: "charged" },
      error: null,
    });
  });

  it("rejects a nonterminal booking before resolving or calling a provider", async () => {
    mocks.booking = { ...TERMINAL_BOOKING, status: "confirmed" };

    await expect(chargeNoShowFee(TERMINAL_BOOKING.id)).resolves.toEqual({
      charged: false,
      reason: "booking is not terminal",
    });
    expect(mocks.resolvePaymentProvider).not.toHaveBeenCalled();
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("never asks a terminal booking to attach another card", async () => {
    await expect(noShowCardDecision(TERMINAL_BOOKING.id)).resolves.toEqual({
      required: false,
      feeCents: 0,
      reason: "booking is not active",
    });
    expect(mocks.resolvePaymentProvider).not.toHaveBeenCalled();
    expect(mocks.chargeSavedCard).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("does not claim success when the provider charged but atomic recording failed", async () => {
    mocks.chargeSavedCard.mockResolvedValue({
      paymentId: "payment-success",
      status: "COMPLETED",
    });
    mocks.rpc.mockResolvedValue({
      data: { success: false, code: "invalid_state" },
      error: null,
    });

    await expect(chargeNoShowFee(TERMINAL_BOOKING.id)).resolves.toEqual({
      charged: false,
      reason: "charge_recording_failed",
      paymentId: "payment-success",
    });
    expect(mocks.chargeSavedCard).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_terminal_booking_fee_mutation",
      expect.objectContaining({
        p_booking_id: TERMINAL_BOOKING.id,
        p_salon_id: TERMINAL_BOOKING.salon_id,
        p_operation: "charge_succeeded",
        p_payment_id: "payment-success",
      }),
    );
  });

  it("reports a declined-payment recording failure without pretending the decline was persisted", async () => {
    mocks.chargeSavedCard.mockResolvedValue({
      paymentId: "payment-declined",
      status: "DECLINED",
    });
    mocks.rpc.mockResolvedValue({
      data: { success: false, code: "database_error" },
      error: null,
    });

    await expect(chargeNoShowFee(TERMINAL_BOOKING.id)).resolves.toEqual({
      charged: false,
      reason: "failure_recording_failed",
      paymentId: "payment-declined",
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_terminal_booking_fee_mutation",
      expect.objectContaining({ p_operation: "charge_failed" }),
    );
  });

  it("returns a successful charge only after the audited database outcome commits", async () => {
    mocks.chargeSavedCard.mockResolvedValue({
      paymentId: "payment-committed",
      status: "SUCCEEDED",
    });

    await expect(chargeNoShowFee(TERMINAL_BOOKING.id)).resolves.toEqual({
      charged: true,
      reason: "SUCCEEDED",
      paymentId: "payment-committed",
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});
