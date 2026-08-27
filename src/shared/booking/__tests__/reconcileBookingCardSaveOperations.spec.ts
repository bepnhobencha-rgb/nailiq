import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getConfig: vi.fn(),
  listByReference: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));
vi.mock("@/shared/integrations/square/looseDb", () => ({
  looseServiceClient: () => ({ provider: "read-only-db" }),
}));
vi.mock("@/shared/integrations/square/client", () => ({
  getSquareConfig: mocks.getConfig,
  listCardsByReferenceId: mocks.listByReference,
}));

import { reconcileBookingCardSaveOperations } from "../reconcileBookingCardSaveOperations";

const OPERATION = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const SALON = "33333333-3333-4333-8333-333333333333";
const REFERENCE = `nq-card:${OPERATION}`;

function due() {
  return {
    operation_id: OPERATION,
    attempt_token: ATTEMPT,
    salon_id: SALON,
    provider: "square",
    provider_reference_key: REFERENCE,
  };
}

describe("booking card save reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockResolvedValue({ locationId: "L1" });
  });

  it("attaches one exact enabled provider card without a provider mutation", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [due()], error: null })
      .mockResolvedValueOnce({ data: { ok: true, code: "reconciled_saved" }, error: null });
    mocks.listByReference.mockResolvedValue([{
      cardId: "card-1",
      customerId: "customer-1",
      last4: "4242",
      brand: "VISA",
      enabled: true,
      referenceId: REFERENCE,
    }]);

    await expect(reconcileBookingCardSaveOperations()).resolves.toEqual({
      ok: true, processed: 1, reconciled: 1, unresolved: 0,
    });
    expect(mocks.listByReference).toHaveBeenCalledWith(
      expect.anything(),
      REFERENCE,
    );
    expect(mocks.rpc.mock.calls[1]).toEqual([
      "complete_booking_card_save_reconciliation",
      expect.objectContaining({
        p_outcome: "found",
        p_card_id: "card-1",
        p_customer_id: "customer-1",
      }),
    ]);
  });

  it("routes multiple exact matches to manual review", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [due()], error: null })
      .mockResolvedValueOnce({ data: { ok: true, code: "manual_review_required" }, error: null });
    mocks.listByReference.mockResolvedValue([1, 2].map((n) => ({
      cardId: `card-${n}`,
      customerId: `customer-${n}`,
      last4: "4242",
      brand: "VISA",
      enabled: true,
      referenceId: REFERENCE,
    })));

    const result = await reconcileBookingCardSaveOperations();
    expect(result).toMatchObject({ processed: 1, reconciled: 0, unresolved: 1 });
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_outcome: "manual_review" });
  });

  it("records an exact no-match without creating another card", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [due()], error: null })
      .mockResolvedValueOnce({ data: { ok: true, code: "reconciliation_pending" }, error: null });
    mocks.listByReference.mockResolvedValue([]);

    const result = await reconcileBookingCardSaveOperations();
    expect(result).toMatchObject({ processed: 1, reconciled: 0, unresolved: 1 });
    expect(mocks.rpc.mock.calls[1][1]).toMatchObject({ p_outcome: "not_found" });
  });
});
