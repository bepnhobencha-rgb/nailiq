import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  sendClaimed: vi.fn(),
  sendEmail: vi.fn(),
  generateReminderToken: vi.fn(),
  loadSequenceReceipt: vi.fn(),
  captureException: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/booking/claimedConfirmationSms", () => ({
  sendClaimedBookingConfirmationSms: mocks.sendClaimed,
  isTwilioMessageReceipt: (value: unknown) =>
    typeof value === "string" && /^(?:SM|MM)[0-9a-fA-F]{32}$/.test(value),
  classifyDurableConfirmationStatus: (status: unknown, messageSid: unknown) => {
    if (status === "sent" || status === "delivered") {
      return typeof messageSid === "string" &&
        /^(?:SM|MM)[0-9a-fA-F]{32}$/.test(messageSid)
        ? {
            complete: true,
            outcome: "accepted",
            reason:
              status === "delivered" ? "durable_delivered" : "durable_sent",
            messageSid,
          }
        : {
            complete: false,
            outcome: "unknown",
            reason: `durable_${status}_receipt_invalid`,
            messageSid: null,
          };
    }
    if (status === "suppressed") {
      return messageSid == null || messageSid === ""
        ? {
            complete: true,
            outcome: "suppressed",
            reason: "durable_suppressed",
            messageSid: null,
          }
        : {
            complete: false,
            outcome: "unknown",
            reason: "durable_suppressed_receipt_present",
            messageSid: null,
          };
    }
    return {
      complete: false,
      outcome: "unknown",
      reason:
        status === "sending" || status === "unknown" || status === "failed"
          ? `durable_${status}`
          : "durable_status_unreadable",
      messageSid: null,
    };
  },
}));
vi.mock("@/shared/booking/sendBookingConfirmationEmail", () => ({
  sendBookingConfirmationEmail: mocks.sendEmail,
}));
vi.mock("@/shared/noshow/generateReminderToken", () => ({
  generateReminderToken: mocks.generateReminderToken,
}));
vi.mock("@/shared/booking/bookingSequenceReceiptServer", () => ({
  loadBookingSequenceReceipt: mocks.loadSequenceReceipt,
}));
vi.mock("@/shared/observability/errorReporter", () => ({
  captureException: mocks.captureException,
}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumeDurableRateLimitBuckets: mocks.rateLimit,
}));

import { POST } from "@/app/api/booking/sms-confirm/route";

const bookingId = "11111111-1111-4111-8111-111111111111";
const memberId = "22222222-2222-4222-8222-222222222222";
const salonId = "33333333-3333-4333-8333-333333333333";
const serviceId = "44444444-4444-4444-8444-444444444444";
const staffId = "55555555-5555-4555-8555-555555555555";
const groupId = "66666666-6666-4666-8666-666666666666";

type Fixture = {
  booking: Record<string, unknown>;
  salon?: Record<string, unknown>;
  service?: Record<string, unknown> | null;
  staff?: Record<string, unknown> | null;
  profile?: Record<string, unknown> | null;
  groupMembers?: Record<string, unknown>[];
  groupQueryError?: boolean;
  statusQueryError?: boolean;
  confirmationRows?: Record<string, Record<string, unknown>>;
};

