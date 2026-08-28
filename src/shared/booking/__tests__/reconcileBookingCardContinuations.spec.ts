import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import { reconcileBookingCardContinuations } from "../reconcileBookingCardContinuations";

describe("booking card continuation reconciliation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies durable NailIQ-only outcomes without provider work", async () => {
    mocks.rpc.mockResolvedValue({
      data: [
        { ok: true, status: "awaiting_customer" },
        { ok: true, status: "provider_reconciliation" },
        { ok: true, status: "resolved" },
        { ok: true, status: "manual_review" },
      ],
      error: null,
    });

    await expect(reconcileBookingCardContinuations()).resolves.toEqual({
      ok: true,
      processed: 4,
      awaitingCustomer: 1,
      pendingProvider: 1,
      resolved: 1,
      manualReview: 1,
      errors: 0,
    });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "reconcile_due_booking_card_management_continuations",
      { p_limit: 10 },
    );
  });

  it("fails closed on malformed or unavailable ledger results", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [{ ok: true, status: "invented" }], error: null });
    await expect(reconcileBookingCardContinuations()).resolves.toMatchObject({
      ok: false, processed: 0, errors: 1,
    });

    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    await expect(reconcileBookingCardContinuations()).resolves.toMatchObject({
      ok: false, processed: 0, errors: 1,
    });
  });
});
