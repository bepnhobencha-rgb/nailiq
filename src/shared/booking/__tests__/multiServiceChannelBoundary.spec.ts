import { describe, expect, it, vi } from "vitest";
import { groupBookingCreateRequestSchema } from "@/shared/booking/groupBookingPricingServer";
import { executeVoiceTool } from "@/shared/voiceai/toolExecutor";

vi.mock("server-only", () => ({}));

describe("Phase-A multi-service channel boundary", () => {
  const voiceBase = {
    service_id: "11111111-1111-4111-8111-111111111111",
    date: "2026-08-28",
    time_slot: "2:00 PM",
    staff_id: "any",
    customer_name: "QA Guest",
    customer_phone: "+16045550199",
  };

  it("keeps Group members on one main service and rejects sequence keys", () => {
    const member = {
      serviceId: "11111111-1111-4111-8111-111111111111",
      staffId: "22222222-2222-4222-8222-222222222222",
      startTimeUtc: "2026-08-20T18:00:00.000Z",
      endTimeUtc: "2026-08-20T19:00:00.000Z",
      addonServiceIds: [],
      clientName: "QA Guest",
      clientPhone: "16045550199",
      serviceIds: [
        "11111111-1111-4111-8111-111111111111",
        "33333333-3333-4333-8333-333333333333",
      ],
    };
    expect(
      groupBookingCreateRequestSchema.safeParse({
        salonId: "44444444-4444-4444-8444-444444444444",
        bookings: [member, { ...member, clientName: "Second Guest" }],
        applyEmailDiscount: false,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
        expectedPricingFingerprint: "a".repeat(64),
      }).success,
    ).toBe(false);
  });

  it.each([
    ["service_id array", { ...voiceBase, service_id: [
      "11111111-1111-4111-8111-111111111111",
      "33333333-3333-4333-8333-333333333333",
    ] }],
    ["service_ids", {
      ...voiceBase,
      service_ids: [
        "11111111-1111-4111-8111-111111111111",
        "33333333-3333-4333-8333-333333333333",
      ],
    }],
    ["services", {
      ...voiceBase,
      services: [
        { service_id: "11111111-1111-4111-8111-111111111111" },
        { service_id: "33333333-3333-4333-8333-333333333333" },
      ],
    }],
    ["lines", {
      ...voiceBase,
      lines: [
        { service_id: "11111111-1111-4111-8111-111111111111" },
        { service_id: "33333333-3333-4333-8333-333333333333" },
      ],
    }],
  ])("rejects model-invented Voice %s before any salon or provider read", async (_label, shape) => {
    const from = vi.fn();
    const response = await executeVoiceTool(
      { from } as never,
      "qa-salon",
      "confirm_booking",
      shape,
      null,
      "https://example.test",
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "multi_service_not_supported",
      code: "human_review_required",
    });
    expect(from).not.toHaveBeenCalled();
  });
});
