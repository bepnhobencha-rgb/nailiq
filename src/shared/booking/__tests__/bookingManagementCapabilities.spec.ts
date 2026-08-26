import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc }),
}));

import {
  isBookingManagementToken,
  mintBookingManagementCapability,
  parseBookingManagementInspection,
  parseBookingManagementMutation,
} from "../bookingManagementCapabilities";

describe("booking management capability response parsing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("mints the exact action and required minimum expiry through the service-only RPC", async () => {
    rpc.mockResolvedValue({
      data: {
        ok: true,
        code: "minted",
        token_id: "22222222-2222-4222-8222-222222222222",
        action: "status",
        scope_kind: "booking_own",
        epoch: 1,
        expires_at: "2099-08-20T18:00:00.000Z",
      },
      error: null,
    });
    const result = await mintBookingManagementCapability({
      salonId: "11111111-1111-4111-8111-111111111111",
      bookingId: "33333333-3333-4333-8333-333333333333",
      action: "status",
      minExpiresAt: "2099-08-20T18:00:00.000Z",
    });
    expect(result).toMatchObject({ ok: true, capability: { action: "status", reused: false } });
    expect(rpc).toHaveBeenCalledWith("mint_booking_management_capability", {
      p_salon_id: "11111111-1111-4111-8111-111111111111",
      p_booking_id: "33333333-3333-4333-8333-333333333333",
      p_action: "status",
      p_min_expires_at: "2099-08-20T18:00:00.000Z",
    });
  });
  it("accepts the exact PII-free confirm inspection contract", () => {
    const parsed = parseBookingManagementInspection({
      ok: true,
      code: "valid",
      action: "confirm",
      scope_kind: "booking_own",
      epoch: 1,
      expires_at: "2099-08-20T18:00:00.000Z",
      booking: {
        status: "pending",
        attendance_status: null,
        start_time_utc: "2099-08-20T17:00:00.000Z",
        end_time_utc: "2099-08-20T18:00:00.000Z",
        service_name: "Manicure",
        staff_name: "QA Staff",
        salon_slug: "qa-salon",
        salon_name: "QA Salon",
        salon_timezone: "America/Los_Angeles",
        schedule_model: "single",
        sequence_receipt: null,
      },
      context: {
        booking_id: "33333333-3333-4333-8333-333333333333",
        salon_id: "11111111-1111-4111-8111-111111111111",
        service_id: "44444444-4444-4444-8444-444444444444",
        staff_id: "55555555-5555-4555-8555-555555555555",
        duration_minutes: 60,
        timezone: "America/Los_Angeles",
        current_start_time_utc: "2099-08-20T17:00:00.000Z",
        current_end_time_utc: "2099-08-20T18:00:00.000Z",
        group_id: null,
        is_group_organizer: false,
      },
      cancel_preview: {
        start_past: false,
        within_window: false,
        will_charge: false,
        policy_locked_by_reschedule: false,
        fee_cents: 0,
        card_last4: null,
        card_brand: null,
        currency: "CAD",
      },
      card_manage: {
        has_card: false,
        card_fingerprint: "a".repeat(64),
        card_last4: null,
        card_brand: null,
        charge_status: null,
      },
    }, "confirm");
    expect(parsed).toMatchObject({
      ok: true,
      inspection: {
        action: "confirm",
        booking: { serviceName: "Manicure", scheduleModel: "single", sequenceReceipt: null },
      },
    });
    expect(JSON.stringify(parsed)).not.toContain("client_");
  });

  it("rejects action confusion and incomplete authoritative snapshots", () => {
    expect(parseBookingManagementInspection({
      ok: true,
      code: "valid",
      action: "cancel",
      scope_kind: "booking_own",
      epoch: 1,
      expires_at: "2099-08-20T18:00:00.000Z",
      booking: {},
    }, "confirm")).toEqual({ ok: false, code: "invalid_management_response" });
  });

  it("strictly parses exact replay results and rejects malformed ids", () => {
    const parsed = parseBookingManagementMutation({
      ok: true,
      code: "confirmed",
      action: "confirm",
      booking_id: "33333333-3333-4333-8333-333333333333",
      salon_id: "11111111-1111-4111-8111-111111111111",
      service_id: "44444444-4444-4444-8444-444444444444",
      staff_id: "55555555-5555-4555-8555-555555555555",
      service_name: "Manicure",
      staff_name: "QA Staff",
      salon_slug: "qa-salon",
      salon_name: "QA Salon",
      salon_timezone: "America/Los_Angeles",
      status: "confirmed",
      group_id: null,
      scope_kind: "booking_own",
      rsvp_semantic: null,
      attendance_status: null,
      action_epoch: 2,
      customer_transition_version: null,
      previous_start_time_utc: "2099-08-20T17:00:00.000Z",
      start_time_utc: "2099-08-20T17:00:00.000Z",
      end_time_utc: "2099-08-20T18:00:00.000Z",
      idempotent: true,
      cancel_preview: null,
      promoted_waitlist: null,
    }, "confirm");
    expect(parsed).toMatchObject({ ok: true, result: { idempotent: true } });
    expect(isBookingManagementToken("not-a-token")).toBe(false);
  });
});
