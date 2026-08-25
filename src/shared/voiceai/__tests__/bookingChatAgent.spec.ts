import { describe, expect, it } from "vitest";
import {
  BOOKING_CHAT_CHANNEL_NOTE,
  WEB_BOOKING_TOOL_NAMES,
  bookingChatToolsEnabled,
  isWebBookingToolName,
  selectWebBookingTools,
} from "../bookingChatAgent";
import type { RealtimeToolSchema } from "../smsAgent";

const schema = (name: string): RealtimeToolSchema => ({
  type: "function",
  name,
  description: name,
  parameters: { type: "object", properties: {} },
});

describe("booking chat tool boundary", () => {
  it("is default-off and requires an explicit boolean feature flag", () => {
    expect(bookingChatToolsEnabled(null)).toBe(false);
    expect(bookingChatToolsEnabled({})).toBe(false);
    expect(bookingChatToolsEnabled({ booking_chat_tools_enabled: "true" })).toBe(false);
    expect(bookingChatToolsEnabled({ booking_chat_tools_enabled: true })).toBe(true);
  });

  it("allows booking tools but excludes phone-only and owner-message actions", () => {
    const selected = selectWebBookingTools([
      schema("get_available_slots"),
      schema("confirm_booking"),
      schema("transfer_to_human"),
      schema("leave_message_for_owner"),
      schema("end_call"),
    ]).map((tool) => tool.name);

    expect(selected).toEqual(["get_available_slots", "confirm_booking"]);
    expect(WEB_BOOKING_TOOL_NAMES).toContain("verify_otp");
    expect(WEB_BOOKING_TOOL_NAMES).toContain("confirm_group_booking");
    expect(isWebBookingToolName("confirm_booking")).toBe(true);
    expect(isWebBookingToolName("transfer_to_human")).toBe(false);
  });

  it("requires explicit confirmation, OTP and tool-backed success", () => {
    expect(BOOKING_CHAT_CHANNEL_NOTE).toMatch(/explicit yes/i);
    expect(BOOKING_CHAT_CHANNEL_NOTE).toMatch(/request_otp then verify_otp/i);
    expect(BOOKING_CHAT_CHANNEL_NOTE).toMatch(/until its tool returns success/i);
    expect(BOOKING_CHAT_CHANNEL_NOTE).toMatch(/Never charge a card/i);
  });
});
