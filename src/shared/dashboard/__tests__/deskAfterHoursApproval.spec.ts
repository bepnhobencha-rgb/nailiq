import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildDeskAfterHoursApprovalPayload,
  parseDeskAfterHoursApprovalPayload,
  type DeskAfterHoursBookingInput,
} from "@/shared/dashboard/deskAfterHoursApproval";

const booking: DeskAfterHoursBookingInput = {
  requestId: "11111111-1111-4111-8111-111111111111",
  salonId: "22222222-2222-4222-8222-222222222222",
  serviceId: "33333333-3333-4333-8333-333333333333",
  addonServiceIds: ["44444444-4444-4444-8444-444444444444"],
  staffId: "55555555-5555-4555-8555-555555555555",
  staffRequestedByClient: false,
  bookingDateYmd: "2026-09-05",
  timeSlot: "8:00 PM",
  clientName: "Synthetic Guest",
  clientPhone: "17775550123",
  clientEmail: null,
  clientNotes: null,
  language: "en",
  notify: { sms: false, email: false },
  resourceId: null,
  afterHoursOverride: { staffConsentConfirmed: true },
};

describe("desk after-hours approval payload", () => {
  it("round-trips an owner-one-tap request with outbound approval email disabled", () => {
    const payload = buildDeskAfterHoursApprovalPayload({
      requestedByUserId: "66666666-6666-4666-8666-666666666666",
      requestedByRole: "receptionist",
      booking,
    });
    expect(parseDeskAfterHoursApprovalPayload(payload)).toEqual(payload);
    expect(payload.notification_mode).toBe("dashboard_only_no_email");
    expect(payload.recipient_selection_required).toBe(true);
  });

  it("survives JSONB key reordering before owner approval", () => {
    const payload = buildDeskAfterHoursApprovalPayload({
      requestedByUserId: "66666666-6666-4666-8666-666666666666",
      requestedByRole: "receptionist",
      booking,
    });
    const reorderedBooking = Object.fromEntries(
      Object.entries(payload.booking).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    );

    expect(
      parseDeskAfterHoursApprovalPayload({
        booking: reorderedBooking,
        recipient_selection_required: payload.recipient_selection_required,
        requested_by_user_id: payload.requested_by_user_id,
        request_fingerprint: payload.request_fingerprint,
        version: payload.version,
        requested_by_role: payload.requested_by_role,
        notification_mode: payload.notification_mode,
        execution_mode: payload.execution_mode,
      }),
    ).not.toBeNull();
  });

  it("rejects tampering with any stored booking intent", () => {
    const payload = buildDeskAfterHoursApprovalPayload({
      requestedByUserId: "66666666-6666-4666-8666-666666666666",
      requestedByRole: "receptionist",
      booking,
    });
    expect(
      parseDeskAfterHoursApprovalPayload({
        ...payload,
        booking: { ...payload.booking, timeSlot: "8:15 PM" },
      }),
    ).toBeNull();
  });

  it("rejects non-attributable actors and missing staff consent", () => {
    const payload = buildDeskAfterHoursApprovalPayload({
      requestedByUserId: "66666666-6666-4666-8666-666666666666",
      requestedByRole: "receptionist",
      booking,
    });
    expect(
      parseDeskAfterHoursApprovalPayload({
        ...payload,
        requested_by_user_id: "not-a-user",
      }),
    ).toBeNull();
    expect(
      parseDeskAfterHoursApprovalPayload({
        ...payload,
        booking: {
          ...payload.booking,
          afterHoursOverride: { staffConsentConfirmed: false },
        },
      }),
    ).toBeNull();
  });
});
