/** Tool definitions injected into the OpenAI Realtime session. */

export const REALTIME_TOOLS = [
  {
    type: "function" as const,
    name: "request_otp",
    description:
      "Send a 6-digit verification code by SMS to a phone number. Call this BEFORE any " +
      "booking change (confirm_booking / cancel_booking / reschedule_booking / confirm_group_booking) " +
      "unless the tool result already said the caller is verified. Tell the customer you are texting a code and to read it back.",
    parameters: {
      type: "object" as const,
      properties: {
        customer_phone: { type: "string", description: "The phone number to verify — the one that OWNS the booking being changed, or the customer's number for a new booking." },
      },
      required: ["customer_phone"],
    },
  },
  {
    type: "function" as const,
    name: "verify_otp",
    description:
      "Check the 6-digit code the customer read back. On success it returns an otp_session_id — " +
      "pass that to confirm_booking / cancel_booking / reschedule_booking / confirm_group_booking. " +
      "If it fails, offer to resend with request_otp.",
    parameters: {
      type: "object" as const,
      properties: {
        customer_phone: { type: "string", description: "The same phone number passed to request_otp." },
        code:           { type: "string", description: "The 6-digit code the customer read back." },
      },
      required: ["customer_phone", "code"],
    },
  },
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
      "This is a two-stage write: the first call returns the authoritative price without creating; read that price back and make a second call with confirmed_pricing_fingerprint only after a new clear yes. " +
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
        otp_session_id: { type: "string", description: "The otp_session_id from verify_otp for this phone (required unless the caller is already verified). Omit only if a prior tool result said verification is not needed." },
        confirmed_pricing_fingerprint: { type: "string", description: "Second-call only. Copy the exact pricing_fingerprint returned by pricing_confirmation_required only after reading back its exact total/currency and the caller's latest reply is a clear yes. Never invent or reuse it after any booking detail changes." },
        upsell_accepted: { type: "boolean", description: "Set true ONLY when this booking is the result of the customer accepting your upsell (an upgrade or added service you offered). Leave unset otherwise." },
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
      "If the server returns late_fee_confirmation_required, disclose the exact amount and call again with late_fee_acknowledged=true ONLY after a clear yes. " +
      "If it returns late_fee_requires_staff, do not cancel or charge; transfer to salon staff.\n" +
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
        otp_session_id: {
          type: "string",
          description: "The otp_session_id from verify_otp for the phone that OWNS this booking. Required to actually cancel (Path A with booking_id); not needed for the lookup step.",
        },
        late_fee_acknowledged: {
          type: "boolean",
          description:
            "Set to true only after cancel_booking returns late_fee_confirmation_required and the verified customer clearly agrees to the exact fee amount. Never set this pre-emptively.",
        },
        late_fee_confirmation_token: {
          type: "string",
          description:
            "Opaque signed token returned by late_fee_confirmation_required. Pass it back unchanged together with late_fee_acknowledged=true after the customer's new explicit yes.",
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
        otp_session_id: {
          type: "string",
          description: "The otp_session_id from verify_otp for the phone that OWNS this booking (required unless the caller is already verified).",
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
      "Do NOT collect each person's name — only total count per service type. " +
      "If the result has isWaveOption: true, the party is larger than the staff " +
      "available at once, so it is split into WAVES (see the `waves` array): explain " +
      "simply, e.g. \"Your party is larger than the staff free at that time, so I found " +
      "a 2-wave option: 6 guests at 2:00 PM and 4 guests at 3:15 PM — does that work?\" " +
      "Read only the wave start times and counts; never list individual people.",
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
      "Two-stage group quote/create. First call after the customer agrees to a time returns the authoritative total and creates nothing. " +
      "Read that exact total/currency, get a new clear yes, then call again with confirmed_pricing_fingerprint to create. " +
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
        otp_session_id: {
          type: "string",
          description: "The otp_session_id from verify_otp for the organizer's phone (required unless the caller is already verified).",
        },
        confirmed_pricing_fingerprint: {
          type: "string",
          description:
            "Exact pricing_fingerprint returned by the previous confirm_group_booking quote call. Send it only after reading the exact total/currency and receiving a clear yes.",
        },
      },
      required: ["service_assignments", "date", "time", "mode", "organizer_name", "organizer_phone"],
    },
  },
  // ─── Waitlist ─────────────────────────────────────────────────────────────
  {
    type: "function" as const,
    name: "join_waitlist",
    description:
      "Add the customer to the WAITLIST for a service on a specific date when nothing is available — " +
      "i.e. get_available_slots returned count 0, OR the exact time the customer wanted is full and they " +
      "don't want any of the alternatives you offered. When a matching slot later frees up (a cancellation " +
      "or no-show), the salon notifies the customer automatically by SMS so they can grab it.\n\n" +
      "ONLY call this AFTER you have offered the real alternatives (other times that day, or another day) " +
      "and the customer explicitly agrees to be put on the waitlist instead. Get verbal agreement first — " +
      "e.g. 'Bạn muốn tôi ghi vào danh sách chờ, có chỗ trống sẽ nhắn tin cho bạn nhé?'\n\n" +
      "This does NOT create a booking — it only records interest. Never tell the customer they are booked.",
    parameters: {
      type: "object" as const,
      properties: {
        service_id:     { type: "string", description: "Service ID from the services list in context." },
        date:           { type: "string", description: "Wanted date in YYYY-MM-DD format. Resolve relative expressions (tomorrow, this Saturday, ngày mai...) using today's date from context." },
        customer_name:  { type: "string", description: "Customer's full name as they stated it." },
        customer_phone: { type: "string", description: "Customer's phone number, including country code if provided. The waitlist SMS goes here." },
        staff_id:       { type: "string", description: "Staff ID if the customer wants a specific person, or 'any' / omit for no preference." },
        preferred_time: { type: "string", description: "Optional. The specific time label the customer wanted, e.g. '2:00 PM', if they asked for one. Omit for a whole-day wait." },
      },
      required: ["service_id", "date", "customer_name", "customer_phone"],
    },
  },
  // ─── Customer memory ──────────────────────────────────────────────────────
  // ─── Escalation to a human ───────────────────────────────────────────────
  // ─── Call control ─────────────────────────────────────────────────────────
  {
    type: "function" as const,
    name: "lookup_customer",
    description:
      "Look up what the salon already knows about a customer by phone number: name, visit count, " +
      "usual service, usual staff, allergies, favorite colors/styles. " +
      "Call this IMMEDIATELY the first time the customer provides their phone number in the conversation — " +
      "BEFORE confirming any booking — so you can greet returning customers by name and offer their usual. " +
      "If the result has known: false, treat them as a new customer and never mention the lookup. " +
      "This tool only reads — it never books or changes anything.",
    parameters: {
      type: "object" as const,
      properties: {
        customer_phone: {
          type: "string",
          description: "Customer's phone number, including country code if provided.",
        },
      },
      required: ["customer_phone"],
    },
  },
  {
    type: "function" as const,
    name: "leave_message_for_owner",
    description:
      "Take a message for the salon owner when the customer needs something BEYOND your tools: " +
      "a complaint, refund/payment issue, price negotiation, special request, or anything you are unsure about. " +
      "FIRST tell the customer you'll pass their message to the owner, collect their name + phone + the message, " +
      "THEN call this tool. Use urgency 'urgent' only for complaints or time-sensitive issues. " +
      "After success, confirm only that the message was saved for salon staff. It appears in Dashboard > " +
      "Nhật ký hoạt động > AI. Never claim a notification or callback happened unless a tool explicitly confirms it. " +
      "NEVER argue with an upset customer — take the message instead.",
    parameters: {
      type: "object" as const,
      properties: {
        message:        { type: "string", description: "The customer's message, summarised faithfully in their own language." },
        customer_name:  { type: "string", description: "Customer's name as they stated it." },
        customer_phone: { type: "string", description: "Customer's callback phone number." },
        urgency: {
          type: "string",
          enum: ["normal", "urgent"],
          description: "'urgent' for complaints or time-sensitive issues; otherwise 'normal'.",
        },
      },
      required: ["message"],
    },
  },
  {
    type: "function" as const,
    name: "wait_for_user",
    description:
      "Use this no-op when there is no clear speech addressed to you: silence, room noise, TV/radio, " +
      "or a side conversation between other people. After calling it, say NOTHING and keep listening. " +
      "Do not use it when the customer clearly addressed you but one detail was unclear — ask one short " +
      "clarifying question in that case.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    type: "function" as const,
    name: "end_call",
    description:
      "End the voice call gracefully — calling this HANGS UP the phone.\n" +
      "Call it ONLY as the last step of this exact closing sequence:\n" +
      "1. After any successful action (booking / group booking / cancel / reschedule / waitlist): read the summary, ask if the customer needs anything else, and WAIT for their answer. Do NOT call end_call at this step.\n" +
      "2. Only when the customer says goodbye (tạm biệt / bye / thôi tôi cúp máy / xong rồi / thôi được rồi) or clearly says they need nothing else: say ONE short farewell sentence. A closing cảm ơn after you asked whether they need anything else also means they are done.\n" +
      "3. THEN call end_call — in the same turn as the farewell, never before speaking it.\n" +
      "A successful tool result is NEVER by itself a reason to call end_call, and never call it in the same turn as a booking summary.",
    parameters: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
] as const;

