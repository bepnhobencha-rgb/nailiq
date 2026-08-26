export type WebVoiceBookingHandoff = {
  serviceId: string;
  staffId: string;
  bookingDateYmd: string;
  timeSlot: string;
  clientName: string;
  clientPhone: string;
};

export type WebVoiceToolResult = Record<string, unknown>;

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function parseWebVoiceBookingHandoff(
  args: Record<string, unknown>,
): WebVoiceBookingHandoff | null {
  const serviceId = requiredString(args.service_id);
  const staffId = requiredString(args.staff_id) ?? "any";
  const bookingDateYmd = requiredString(args.date);
  const timeSlot = requiredString(args.time_slot);
  const clientName = requiredString(args.customer_name);
  const clientPhone = requiredString(args.customer_phone);
  if (
    !serviceId ||
    !bookingDateYmd ||
    !/^\d{4}-\d{2}-\d{2}$/.test(bookingDateYmd) ||
    !timeSlot ||
    !clientName ||
    !clientPhone
  ) {
    return null;
  }
  return {
    serviceId,
    staffId,
    bookingDateYmd,
    timeSlot,
    clientName,
    clientPhone,
  };
}

/**
 * Web Voice is an input aid, never a booking write surface. Individual booking
 * intent is handed to the standard wizard; group creation is blocked until it
 * has an equivalent consent-aware handoff.
 */
export async function executeWebVoiceToolCall(params: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  forwardToServer: () => Promise<WebVoiceToolResult>;
  onBookingHandoff: (handoff: WebVoiceBookingHandoff) => void;
}): Promise<WebVoiceToolResult> {
  if (params.toolName === "confirm_booking") {
    const handoff = parseWebVoiceBookingHandoff(params.toolArgs);
    if (!handoff) {
      return {
        success: false,
        error: "web_booking_handoff_invalid",
        booking_created: false,
      };
    }
    params.onBookingHandoff(handoff);
    return {
      success: false,
      handoff: true,
      booking_created: false,
      message:
        "The booking details are ready in the secure confirmation form. No booking exists until the customer reviews the price and policies and presses Confirm.",
    };
  }

  if (params.toolName === "confirm_group_booking") {
    return {
      success: false,
      error: "web_group_booking_handoff_required",
      booking_created: false,
      message: "Please continue in the group booking form. No booking was created.",
    };
  }

  return params.forwardToServer();
}