function makeDb(fixture: Fixture) {
  const queries: Array<{
    table: string;
    selection: string;
    operation: "select" | "update" | "none";
    filters: Array<[string, string, unknown]>;
    updatePatch?: unknown;
  }> = [];

  const from = vi.fn((table: string) => {
    const query = {
      table,
      selection: "",
      operation: "none" as "select" | "update" | "none",
      filters: [] as Array<[string, string, unknown]>,
      updatePatch: undefined as unknown,
    };
    queries.push(query);

    const resultForSingle = () => {
      if (table === "bookings") return fixture.booking;
      if (table === "salons") {
        return (
          fixture.salon ?? {
            name: "Server Salon",
            slug: "server-salon",
            address: "123 Server Street",
            sms_outbound_enabled: true,
            sms_a2p_registered: true,
            email_outbound_enabled: false,
            timezone: "UTC",
            default_notification_locale: "en",
          }
        );
      }
      if (table === "services") return fixture.service ?? { name: "Server Service" };
      if (table === "staff") return fixture.staff ?? { name: "Server Staff" };
      if (table === "client_profiles") return fixture.profile ?? null;
      if (table === "customer_preferences") return null;
      if (table === "booking_notifications") {
        const bookingFilter = query.filters.find(
          ([kind, column]) => kind === "eq" && column === "booking_id",
        );
        return bookingFilter
          ? fixture.confirmationRows?.[String(bookingFilter[2])] ?? null
          : null;
      }
      return null;
    };

    const builder: Record<string, unknown> & PromiseLike<unknown> = {
      select: vi.fn((selection: string) => {
        query.operation = "select";
        query.selection = selection;
        return builder;
      }),
      update: vi.fn((patch: unknown) => {
        query.operation = "update";
        query.updatePatch = patch;
        return builder;
      }),
      upsert: vi.fn(async () => ({ error: null })),
      eq: vi.fn((column: string, value: unknown) => {
        query.filters.push(["eq", column, value]);
        return builder;
      }),
      is: vi.fn((column: string, value: unknown) => {
        query.filters.push(["is", column, value]);
        return builder;
      }),
      not: vi.fn((column: string, operator: string, value: unknown) => {
        query.filters.push([`not:${operator}`, column, value]);
        return builder;
      }),
      neq: vi.fn((column: string, value: unknown) => {
        query.filters.push(["neq", column, value]);
        return builder;
      }),
      maybeSingle: vi.fn(async () => ({
        data: fixture.statusQueryError && table === "booking_notifications"
          ? null
          : resultForSingle(),
        error: fixture.statusQueryError && table === "booking_notifications"
          ? { message: "status query failed" }
          : null,
      })),
      then: (resolve, reject) => {
        const result =
          table === "bookings" && query.operation === "select"
            ? fixture.groupQueryError
              ? { data: null, error: { message: "group query failed" } }
              : { data: fixture.groupMembers ?? [], error: null }
            : { data: null, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  });

  return { db: { from } as never, queries };
}

function individualBooking(): Record<string, unknown> {
  return {
    id: bookingId,
    salon_id: salonId,
    group_id: null,
    group_size: null,
    status: "confirmed",
    client_phone: "16045101234",
    client_name: "Server Customer",
    service_id: serviceId,
    staff_id: staffId,
    start_time_utc: "2026-09-01T18:00:00.000Z",
  };
}

function organizerGroupBooking(): Record<string, unknown> {
  return { ...individualBooking(), group_id: groupId, group_size: 2 };
}

function consentedMember(): Record<string, unknown> {
  return {
    id: memberId,
    salon_id: salonId,
    status: "confirmed",
    client_name: "Member",
    client_phone: "16045104321",
    start_time_utc: "2026-09-01T19:00:00.000Z",
    sms_consent_at: "2026-08-20T00:00:00.000Z",
    service: { name: "Member Service" },
    staff: { name: "Member Staff" },
  };
}

function request(body: Record<string, unknown>): Request {
  return new Request("https://nailiq.test/api/booking/sms-confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("booking confirmation SMS runtime boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rateLimit.mockResolvedValue("allowed");
    mocks.sendClaimed.mockResolvedValue({
      outcome: "accepted",
      reason: "provider_accepted",
      claimId: "claim-organizer",
      messageSid: `SM${"a".repeat(32)}`,
      claimFinalized: true,
    });
    mocks.generateReminderToken.mockResolvedValue({
      id: "token-1",
      expiresAt: "2026-09-01T18:00:00.000Z",
    });
    mocks.loadSequenceReceipt.mockResolvedValue({
      ok: false,
      code: "not_sequence",
    });
  });

  it("ignores spoofed body facts and dispatches persisted recipient/catalog facts", async () => {
    const harness = makeDb({ booking: individualBooking() });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);

    const response = await POST(
      request({
        bookingId,
        salonId,
        clientPhone: "+19999999999",
        clientName: "Attacker Name",
        serviceName: "Free Attacker Service",
        staffName: "Attacker Staff",
        startTimeUtc: "2030-01-01T00:00:00.000Z",
        partySize: 9,
        language: "en",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
    const dispatch = mocks.sendClaimed.mock.calls[0]?.[0] as {
      clientPhone: string;
      message: string;
    };
    expect(dispatch.clientPhone).toBe("16045101234");
    expect(dispatch.message).toContain("Server Service");
    expect(dispatch.message).toContain("Server Staff");
    expect(dispatch.message).not.toMatch(/Attacker|Free Attacker|2030/);
  });

  it("renders a sequence confirmation only from the persisted sequence receipt", async () => {
    const harness = makeDb({
      booking: {
        ...individualBooking(),
        schedule_model: "segments_v1",
        start_time_utc: "2030-01-01T00:00:00.000Z",
      },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.loadSequenceReceipt.mockResolvedValue({
      ok: true,
      receipt: {
        bookingId,
        salonId,
        status: "confirmed",
        parentStartTimeUtc: "2026-09-02T19:00:00.000Z",
        segments: [
          {
            serviceName: "Persisted Manicure",
            staffName: "Alice",
            resolvedStaffId: staffId,
          },
          {
            serviceName: "Persisted Pedicure",
            staffName: "Bob",
            resolvedStaffId: memberId,
          },
        ],
      },
    });

    const response = await POST(request({
      bookingId,
      salonId,
      language: "en",
      smsConsent: true,
      serviceName: "Spoofed Free Service",
      staffName: "Spoofed Staff",
      startTimeUtc: "2040-01-01T00:00:00.000Z",
    }));

    expect(response.status).toBe(200);
    expect(mocks.loadSequenceReceipt).toHaveBeenCalledWith({ salonId, bookingId });
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
    const dispatch = mocks.sendClaimed.mock.calls[0]?.[0] as { message: string };
    expect(dispatch.message).toContain("Persisted Manicure + Persisted Pedicure");
    expect(dispatch.message).toContain("Alice, Bob");
    expect(dispatch.message).not.toMatch(/Spoofed|2030|2040/);
    expect(harness.queries.some((query) => query.table === "services")).toBe(false);
    expect(harness.queries.some((query) => query.table === "staff")).toBe(false);
    expect(harness.queries.some((query) =>
      query.table === "bookings" && query.operation === "update" &&
      Boolean((query.updatePatch as { sms_consent_at?: unknown })?.sms_consent_at)
    )).toBe(true);
  });

  it("fails closed before consent, claim, or provider when a sequence receipt is unavailable", async () => {
    const harness = makeDb({
      booking: { ...individualBooking(), schedule_model: "segments_v1" },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.loadSequenceReceipt.mockResolvedValue({
      ok: false,
      code: "sequence_receipt_unavailable",
    });

    const response = await POST(request({
      bookingId,
      salonId,
      language: "en",
      smsConsent: true,
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "sequence_receipt_unavailable",
    });
    expect(mocks.sendClaimed).not.toHaveBeenCalled();
    expect(mocks.generateReminderToken).not.toHaveBeenCalled();
    expect(harness.queries.some((query) => query.operation === "update")).toBe(false);
  });

  it.each([
    ["waiting", "booking_waiting_not_confirmed"],
    ["pending", "booking_pending_not_confirmed"],
    ["cancelled", "booking_cancelled_not_sendable"],
    ["no_show", "booking_no_show_not_sendable"],
    ["completed", "booking_completed_not_sendable"],
  ])(
    "does not claim or send a customer confirmation for a %s booking",
    async (status, reason) => {
      const harness = makeDb({
        booking: { ...individualBooking(), status },
      });
      mocks.createServiceRoleClient.mockReturnValue(harness.db);

      const response = await POST(
        request({ bookingId, salonId, language: "en" }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        outcome: "not_sent",
        reason,
        bookingStatus: status,
      });
      expect(mocks.sendClaimed).not.toHaveBeenCalled();
      expect(
        harness.queries.some((query) => query.table === "booking_notifications"),
      ).toBe(false);
    },
  );

  it("fails closed before a claim when booking status is unreadable", async () => {
    const harness = makeDb({
      booking: { ...individualBooking(), status: null },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);

    const response = await POST(
      request({ bookingId, salonId, language: "en" }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      outcome: "not_sent",
      reason: "booking_status_unreadable",
    });
    expect(mocks.sendClaimed).not.toHaveBeenCalled();
  });

  it("routes an outbound-disabled salon through durable suppression", async () => {
    const harness = makeDb({
      booking: individualBooking(),
      salon: {
        name: "Server Salon",
        slug: "server-salon",
        sms_outbound_enabled: false,
        sms_a2p_registered: true,
        email_outbound_enabled: false,
        timezone: "UTC",
        default_notification_locale: "en",
      },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed.mockResolvedValue({
      outcome: "suppressed",
      reason: "outbound_disabled",
      claimId: "claim-organizer",
      messageSid: null,
      claimFinalized: true,
    });

    const response = await POST(request({ bookingId, salonId, language: "en" }));

    expect(response.status).toBe(200);
    expect(mocks.sendClaimed).toHaveBeenCalledWith(
      expect.objectContaining({ suppressionReason: "outbound_disabled" }),
    );
    expect(mocks.generateReminderToken).not.toHaveBeenCalled();
  });

  it("suppresses a US recipient when the salon is not affirmatively A2P registered", async () => {
    const harness = makeDb({
      booking: { ...individualBooking(), client_phone: "17145101234" },
      salon: {
        name: "Server Salon",
        slug: "server-salon",
        sms_outbound_enabled: true,
        sms_a2p_registered: false,
        email_outbound_enabled: false,
        timezone: "UTC",
        default_notification_locale: "en",
      },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed.mockResolvedValue({
      outcome: "suppressed",
      reason: "a2p_not_registered",
      claimId: "claim-organizer",
      messageSid: null,
      claimFinalized: true,
    });

    const response = await POST(request({ bookingId, salonId, language: "en" }));

    expect(response.status).toBe(200);
    expect(mocks.sendClaimed).toHaveBeenCalledWith(
      expect.objectContaining({ suppressionReason: "a2p_not_registered" }),
    );
    expect(mocks.generateReminderToken).not.toHaveBeenCalled();
  });

  it("surfaces claim loss as unknown without authorizing group fanout", async () => {
    const harness = makeDb({ booking: individualBooking() });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed.mockResolvedValue({
      outcome: "unknown",
      reason: "claim_unavailable",
      claimId: null,
      messageSid: null,
      claimFinalized: false,
    });

    const response = await POST(request({ bookingId, salonId, language: "en" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      outcome: "unknown",
      reason: "claim_completion_failed:claim_unavailable",
      claimFinalized: false,
    });
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
    // A read-only status capability may be embedded before the notification
    // claim resolves; the claim-loss branch still performs zero provider send
    // and never mints confirm/reschedule/cancel authority.
    expect(mocks.generateReminderToken).toHaveBeenCalledWith(
      bookingId,
      salonId,
      expect.objectContaining({ action: "status" }),
    );
  });

  it("returns 200 for an individual duplicate only when the durable row is sent with a valid receipt", async () => {
    const sid = `SM${"d".repeat(32)}`;
    const harness = makeDb({
      booking: individualBooking(),
      confirmationRows: {
        [bookingId]: { status: "sent", twilio_message_sid: sid },
      },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed.mockResolvedValue({
      outcome: "suppressed",
      reason: "duplicate",
      claimId: null,
      messageSid: null,
      claimFinalized: true,
    });

    const response = await POST(request({ bookingId, salonId, language: "en" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      outcome: "accepted",
      reason: "durable_sent",
      messageSid: sid,
    });
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
  });

  it("accepts a durably delivered individual duplicate only with an exact Twilio receipt", async () => {
    const sid = `MM${"9".repeat(32)}`;
    const harness = makeDb({
      booking: individualBooking(),
      confirmationRows: {
        [bookingId]: { status: "delivered", twilio_message_sid: sid },
      },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed.mockResolvedValue({
      outcome: "suppressed",
      reason: "duplicate",
      claimId: null,
      messageSid: null,
      claimFinalized: true,
    });

    const response = await POST(request({ bookingId, salonId, language: "en" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      outcome: "accepted",
      reason: "durable_delivered",
      messageSid: sid,
    });
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
  });

  it("returns 200 for a true durable suppression without a provider receipt", async () => {
    const harness = makeDb({
      booking: individualBooking(),
      confirmationRows: {
        [bookingId]: { status: "suppressed", twilio_message_sid: null },
      },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed.mockResolvedValue({
      outcome: "suppressed",
      reason: "duplicate",
      claimId: null,
      messageSid: null,
      claimFinalized: true,
    });

    const response = await POST(request({ bookingId, salonId, language: "en" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      outcome: "suppressed",
      reason: "durable_suppressed",
    });
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
  });

  it.each(["sending", "unknown", "failed"])(
    "returns 503 and never resends an individual duplicate whose durable status is %s",
    async (status) => {
      const harness = makeDb({
        booking: individualBooking(),
        confirmationRows: {
          [bookingId]: { status, twilio_message_sid: null },
        },
      });
      mocks.createServiceRoleClient.mockReturnValue(harness.db);
      mocks.sendClaimed.mockResolvedValue({
        outcome: "suppressed",
        reason: "duplicate",
        claimId: null,
        messageSid: null,
        claimFinalized: true,
      });

      const response = await POST(
        request({ bookingId, salonId, language: "en" }),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        outcome: "unknown",
        reason: `durable_${status}`,
      });
      expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      name: "a sent row with a malformed receipt",
      fixture: {
        status: "sent",
        twilio_message_sid: "SM_not_a_receipt",
      },
      reason: "durable_sent_receipt_invalid",
      statusQueryError: false,
    },
    {
      name: "a delivered row with a malformed receipt",
      fixture: {
        status: "delivered",
        twilio_message_sid: "MM_not_a_receipt",
      },
      reason: "durable_delivered_receipt_invalid",
      statusQueryError: false,
    },
    {
      name: "an unreadable row",
      fixture: null,
      reason: "status_missing",
      statusQueryError: false,
    },
    {
      name: "a status query failure",
      fixture: null,
      reason: "status_query_failed",
      statusQueryError: true,
    },
  ])("returns 503 and zero resend for $name", async ({ fixture, reason, statusQueryError }) => {
    const harness = makeDb({
      booking: individualBooking(),
      statusQueryError,
      confirmationRows: fixture ? { [bookingId]: fixture } : undefined,
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed.mockResolvedValue({
      outcome: "suppressed",
      reason: "duplicate",
      claimId: null,
      messageSid: null,
      claimFinalized: true,
    });

    const response = await POST(request({ bookingId, salonId, language: "en" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      outcome: "unknown",
      reason,
    });
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
  });

  it("surfaces an accepted provider result whose durable completion was lost", async () => {
    const harness = makeDb({
      booking: {
        ...individualBooking(),
        group_id: groupId,
        group_size: 2,
      },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    const messageSid = `SM${"c".repeat(32)}`;
    mocks.sendClaimed.mockResolvedValue({
      outcome: "accepted",
      reason: "provider_accepted",
      claimId: "claim-organizer",
      messageSid,
      claimFinalized: false,
    });

    const response = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );

    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      outcome: "accepted",
      reason: "claim_completion_failed:provider_accepted",
      claimFinalized: false,
      messageSid,
    });
    expect(response.status).toBe(503);
    expect(mocks.generateReminderToken).not.toHaveBeenCalled();
  });

  it("awaits a tenant-scoped, consented, separately claimed member dispatch", async () => {
    const harness = makeDb({
      booking: {
        ...individualBooking(),
        group_id: groupId,
        group_size: 2,
      },
      groupMembers: [
        {
          id: memberId,
          salon_id: salonId,
          status: "confirmed",
          client_name: "Member",
          client_phone: "16045104321",
          start_time_utc: "2026-09-01T19:00:00.000Z",
          sms_consent_at: "2026-08-20T00:00:00.000Z",
          service: { name: "Member Service" },
          staff: { name: "Member Staff" },
        },
      ],
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed
      .mockResolvedValueOnce({
        outcome: "accepted",
        reason: "provider_accepted",
        claimId: "claim-organizer",
        messageSid: `SM${"a".repeat(32)}`,
        claimFinalized: true,
      })
      .mockResolvedValueOnce({
        outcome: "accepted",
        reason: "provider_accepted",
        claimId: "claim-member",
        messageSid: `SM${"b".repeat(32)}`,
        claimFinalized: true,
      });

    const response = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(2);
    expect(mocks.sendClaimed).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        bookingId: memberId,
        salonId,
        clientPhone: "16045104321",
        message: expect.stringContaining("Member Service"),
      }),
    );
    const memberQuery = harness.queries.find((query) =>
      query.selection.includes("sms_consent_at, service:"),
    );
    expect(memberQuery?.filters).toEqual(
      expect.arrayContaining([
        ["eq", "group_id", groupId],
        ["eq", "salon_id", salonId],
        ["eq", "status", "confirmed"],
        ["not:is", "sms_consent_at", null],
        ["neq", "id", bookingId],
      ]),
    );
  });

  it("does not fan out from a duplicate organizer replay", async () => {
    const harness = makeDb({
      booking: {
        ...individualBooking(),
        group_id: groupId,
        group_size: 2,
      },
      groupMembers: [
        {
          id: memberId,
          salon_id: salonId,
          status: "confirmed",
          client_phone: "16045104321",
          start_time_utc: "2026-09-01T19:00:00.000Z",
          sms_consent_at: "2026-08-20T00:00:00.000Z",
          service: { name: "Member Service" },
          staff: { name: "Member Staff" },
        },
      ],
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed.mockResolvedValue({
      outcome: "suppressed",
      reason: "duplicate",
      claimId: null,
      messageSid: null,
      claimFinalized: true,
    });

    await POST(request({ bookingId, salonId, groupId, language: "en" }));

    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
    expect(mocks.generateReminderToken).not.toHaveBeenCalled();
  });

  it("returns structured incomplete when the member query fails", async () => {
    const harness = makeDb({
      booking: organizerGroupBooking(),
      groupQueryError: true,
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);

    const response = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      reason: "group_member_fanout_incomplete:member_query_failed",
      groupFanout: {
        complete: false,
        failures: [{ stage: "member_query", reason: "member_query_failed" }],
      },
    });
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
  });

  it("returns structured incomplete when a member token cannot be created", async () => {
    const harness = makeDb({
      booking: organizerGroupBooking(),
      groupMembers: [consentedMember()],
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.generateReminderToken.mockResolvedValueOnce(null);

    const response = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.groupFanout).toMatchObject({
      complete: false,
      eligible: 1,
      completed: 0,
      failures: [{ stage: "token", reason: "token_unavailable" }],
    });
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
  });

  it("surfaces member claim and finalize failures without another provider path", async () => {
    const harness = makeDb({
      booking: organizerGroupBooking(),
      groupMembers: [consentedMember()],
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed
      .mockResolvedValueOnce({
        outcome: "accepted",
        reason: "provider_accepted",
        claimId: "claim-organizer",
        messageSid: `SM${"a".repeat(32)}`,
        claimFinalized: true,
      })
      .mockResolvedValueOnce({
        outcome: "unknown",
        reason: "claim_unavailable",
        claimId: null,
        messageSid: null,
        claimFinalized: false,
      });

    const claimFailure = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );
    expect(claimFailure.status).toBe(503);
    await expect(claimFailure.json()).resolves.toMatchObject({
      groupFanout: {
        failures: [
          {
            stage: "member_claim",
            reason: "member_claim_unavailable",
          },
        ],
      },
    });

    vi.clearAllMocks();
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.generateReminderToken.mockResolvedValue({
      id: "token-1",
      expiresAt: "2026-09-01T18:00:00.000Z",
    });
    mocks.sendClaimed
      .mockResolvedValueOnce({
        outcome: "accepted",
        reason: "provider_accepted",
        claimId: "claim-organizer",
        messageSid: `SM${"a".repeat(32)}`,
        claimFinalized: true,
      })
      .mockResolvedValueOnce({
        outcome: "accepted",
        reason: "provider_accepted",
        claimId: "claim-member",
        messageSid: `SM${"b".repeat(32)}`,
        claimFinalized: false,
      });

    const finalizeFailure = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );
    expect(finalizeFailure.status).toBe(503);
    await expect(finalizeFailure.json()).resolves.toMatchObject({
      groupFanout: {
        failures: [
          {
            stage: "member_finalize",
            reason: "member_finalize_failed:provider_accepted",
          },
        ],
      },
    });
  });

  it("resumes missing members after the organizer was already durably sent", async () => {
    const harness = makeDb({
      booking: organizerGroupBooking(),
      groupMembers: [consentedMember()],
      confirmationRows: {
        [bookingId]: {
          status: "sent",
          twilio_message_sid: `SM${"a".repeat(32)}`,
        },
      },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.generateReminderToken
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "token-1",
        expiresAt: "2026-09-01T18:00:00.000Z",
      });
    mocks.sendClaimed
      .mockResolvedValueOnce({
        outcome: "accepted",
        reason: "provider_accepted",
        claimId: "claim-organizer",
        messageSid: `SM${"a".repeat(32)}`,
        claimFinalized: true,
      })
      .mockResolvedValueOnce({
        outcome: "suppressed",
        reason: "duplicate",
        claimId: null,
        messageSid: null,
        claimFinalized: true,
      })
      .mockResolvedValueOnce({
        outcome: "accepted",
        reason: "provider_accepted",
        claimId: "claim-member",
        messageSid: `SM${"b".repeat(32)}`,
        claimFinalized: true,
      });

    const first = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );
    expect(first.status).toBe(503);

    const retry = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      outcome: "accepted",
      reason: "durable_sent",
      groupFanout: { complete: true, eligible: 1, completed: 1 },
    });
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(3);
    expect(mocks.sendClaimed.mock.calls[1]?.[0]).toMatchObject({ bookingId });
    expect(mocks.sendClaimed.mock.calls[2]?.[0]).toMatchObject({
      bookingId: memberId,
    });
  });

  it("dedupes an already-sent member during organizer retry", async () => {
    const harness = makeDb({
      booking: organizerGroupBooking(),
      groupMembers: [consentedMember()],
      confirmationRows: {
        [bookingId]: {
          status: "sent",
          twilio_message_sid: `SM${"a".repeat(32)}`,
        },
        [memberId]: {
          status: "sent",
          twilio_message_sid: `SM${"b".repeat(32)}`,
        },
      },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed
      .mockResolvedValueOnce({
        outcome: "suppressed",
        reason: "duplicate",
        claimId: null,
        messageSid: null,
        claimFinalized: true,
      })
      .mockResolvedValueOnce({
        outcome: "suppressed",
        reason: "duplicate",
        claimId: null,
        messageSid: null,
        claimFinalized: true,
      });

    const response = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      groupFanout: { complete: true, eligible: 1, completed: 1 },
    });
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(2);
  });

  it("does not fan out when a duplicate organizer is durably unknown", async () => {
    const harness = makeDb({
      booking: organizerGroupBooking(),
      groupMembers: [consentedMember()],
      confirmationRows: {
        [bookingId]: { status: "unknown", twilio_message_sid: null },
      },
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);
    mocks.sendClaimed.mockResolvedValue({
      outcome: "suppressed",
      reason: "duplicate",
      claimId: null,
      messageSid: null,
      claimFinalized: true,
    });

    const response = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      outcome: "unknown",
      reason: "durable_unknown",
    });
    expect(mocks.generateReminderToken).not.toHaveBeenCalled();
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch an unconsented member even if a query mock leaks it", async () => {
    const harness = makeDb({
      booking: {
        ...individualBooking(),
        group_id: groupId,
        group_size: 2,
      },
      groupMembers: [
        {
          id: memberId,
          salon_id: salonId,
          status: "confirmed",
          client_phone: "16045104321",
          start_time_utc: "2026-09-01T19:00:00.000Z",
          sms_consent_at: null,
          service: { name: "Member Service" },
          staff: { name: "Member Staff" },
        },
      ],
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);

    await POST(request({ bookingId, salonId, groupId, language: "en" }));

    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
    expect(mocks.generateReminderToken).not.toHaveBeenCalled();
  });

  it("does not claim a confirmation for a cancelled group member", async () => {
    const harness = makeDb({
      booking: organizerGroupBooking(),
      groupMembers: [
        { ...consentedMember(), status: "cancelled" },
      ],
    });
    mocks.createServiceRoleClient.mockReturnValue(harness.db);

    const response = await POST(
      request({ bookingId, salonId, groupId, language: "en" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.sendClaimed).toHaveBeenCalledTimes(1);
    expect(mocks.generateReminderToken).not.toHaveBeenCalled();
  });
});