export type RealtimeTool = (typeof REALTIME_TOOLS)[number];

const PHONE_HUMAN_TRANSFER_TOOL = {
  type: "function" as const,
  name: "transfer_to_human",
  description:
    "Transfer this live PHONE call to the salon's configured human destination. " +
    "Use when the caller explicitly asks for a person, manager, or staff member. " +
    "For a request outside your tools, briefly explain that a human is needed and ask permission before transferring. " +
    "First collect a concise reason and, when available, the caller's name. The carrier-verified caller number is already known. " +
    "Never ask for or choose the destination number; the server uses the owner's protected setting. " +
    "Do not use for emergencies: tell the caller to contact local emergency services. " +
    "If the tool says transfer is unavailable, apologise and use leave_message_for_owner instead.",
  parameters: {
    type: "object" as const,
    properties: {
      reason: {
        type: "string",
        description: "Brief, faithful reason for the handoff in the caller's language.",
      },
      customer_name: {
        type: "string",
        description: "Caller's name if they provided it.",
      },
      urgency: {
        type: "string",
        enum: ["normal", "urgent"],
        description: "'urgent' only for a serious complaint or time-sensitive salon matter.",
      },
    },
    required: ["reason"],
  },
} as const;

const PHONE_TOOL_DESCRIPTIONS: Record<string, string> = {
  request_otp: "Send a 6-digit OTP to verify a different booking phone before a write.",
  verify_otp: "Verify the OTP and return otp_session_id for the next write.",
  get_available_slots: "Read real available times for one service/date before offering or booking.",
  confirm_booking: "Create one booking only after exact readback and clear caller consent.",
  find_booking: "Read upcoming bookings for cancellation or rescheduling.",
  cancel_booking: "Look up or cancel a booking/group; cancel only after exact confirmation.",
  reschedule_booking: "Move an existing booking to a slot already verified as available.",
  get_group_available_slots: "Read valid arrangements for a group of two or more.",
  confirm_group_booking: "Create a group booking only after exact readback and clear consent.",
  join_waitlist: "Join the waitlist only after no suitable slot and clear consent.",
  lookup_customer: "Read the caller profile by phone; never reveal internal profile details.",
  leave_message_for_owner: "Record an unsupported request, complaint, or owner callback message.",
  wait_for_user: "No-op for silence, noise, TV, or side speech; say nothing after calling.",
  end_call:
    "Request a graceful phone hangup only after the caller is done. Say nothing before calling it; the phone bridge speaks the approved farewell and hangs up after playback.",
};

function withoutSchemaDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSchemaDescriptions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "description")
      .map(([key, nested]) => [key, withoutSchemaDescriptions(nested)]),
  );
}

/**
 * Phone sessions already carry the operational rules in a compact system
 * prompt. Remove duplicated, deeply nested prose from JSON schemas while
 * retaining every tool name, field, enum, type, and required constraint.
 */
export const PHONE_REALTIME_TOOLS = [
  ...REALTIME_TOOLS.map((tool) => ({
    ...tool,
    description: PHONE_TOOL_DESCRIPTIONS[tool.name],
    parameters: withoutSchemaDescriptions(tool.parameters),
  })),
  PHONE_HUMAN_TRANSFER_TOOL,
];
