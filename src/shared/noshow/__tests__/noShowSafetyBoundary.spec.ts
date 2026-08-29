import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  serviceRole: vi.fn(),
  ownerNotification: vi.fn(),
  promoteWaitlist: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.serviceRole,
}));
vi.mock("@/shared/dashboard/sendOwnerBookingNotification", () => ({
  sendOwnerBookingNotification: mocks.ownerNotification,
}));
vi.mock("@/shared/noshow/promoteAndDeliverWaitlistOffer", () => ({
  promoteAndDeliverWaitlistForBooking: mocks.promoteWaitlist,
}));

import {
  finalizeAndProcessNoShowDecision,
  finalizeDueNoShowDecisions,
  runNoShowDecisionEffects,
} from "../noShowSafetyBoundary";

const DECISION_ID = "61000000-0000-4000-8000-000000000001";
const BOOKING_ID = "61000000-0000-4000-8000-000000000002";
const SALON_ID = "61000000-0000-4000-8000-000000000003";
const LEASE_TOKEN = "61000000-0000-4000-8000-000000000004";

describe("no-show durable finalizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a validated commit receipt without creating another client", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: [{
          success: true,
          code: "decision_committed",
          decision_id: DECISION_ID,
          booking_id: BOOKING_ID,
          salon_id: SALON_ID,
        }],
        error: null,
      })
      .mockResolvedValueOnce({ data: { success: true }, error: null });

    const result = await finalizeDueNoShowDecisions({
      decisionId: DECISION_ID,
      salonId: SALON_ID,
      client: { rpc } as never,
    });

    expect(result).toEqual([{
      ok: true,
      code: "decision_committed",
      decisionId: DECISION_ID,
      bookingId: BOOKING_ID,
      salonId: SALON_ID,
    }]);
    expect(rpc).toHaveBeenNthCalledWith(
      1,
      "finalize_due_booking_no_shows_v1",
      { p_decision_id: DECISION_ID, p_limit: 25, p_salon_id: SALON_ID },
    );
    expect(rpc).toHaveBeenNthCalledWith(2, "ensure_booking_no_show_fee_review", {
      p_decision_id: DECISION_ID,
      p_salon_id: SALON_ID,
    });
    expect(mocks.serviceRole).not.toHaveBeenCalled();
  });

  it("creates the owner fee review after commit without making it part of attendance success", async () => {
    const finalizeRpc = vi.fn()
      .mockResolvedValueOnce({
        data: [{
          success: true,
          code: "decision_committed",
          decision_id: DECISION_ID,
          booking_id: BOOKING_ID,
          salon_id: SALON_ID,
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: { success: false, code: "consent_not_charge_ready" },
        error: null,
      });
    const effectsRpc = vi.fn().mockResolvedValue({ data: [], error: null });
    mocks.serviceRole
      .mockReturnValueOnce({ rpc: finalizeRpc })
      .mockReturnValueOnce({ rpc: effectsRpc });

    const result = await finalizeAndProcessNoShowDecision(DECISION_ID, SALON_ID);

    expect(result).toMatchObject({ ok: true, code: "decision_committed" });
    expect(finalizeRpc).toHaveBeenCalledWith("ensure_booking_no_show_fee_review", {
      p_decision_id: DECISION_ID,
      p_salon_id: SALON_ID,
    });
    expect(effectsRpc).toHaveBeenCalledWith("claim_booking_no_show_effects_v1", {
      p_decision_id: DECISION_ID,
      p_limit: 1,
      p_salon_id: SALON_ID,
    });
  });

  it("uses the decision id as the owner-notification occurrence key and completes the lease", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: [{
          success: true,
          code: "effects_leased",
          decision_id: DECISION_ID,
          booking_id: BOOKING_ID,
          salon_id: SALON_ID,
          lease_token: LEASE_TOKEN,
          occurrence_key: DECISION_ID,
          needs_waitlist: false,
          needs_owner_notification: true,
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ success: true, effects_state: "completed" }],
        error: null,
      });
    mocks.ownerNotification.mockResolvedValue({
      outcome: "sent",
      reason: "sent",
    });

    const result = await runNoShowDecisionEffects({
      decisionId: DECISION_ID,
      salonId: SALON_ID,
      limit: 1,
      client: { rpc } as never,
    });

    expect(result).toEqual({ available: true, claimed: 1, completed: 1, failed: 0, unknown: 0 });
    expect(mocks.promoteWaitlist).not.toHaveBeenCalled();
    expect(mocks.ownerNotification).toHaveBeenCalledWith({
      salonId: SALON_ID,
      bookingId: BOOKING_ID,
      event: "no_show",
      eventOccurrenceKey: DECISION_ID,
    });
    expect(rpc).toHaveBeenLastCalledWith(
      "complete_booking_no_show_effects_v1",
      {
        p_decision_id: DECISION_ID,
        p_lease_token: LEASE_TOKEN,
        p_waitlist_outcome: null,
        p_owner_outcome: "completed",
        p_error_code: null,
      },
    );
  });

  it("records an unknown provider-free side effect instead of replaying it blindly", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({
        data: [{
          success: true,
          code: "effects_leased",
          decision_id: DECISION_ID,
          booking_id: BOOKING_ID,
          salon_id: SALON_ID,
          lease_token: LEASE_TOKEN,
          occurrence_key: DECISION_ID,
          needs_waitlist: true,
          needs_owner_notification: false,
        }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ success: true, effects_state: "failed" }],
        error: null,
      });
    mocks.promoteWaitlist.mockRejectedValue(new Error("transport lost"));

    const result = await runNoShowDecisionEffects({
      decisionId: DECISION_ID,
      salonId: SALON_ID,
      client: { rpc } as never,
    });

    expect(result).toEqual({ available: true, claimed: 1, completed: 0, failed: 1, unknown: 0 });
    expect(rpc).toHaveBeenLastCalledWith(
      "complete_booking_no_show_effects_v1",
      expect.objectContaining({
        p_waitlist_outcome: "unknown",
        p_error_code: "waitlist:outcome_unknown",
      }),
    );
  });
});
