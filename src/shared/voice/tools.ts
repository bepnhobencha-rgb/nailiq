/**
 * OpenAI Realtime API tool definitions for voice booking.
 * Injected into the session on creation — client executes them when AI calls.
 */

export const VOICE_TOOLS = [
  {
    type: "function" as const,
    name: "get_available_slots",
    description:
      "Get available time slots for a service on a specific date. " +
      "ALWAYS call this before mentioning any times or confirming availability. " +
      "Never invent or assume slots.",
    parameters: {
      type: "object" as const,
      properties: {
        service_id: {
          type: "string",
          description: "Service ID from the services list",
        },
        date: {
          type: "string",
          description:
            "Date in YYYY-MM-DD format. Resolve relative dates (today, tomorrow, this Friday) using today's date from context.",
        },
        staff_id: {
          type: "string",
          description:
            "Optional staff ID. Omit or pass 'any' if customer has no preference.",
        },
      },
      required: ["service_id", "date"],
    },
  },
  {
    type: "function" as const,
    name: "confirm_booking",
    description:
      "Create the booking after the customer has explicitly confirmed all details. " +
      "Only call AFTER customer says yes/confirm/đồng ý or equivalent. " +
      "Never call without explicit confirmation.",
    parameters: {
      type: "object" as const,
      properties: {
        service_id: {
          type: "string",
          description: "Service ID",
        },
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format",
        },
        time_slot: {
          type: "string",
          description: "Exact time slot label from get_available_slots, e.g. '2:00 PM'",
        },
        staff_id: {
          type: "string",
          description: "Staff ID, or 'any' for no preference",
        },
        customer_name: {
          type: "string",
          description: "Customer's name as they stated it",
        },
        customer_phone: {
          type: "string",
          description: "Customer's phone number",
        },
      },
      required: [
        "service_id",
        "date",
        "time_slot",
        "staff_id",
        "customer_name",
        "customer_phone",
      ],
    },
  },
] as const;
