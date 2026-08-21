import { describe, expect, it, vi } from "vitest";

import { executeWebVoiceToolCall } from "@/shared/booking/webVoiceBookingHandoff";

const completeIntent = {
  service_id: "service-1",
  staff_id: "any",
  date: "2026-08-21",
  time_slot: "2:00 PM",
  customer_name: "Mai Tran",
  customer_phone: "16045551234",
};

describe("browser Voice booking handoff", () => {
  it("turns confirm_booking into a standard-wizard prefill with zero create request", async () => {
    const forwardToServer = vi.fn();
    const onBookingHandoff = vi.fn();

    const result = await executeWebVoiceToolCall({
      toolName: "confirm_booking",
      toolArgs: completeIntent,
      forwardToServer,
      onBookingHandoff,
    });

    expect(forwardToServer).not.toHaveBeenCalled();
    expect(onBookingHandoff).toHaveBeenCalledWith({
      serviceId: "service-1",
      staffId: "any",
      bookingDateYmd: "2026-08-21",
      timeSlot: "2:00 PM",
      clientName: "Mai Tran",
      clientPhone: "16045551234",
    });
    expect(result).toMatchObject({
      handoff: true,
      booking_created: false,
      success: false,
    });
  });

  it("fails closed when a mutation intent is incomplete", async () => {
    const forwardToServer = vi.fn();
    const onBookingHandoff = vi.fn();
    const result = await executeWebVoiceToolCall({
      toolName: "confirm_booking",
      toolArgs: { ...completeIntent, customer_phone: "" },
      forwardToServer,
      onBookingHandoff,
    });

    expect(forwardToServer).not.toHaveBeenCalled();
    expect(onBookingHandoff).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: "web_booking_handoff_invalid",
      booking_created: false,
    });
  });

  it("still forwards read-only Voice tools", async () => {
    const forwardToServer = vi.fn().mockResolvedValue({ ok: true });
    const result = await executeWebVoiceToolCall({
      toolName: "get_services",
      toolArgs: {},
      forwardToServer,
      onBookingHandoff: vi.fn(),
    });
    expect(forwardToServer).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true });
  });
});
