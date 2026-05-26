/** Tool definitions injected into the OpenAI Realtime session. */

export const REALTIME_TOOLS = [
  {
    type: "function" as const,
    name: "get_available_slots",
    description:
      "Get available booking time slots for a specific service on a given date. " +
      "ALWAYS call this before mentioning any times. Never invent or assume availability.",
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
      "Create the booking after the customer has explicitly confirmed all details. " +
      "ONLY call after the customer says yes, đồng ý, confirm, or an unambiguous affirmative. " +
      "Never call speculatively.",
    parameters: {
      type: "object" as const,
      properties: {
        service_id: {
          type: "string",
          description: "Service ID.",
        },
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format.",
        },
        time_slot: {
          type: "string",
          description: "Exact time slot label returned by get_available_slots, e.g. '2:00 PM'.",
        },
        staff_id: {
          type: "string",
          description: "Staff ID, or 'any' for no preference.",
        },
        customer_name: {
          type: "string",
          description: "Customer's full name as they stated it.",
        },
        customer_phone: {
          type: "string",
          description: "Customer's phone number, including country code if provided.",
        },
      },
      required: ["service_id", "date", "time_slot", "staff_id", "customer_name", "customer_phone"],
    },
  },
] as const;

export type RealtimeTool = (typeof REALTIME_TOOLS)[number];
