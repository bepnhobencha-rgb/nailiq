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
      "Cancel an existing booking. Provide ONE of: booking_id, group_id, or customer_phone.\n\n" +
      "MODE A — booking_id provided: Cancels a single booking immediately. " +
      "Use for individual bookings OR for partial group cancellation (one member at a time).\n\n" +
      "MODE GROUP — group_id provided: Cancels ALL bookings in a group at once. " +
      "Use only when the customer confirms they want to cancel the WHOLE group.\n\n" +
      "MODE B — customer_phone provided (no booking_id/group_id): Looks up upcoming bookings WITHOUT cancelling. " +
      "Returns booking details with confirmation_required: true.\n" +
      "If is_group_booking: true → ask 'Huỷ cả nhóm hay chỉ một số người?' BEFORE deciding which mode to use next:\n" +
      "  • Whole group → call again with group_id\n" +
      "  • Partial → read each member slot, get confirmation, call again with booking_id for each person to cancel.\n\n" +
      "ALWAYS get verbal confirmation BEFORE passing booking_id or group_id.\n" +
      "After cancellation: thank them and invite to rebook. For partial: confirm count e.g. 'Đã huỷ 2 người, 6 người còn lại giữ nguyên.'",
    parameters: {
      type: "object" as const,
      properties: {
        booking_id: {
          type: "string",
          description: "UUID of a single booking to cancel. Use for individual bookings only.",
        },
        group_id: {
          type: "string",
          description: "UUID of a group booking to cancel ALL members at once. Use when is_group_booking: true in the phone lookup result.",
        },
        customer_phone: {
          type: "string",
          description: "Customer's phone number for lookup mode. Returns booking details without cancelling.",
        },
        reason: {
          type: "string",
          description: "Short reason the customer gave for cancelling. Optional.",
        },
      },
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
  // ─── Group booking tools ──────────────────────────────────────────
  {
    type: "function" as const,
    name: "get_group_available_slots",
    description:
      "Get available time arrangements for a GROUP booking (2 or more people). " +
      "ALWAYS call this — never use get_available_slots for group bookings. " +
      "Returns 1–3 voice-friendly time options the customer can choose from. " +
      "Ask the customer how many people and what services, then call this tool. " +
      "Do NOT collect each person's name — only total count per service type.",
    parameters: {
      type: "object" as const,
      properties: {
        service_assignments: {
          type: "array",
          description:
            "List of service types and how many people want each. " +
            "E.g. [{service_id: 'abc', count: 3}, {service_id: 'def', count: 2}]",
          items: {
            type: "object",
            properties: {
              service_id: { type: "string", description: "Service ID from the services list in context." },
              count:      { type: "number", description: "Number of people wanting this service (must be ≥ 1)." },
            },
            required: ["service_id", "count"],
          },
        },
        date: {
          type: "string",
          description:
            "Date in YYYY-MM-DD format. Resolve relative expressions " +
            "(today, tomorrow, this Saturday, ngày mai, thứ bảy...) using today's date from context.",
        },
        mode: {
          type: "string",
          enum: ["sync_start", "sync_finish"],
          description:
            "Arrival preference: " +
            "'sync_start' = everyone arrives and starts together (default if customer is unsure); " +
            "'sync_finish' = everyone finishes at the same time. " +
            "Ask: 'Do you want everyone to arrive together, or finish at the same time?'",
        },
        target_time: {
          type: "string",
          description:
            "Desired time in HH:MM (24-hour) format in the salon's local timezone. " +
            "For sync_start: the preferred arrival time (e.g. '14:00' for 2 PM). " +
            "For sync_finish: the desired finish time. " +
            "Convert from customer's natural language: '2 PM' → '14:00', '10:30 AM' → '10:30'.",
        },
      },
      required: ["service_assignments", "date", "target_time"],
    },
  },
  {
    type: "function" as const,
    name: "confirm_group_booking",
    description:
      "Confirm and save a group booking after the customer agrees to a specific time slot. " +
      "MUST be called to actually create the group booking — verbal agreement alone does nothing. " +
      "Trigger words: yes / ok / sure / đồng ý / được / vâng / ừ / xác nhận / đặt luôn / đặt đi. " +
      "After success: tell the customer their party link will be sent separately — " +
      "do NOT read out each person's individual assignment over voice. " +
      "Just say the group start time, end time, and that a party link is ready for sharing.",
    parameters: {
      type: "object" as const,
      properties: {
        service_assignments: {
          type: "array",
          description: "Same service_assignments used in get_group_available_slots.",
          items: {
            type: "object",
            properties: {
              service_id: { type: "string" },
              count:      { type: "number" },
            },
            required: ["service_id", "count"],
          },
        },
        date: {
          type: "string",
          description: "Date in YYYY-MM-DD format.",
        },
        time: {
          type: "string",
          description:
            "The chosen group start time in HH:MM (24-hour) format — taken from get_group_available_slots result. " +
            "For sync_finish mode, this is the desired finish time.",
        },
        mode: {
          type: "string",
          enum: ["sync_start", "sync_finish"],
          description: "Same mode used in get_group_available_slots.",
        },
        organizer_name: {
          type: "string",
          description: "Full name of the person calling to organize the group booking.",
        },
        organizer_phone: {
          type: "string",
          description: "Phone number of the organizer, including country code if provided.",
        },
      },
      required: ["service_assignments", "date", "time", "mode", "organizer_name", "organizer_phone"],
    },
  },
] as const;

export type RealtimeTool = (typeof REALTIME_TOOLS)[number];
