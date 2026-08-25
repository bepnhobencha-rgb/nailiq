import type { RealtimeToolSchema } from "@/shared/voiceai/smsAgent";

/**
 * The public booking chat intentionally receives only the tools a customer can
 * use from the booking page. Phone-only actions (transfer/hang-up) and owner
 * messaging stay off this surface.
 */
export const WEB_BOOKING_TOOL_NAMES = [
  "get_available_slots",
  "request_otp",
  "verify_otp",
  "confirm_booking",
  "find_booking",
  "cancel_booking",
  "reschedule_booking",
  "get_group_available_slots",
  "confirm_group_booking",
  "join_waitlist",
  "lookup_customer",
] as const;

const WEB_BOOKING_TOOL_NAME_SET = new Set<string>(WEB_BOOKING_TOOL_NAMES);

export const BOOKING_CHAT_AGENT_MODEL = "claude-haiku-4-5-20251001";
export const BOOKING_CHAT_MAX_TOOL_TURNS = 6;
export const BOOKING_CHAT_MAX_REPLY_TOKENS = 420;
export const BOOKING_CHAT_MAX_HISTORY = 10;

export const BOOKING_CHAT_CHANNEL_NOTE = `

WEB BOOKING CHAT — these rules override any phone-channel wording above:
- You are typing in a public booking-page chat, not speaking on a call. Use short plain text; no markdown.
- Reply in the same language as the customer's newest message (Vietnamese or English).
- You CAN check availability and complete individual or group bookings with the tools provided.
- Before confirm_booking or confirm_group_booking, show the exact service, date, time, staff preference and customer name, then ask for an explicit yes. Never book from an ambiguous reply.
- Browser chat has no trusted caller ID. Use request_otp then verify_otp whenever a tool requires verified identity. Never invent or expose an OTP.
- Never say a booking, cancellation or reschedule succeeded until its tool returns success. If a tool fails, explain the safe next step and keep the manual booking form available.
- Never charge a card, promise a refund, or claim a payment was taken.
`;

export function bookingChatToolsEnabled(featureFlags: unknown): boolean {
  if (!featureFlags || typeof featureFlags !== "object" || Array.isArray(featureFlags)) {
    return false;
  }
  return (featureFlags as Record<string, unknown>).booking_chat_tools_enabled === true;
}

export function selectWebBookingTools(
  tools: readonly RealtimeToolSchema[],
): RealtimeToolSchema[] {
  return tools.filter((tool) => WEB_BOOKING_TOOL_NAME_SET.has(tool.name));
}

export function isWebBookingToolName(name: string): boolean {
  return WEB_BOOKING_TOOL_NAME_SET.has(name);
}
