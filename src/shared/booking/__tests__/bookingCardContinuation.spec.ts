import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import {
  recordCommittedBookingCardPending,
  resolveCommittedBookingCardContinuation,
} from "../bookingCardContinuation";

describe("booking card continuation bindings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records pending work using the exact canonical create receipt", async () => {
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });

    await expect(recordCommittedBookingCardPending({
      salonId: "11111111-1111-4111-8111-111111111111",
      bookingId: "22222222-2222-4222-8222-222222222222",
      createIdempotencyKey: "33333333-3333-4333-8333-333333333333",
      pricingFingerprint: "a".repeat(64),
      scope: "individual",
      stage: "assessment",
      reason: "assessment_unavailable",
    })).resolves.toBe(true);

    expect(mocks.rpc).toHaveBeenCalledWith(
      "record_booking_card_management_pending",
      expect.objectContaining({
        p_booking_id: "22222222-2222-4222-8222-222222222222",
        p_create_idempotency_key: "33333333-3333-4333-8333-333333333333",
        p_pricing_fingerprint: "a".repeat(64),
      }),
    );
  });

  it("resolves an armed row using the same exact create receipt", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ ok: true }], error: null });

    await expect(resolveCommittedBookingCardContinuation({
      salonId: "11111111-1111-4111-8111-111111111111",
      bookingId: "22222222-2222-4222-8222-222222222222",
      createIdempotencyKey: "33333333-3333-4333-8333-333333333333",
      pricingFingerprint: "a".repeat(64),
      scope: "group_organizer",
      reason: "card_not_required",
    })).resolves.toBe(true);

    expect(mocks.rpc).toHaveBeenCalledWith(
      "resolve_booking_card_management_continuation",
      {
        p_salon_id: "11111111-1111-4111-8111-111111111111",
        p_booking_id: "22222222-2222-4222-8222-222222222222",
        p_create_idempotency_key: "33333333-3333-4333-8333-333333333333",
        p_pricing_fingerprint: "a".repeat(64),
        p_scope: "group_organizer",
        p_reason_code: "card_not_required",
      },
    );
  });

  it("fails closed when the resolver RPC is unavailable", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "unavailable" } });

    await expect(resolveCommittedBookingCardContinuation({
      salonId: "11111111-1111-4111-8111-111111111111",
      bookingId: "22222222-2222-4222-8222-222222222222",
      createIdempotencyKey: "33333333-3333-4333-8333-333333333333",
      pricingFingerprint: "a".repeat(64),
      scope: "individual",
      reason: "card_not_required",
    })).resolves.toBe(false);
  });
});
