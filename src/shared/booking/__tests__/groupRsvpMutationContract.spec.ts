import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: vi.fn(),
}));

import { parseBookingManagementMutation } from "../bookingManagementCapabilities";

const base = {
  ok: true,
  code: "cancelled",
  action: "cancel",
  booking_id: "33333333-3333-4333-8333-333333333333",
  salon_id: "11111111-1111-4111-8111-111111111111",
  service_id: "44444444-4444-4444-8444-444444444444",
  staff_id: "55555555-5555-4555-8555-555555555555",
  service_name: "Manicure",
  staff_name: "QA Staff",
  salon_slug: "qa-salon",
  salon_name: "QA Salon",
  salon_timezone: "America/Los_Angeles",
  status: "cancelled",
  group_id: "66666666-6666-4666-8666-666666666666",
  action_epoch: 2,
  customer_transition_version: null,
  previous_start_time_utc: "2099-08-20T17:00:00.000Z",
  start_time_utc: "2099-08-20T17:00:00.000Z",
  end_time_utc: "2099-08-20T18:00:00.000Z",
  idempotent: false,
  cancel_preview: {
    start_past: false,
    within_window: true,
    will_charge: true,
    policy_locked_by_reschedule: true,
    fee_cents: 2500,
    card_last4: "4242",
    card_brand: "visa",
    currency: "CAD",
  },
  promoted_waitlist: null,
};

describe("group RSVP durable mutation truth", () => {
  it("preserves member-own decline semantics so replay cannot fall into generic fee handling", () => {
    const parsed = parseBookingManagementMutation({
      ...base,
      scope_kind: "member_own",
      rsvp_semantic: "decline",
      attendance_status: "declined",
    }, "cancel");

    expect(parsed).toMatchObject({
      ok: true,
      result: {
        scopeKind: "member_own",
        rsvpSemantic: "decline",
        attendanceStatus: "declined",
      },
    });
  });

  it("preserves organizer-own decline semantics without treating it as whole-party cancellation", () => {
    const parsed = parseBookingManagementMutation({
      ...base,
      scope_kind: "organizer_own",
      rsvp_semantic: "decline",
      attendance_status: "declined",
    }, "cancel");

    expect(parsed).toMatchObject({
      ok: true,
      result: {
        scopeKind: "organizer_own",
        rsvpSemantic: "decline",
        attendanceStatus: "declined",
      },
    });
  });

  it("fails closed when an own-spot cancellation omits its RSVP receipt", () => {
    expect(parseBookingManagementMutation({
      ...base,
      scope_kind: "organizer_own",
      rsvp_semantic: null,
      attendance_status: null,
    }, "cancel")).toEqual({ ok: false, code: "invalid_management_response" });
  });

  it("fails closed when an RSVP scope is not bound to a group", () => {
    expect(parseBookingManagementMutation({
      ...base,
      group_id: null,
      scope_kind: "member_own",
      rsvp_semantic: "decline",
      attendance_status: "declined",
    }, "cancel")).toEqual({ ok: false, code: "invalid_management_response" });
  });
});
