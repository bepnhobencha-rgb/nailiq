/** Tool definitions injected into the OpenAI Realtime session. */

export const REALTIME_TOOLS = [
  {
    type: "function" as const,
    name: "get_available_slots",
    description:
      "Get available booking time slots for a specific service on a given date. " +
      "ALWAYS call this before mentioning any times or confirming a reschedule. Never invent or assume availability.",
    parameters: {
      type: "object" as const,
      properties: {
        service_id: {
          type: "string",
          description: "Service ID from the services list in your context.",
        },
        date: {
          type: "string",
          description:
            "Date in YYYY-MM-DD format. Resolve relative expressions " +
            "(today, tomorrow, this Saturday, ngày mai, thứ bảy...) using today's date from context.",
        },
        staff_id: {
          type: "string",
          description: "Staff ID, or 'any' if the customer has no preference. Omit to default to 'any'.",
        },
      },
      required: ["service_id", "date"],
    },
  },
  {
    type: "function" as const,
    name: "confirm_booking",
    description:
      "Saves a NEW appointment to the booking system. " +
      "This MUST be called to actually create the booking — verbal confirmation alone does NOT save it. " +
      "Call immediately when the customer agrees: yes / ok / sure / đồng ý / được / vâng / ừ / xác nhận / đặt luôn. " +
      "Never skip this tool — if you do not call it, no booking is created. " +
      "The result includes a booking_id — keep it in context in case the customer wants to reschedule.",
    parameters: {
      type: "object" as const,
      properties: {
        service_id:     { type: "string", description: "Service ID." },
        date:           { type: "string", description: "Date in YYYY-MM-DD format." },
        time_slot:      { type: "string", description: "Exact time slot label returned by get_available_slots, e.g. '2:00 PM'." },
        staff_id:       { type: "string", description: "Staff ID, or 'any' for no preference." },
        customer_name:  { type: "string", description: "Customer's full name as they stated it." },
        customer_phone: { type: "string", description: "Customer's phone number, including country code if provided." },
      },
      required: ["service_id", "date", "time_slot", "staff_id", "customer_name", "customer_phone"],
    },
  },
  {
    type: "function" as const,
    name: "find_booking",
    description:
      "Look up upcoming bookings for a customer by phone number. " +
      "Use this when a customer calls to reschedule or cancel an existing booking and you don't have a booking_id from this session. " +
      "Returns a list of upcoming bookings with their booking_ids.",
    parameters: {
      type: "object" as const,
      properties: {
        customer_phone: {
          type: "string",
          description: "Customer's phone number to look up their upcoming bookings.",
        },
      },
      required: ["customer_phone"],
    },
  },
  {
    type: "function" as const,
    name: "cancel_booking",
    description:
      "Cancel an existing booking. Provide EITHER booking_id OR customer_phone — not both needed.\n\n" +
      "MODE A — booking_id provided: Cancels immediately. Use this when you already have the booking_id " +
      "(from confirm_booking this session, or from a previous cancel_booking call that returned confirmation_required). " +
      "ALWAYS read back the booking details and get verbal confirmation from the customer BEFORE calling with booking_id.\n\n" +
      "MODE B — customer_phone provided (no booking_id): Looks up upcoming bookings by phone WITHOUT cancelling. " +
      "Returns booking details with confirmation_required: true. Use this in new sessions when you don't have a booking_id. " +
      "After getting the result: read back the booking, ask customer to confirm, then call again with booking_id to execute.\n\n" +
      "After a successful cancellation: thank them warmly and invite them to rebook anytime.",
    parameters: {
      type: "object" as const,
      properties: {
        booking_id: {
          type: "string",
          description: "UUID of the booking to cancel. Required to actually execute the cancellation. Omit to use phone lookup mode instead.",
        },
        customer_phone: {
          type: "string",
          description: "Customer's phone number. Used in MODE B (new session, no booking_id yet) to look up their upcoming bookings. The result will include the booking_id to use in the follow-up call.",
        },
        reason: {
          type: "string",
          description: "Short reason the customer gave for cancelling, e.g. 'customer request', 'schedule conflict'. Optional.",
        },
      },
      // At least one of booking_id or customer_phone is required; enforced server-side.
      required: [],
    },
  },
  {
    type: "function" as const,
    name: "reschedule_booking",
    description:
      "Reschedule an EXISTING booking to a new date and time. " +
      "Use this instead of cancelling and rebooking — it preserves the booking ID, history, and any deposits. " +
      "ALWAYS call get_available_slots first to confirm the new slot is free. " +
      "If the customer just booked in this session, use the booking_id from the confirm_booking result. " +
      "If it's a new session, call find_booking first to get the booking_id.",
    parameters: {
      type: "object" as const,
      properties: {
        booking_id: {
          type: "string",
          description: "The ID of the booking to reschedule (from confirm_booking or find_booking result).",
        },
        new_date: {
          type: "string",
          description: "New date in YYYY-MM-DD format.",
        },
        new_time_slot: {
          type: "string",
          description: "New time slot label from get_available_slots, e.g. '3:00 PM'.",
        },
        staff_id: {
          type: "string",
          description: "Staff ID, or 'any' to keep the same staff or assign any available.",
        },
      },
      required: ["booking_id", "new_date", "new_time_slot", "staff_id"],
    },
  },
] as const;

export type RealtimeTool = (typeof REALTIME_TOOLS)[number];
