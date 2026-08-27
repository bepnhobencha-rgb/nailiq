import { beforeEach, describe, expect, it, vi } from "vitest";

const { createServiceRoleClientMock } = vi.hoisted(() => ({
  createServiceRoleClientMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: createServiceRoleClientMock,
}));
import {
  groupBookingPricingIntentKey,
  groupBookingQuoteMatchesRequest,
  parseGroupBookingPricingQuote,
  serializeGroupBookingPricingQuote,
  type GroupBookingPricingRequest,
} from "@/shared/booking/groupBookingPricing";
import {
  createGroupBookingsAuthoritative,
  resolveGroupBookingQuote,
} from "@/shared/booking/groupBookingPricingServer";

const addon = (serviceId: string, priceCents: number) => ({
  service_id: serviceId,
  name: serviceId,
  price_cents: priceCents,
  duration_minutes: 10,
  buffer_minutes: 0,
  addon_timing: "sequential",
});

const member0 = {
  member_index: 0,
  service_id: "service-a",
  staff_id: "staff-a",
  start_time_utc: "2026-08-21T17:00:00.000Z",
  end_time_utc: "2026-08-21T18:00:00.000Z",
  addon_service_ids: ["addon-a", "addon-b"],
  addon_lines: [addon("addon-a", 1_000), addon("addon-b", 700)],
  first_addon_id: "addon-a",
  trailing_buffer_minutes: 10,
  promo_id: "promo-a",
  promo_name: "Summer",
  original_price_cents: 5_000,
  promo_discount_cents: 500,
  email_discount_cents: 200,
  service_pre_voucher_cents: 4_300,
  addon_pre_voucher_cents: 1_700,
  pre_voucher_subtotal_cents: 6_000,
  voucher_discount_cents: 300,
  price_cents: 4_000,
  addon_price_cents: 1_700,
  subtotal_cents: 5_700,
  tax_cents: 285,
  total_cents: 5_985,
  tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: 285 }],
};

const member1 = {
  member_index: 1,
  service_id: "service-b",
  staff_id: "staff-b",
  start_time_utc: "2026-08-21T17:00:00.000Z",
  end_time_utc: "2026-08-21T18:00:00.000Z",
  addon_service_ids: ["addon-c"],
  addon_lines: [addon("addon-c", 900)],
  first_addon_id: "addon-c",
  trailing_buffer_minutes: 0,
  promo_id: "promo-b",
  promo_name: "Summer",
  original_price_cents: 4_000,
  promo_discount_cents: 400,
  email_discount_cents: 0,
  service_pre_voucher_cents: 3_600,
  addon_pre_voucher_cents: 900,
  pre_voucher_subtotal_cents: 4_500,
  voucher_discount_cents: 225,
  price_cents: 3_375,
  addon_price_cents: 900,
  subtotal_cents: 4_275,
  tax_cents: 214,
  total_cents: 4_489,
  tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: 214 }],
};

const member2 = {
  member_index: 2,
  service_id: "service-c",
  staff_id: "staff-c",
  start_time_utc: "2026-08-21T18:00:00.000Z",
  end_time_utc: "2026-08-21T18:45:00.000Z",
  addon_service_ids: [],
  addon_lines: [],
  first_addon_id: null,
  trailing_buffer_minutes: 5,
  promo_id: "promo-c",
  promo_name: "Summer",
  original_price_cents: 3_000,
  promo_discount_cents: 300,
  email_discount_cents: 0,
  service_pre_voucher_cents: 2_700,
  addon_pre_voucher_cents: 0,
  pre_voucher_subtotal_cents: 2_700,
  voucher_discount_cents: 135,
  price_cents: 2_565,
  addon_price_cents: 0,
  subtotal_cents: 2_565,
  tax_cents: 128,
  total_cents: 2_693,
  tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: 128 }],
};

function rawQuote(
  members: Array<Record<string, unknown>> = [member0, member1],
) {
  const sum = (field: string) =>
    members.reduce(
      (total, member) =>
        total + Number(member[field]),
      0,
    );
  return {
    success: true,
    code: "quoted",
    pricing_fingerprint: "a".repeat(64),
    salon_id: "11111111-1111-4111-8111-111111111111",
    group_size: members.length,
    currency: "CAD",
    voucher_id: "22222222-2222-4222-8222-222222222222",
    original_price_cents: sum("original_price_cents"),
    promo_discount_cents: sum("promo_discount_cents"),
    email_discount_cents: sum("email_discount_cents"),
    voucher_discount_cents: sum("voucher_discount_cents"),
    pre_voucher_subtotal_cents: sum("pre_voucher_subtotal_cents"),
    subtotal_cents: sum("subtotal_cents"),
    tax_cents: sum("tax_cents"),
    total_cents: sum("total_cents"),
    tax_breakdown: [
      { name: "GST", rate: 0.05, amount_cents: sum("tax_cents") },
    ],
    member_quotes: members,
  };
}

describe("public group booking authoritative pricing receipt", () => {
  it("accepts reconciled two- and three-member receipts with multiple add-ons", () => {
    const two = parseGroupBookingPricingQuote(rawQuote(), {
      voucherCode: "PARTY",
    });
    expect(two).not.toBeNull();
    expect(two?.memberQuotes[0].addonLines).toHaveLength(2);
    expect(two?.totalCents).toBe(10_474);

    const three = parseGroupBookingPricingQuote(
      rawQuote([member0, member1, member2]),
      { voucherCode: "PARTY" },
    );
    expect(three).not.toBeNull();
    expect(three?.groupSize).toBe(3);
    expect(three?.subtotalCents).toBe(12_540);
    expect(three?.taxCents).toBe(627);
    expect(three?.totalCents).toBe(13_167);
  });

  it("fails closed on member-count, ordering, and arithmetic drift", () => {
    expect(
      parseGroupBookingPricingQuote({ ...rawQuote(), group_size: 3 }),
    ).toBeNull();
    expect(
      parseGroupBookingPricingQuote({
        ...rawQuote(),
        member_quotes: [{ ...member0, member_index: 1 }, member1],
      }),
    ).toBeNull();
    expect(
      parseGroupBookingPricingQuote({ ...rawQuote(), total_cents: 10_475 }),
    ).toBeNull();
  });

  it("round-trips the same strict receipt through the public JSON serializer", () => {
    const parsed = parseGroupBookingPricingQuote(rawQuote(), {
      voucherCode: "PARTY",
    });
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("fixture rejected");
    expect(
      parseGroupBookingPricingQuote(serializeGroupBookingPricingQuote(parsed), {
        voucherCode: "PARTY",
      }),
    ).toEqual(parsed);
  });

  it("requires the organizer to be the only email-incentive recipient", () => {
    const nonOrganizerIncentive = {
      ...member1,
      promo_discount_cents: 300,
      email_discount_cents: 100,
    };
    expect(
      parseGroupBookingPricingQuote(rawQuote([member0, nonOrganizerIncentive])),
    ).toBeNull();
  });

  it("binds exact add-on IDs and tax lines to the reconciled receipt", () => {
    expect(
      parseGroupBookingPricingQuote(
        rawQuote([
          { ...member0, addon_service_ids: ["addon-a", "tampered-addon"] },
          member1,
        ]),
      ),
    ).toBeNull();
    expect(
      parseGroupBookingPricingQuote(
        rawQuote([{ ...member0, first_addon_id: "addon-b" }, member1]),
      ),
    ).toBeNull();
    expect(
      parseGroupBookingPricingQuote(
        rawQuote([
          member0,
          {
            ...member1,
            tax_breakdown: [
              { name: "PST", rate: 0.07, amount_cents: 214 },
            ],
          },
        ]),
      ),
    ).toBeNull();
  });

  it("invalidates a quote for every material group intent mutation", () => {
    const base: GroupBookingPricingRequest = {
      salonId: "11111111-1111-4111-8111-111111111111",
      bookings: [
        {
          serviceId: "service-a",
          staffId: "staff-a",
          startTimeUtc: "2026-08-21T17:00:00.000Z",
          endTimeUtc: "2026-08-21T18:00:00.000Z",
          addonServiceIds: ["addon-a"],
          clientName: "Mai",
          clientPhone: "16045550100",
          clientEmail: "mai@example.test",
          clientNotes: "window",
          staffRequestedByClient: true,
          waveNumber: 1,
          seatTogether: true,
          clientLocale: "en",
          resourceId: null,
        },
        {
          serviceId: "service-b",
          staffId: "staff-b",
          startTimeUtc: "2026-08-21T17:00:00.000Z",
          endTimeUtc: "2026-08-21T18:00:00.000Z",
          addonServiceIds: [],
          clientName: "Guest",
        },
      ],
      voucherCode: "PARTY",
      clientPhone: "16045550100",
      clientEmail: "mai@example.test",
      applyEmailDiscount: true,
    };
    const original = groupBookingPricingIntentKey(base);
    const mutateFirst = (
      mutation: Partial<GroupBookingPricingRequest["bookings"][number]>,
    ): GroupBookingPricingRequest => ({
      ...base,
      bookings: [{ ...base.bookings[0], ...mutation }, base.bookings[1]],
    });
    const mutations: GroupBookingPricingRequest[] = [
      { ...base, salonId: "other-salon" },
      mutateFirst({ serviceId: "service-x" }),
      mutateFirst({ staffId: "staff-x" }),
      mutateFirst({ startTimeUtc: "2026-08-21T17:15:00.000Z" }),
      mutateFirst({ endTimeUtc: "2026-08-21T18:15:00.000Z" }),
      mutateFirst({ addonServiceIds: ["addon-b"] }),
      mutateFirst({ clientName: "Lan" }),
      mutateFirst({ clientPhone: "16045550199" }),
      mutateFirst({ clientEmail: "lan@example.test" }),
      mutateFirst({ clientNotes: "quiet" }),
      mutateFirst({ staffRequestedByClient: false }),
      mutateFirst({ waveNumber: 2 }),
      mutateFirst({ seatTogether: false }),
      mutateFirst({ clientLocale: "vi" }),
      mutateFirst({ resourceId: "resource-a" }),
      { ...base, bookings: [...base.bookings, { ...base.bookings[1] }] },
      { ...base, voucherCode: null },
      { ...base, applyEmailDiscount: false },
    ];
    for (const mutation of mutations) {
      expect(groupBookingPricingIntentKey(mutation)).not.toBe(original);
    }
    // Legacy top-level identity mirrors are deliberately ignored. Only the
    // organizer row is authoritative, so spoofing these cannot change intent.
    expect(
      groupBookingPricingIntentKey({
        ...base,
        clientPhone: "16045550199",
        clientEmail: "spoofed@example.test",
      }),
    ).toBe(original);
  });

  it("rejects every member scheduling-material drift against a quote", () => {
    const quote = parseGroupBookingPricingQuote(rawQuote(), {
      voucherCode: "PARTY",
    });
    expect(quote).not.toBeNull();
    if (!quote) throw new Error("fixture rejected");
    const request: GroupBookingPricingRequest = {
      salonId: quote.salonId,
      bookings: [member0, member1].map((member) => ({
        serviceId: member.service_id,
        staffId: member.staff_id,
        startTimeUtc: member.start_time_utc,
        endTimeUtc: member.end_time_utc,
        addonServiceIds: member.addon_service_ids,
      })),
      voucherCode: "PARTY",
      applyEmailDiscount: true,
    };
    expect(groupBookingQuoteMatchesRequest(quote, request)).toBe(true);
    expect(
      groupBookingQuoteMatchesRequest(quote, {
        ...request,
        bookings: request.bookings.map((booking) => ({
          ...booking,
          startTimeUtc: booking.startTimeUtc.replace(".000Z", "+00:00"),
          endTimeUtc: booking.endTimeUtc.replace(".000Z", "+00:00"),
        })),
      }),
    ).toBe(true);
    const mutateFirst = (
      mutation: Partial<GroupBookingPricingRequest["bookings"][number]>,
    ): GroupBookingPricingRequest => ({
      ...request,
      bookings: [{ ...request.bookings[0], ...mutation }, request.bookings[1]],
    });
    for (const changed of [
      { ...request, salonId: "other-salon" },
      { ...request, bookings: [request.bookings[0]] },
      mutateFirst({ serviceId: "service-x" }),
      mutateFirst({ staffId: "staff-x" }),
      mutateFirst({ startTimeUtc: "2026-08-21T17:15:00.000Z" }),
      mutateFirst({ endTimeUtc: "2026-08-21T18:15:00.000Z" }),
      mutateFirst({ addonServiceIds: ["addon-a"] }),
    ]) {
      expect(groupBookingQuoteMatchesRequest(quote, changed)).toBe(false);
    }
  });
});

const serverRequest = {
  salonId: "11111111-1111-4111-8111-111111111111",
  bookings: [
    {
      serviceId: "21111111-1111-4111-8111-111111111111",
      staffId: "31111111-1111-4111-8111-111111111111",
      startTimeUtc: "2026-08-21T17:00:00.000Z",
      endTimeUtc: "2026-08-21T18:00:00.000Z",
      addonServiceIds: ["41111111-1111-4111-8111-111111111111"],
      clientName: "Mai",
      clientPhone: "16045550100",
      clientEmail: "mai@example.test",
    },
    {
      serviceId: "51111111-1111-4111-8111-111111111111",
      staffId: "61111111-1111-4111-8111-111111111111",
      startTimeUtc: "2026-08-21T17:00:00.000Z",
      endTimeUtc: "2026-08-21T18:00:00.000Z",
      addonServiceIds: [],
      clientName: "Lan",
    },
  ],
  voucherCode: null,
  applyEmailDiscount: true,
};

describe("public group booking authoritative server receipt", () => {
  beforeEach(() => {
    createServiceRoleClientMock.mockReset();
  });

  it("parses quote and create through one receipt with exact member IDs", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: rawQuote(), error: null })
      .mockResolvedValueOnce({
        data: {
          ...rawQuote(),
          code: "booked",
          group_id: "71111111-1111-4111-8111-111111111111",
          booking_ids: [
            "81111111-1111-4111-8111-111111111111",
            "91111111-1111-4111-8111-111111111111",
          ],
          idempotent: false,
        },
        error: null,
      });
    createServiceRoleClientMock.mockReturnValue({ rpc });

    const quote = await resolveGroupBookingQuote(serverRequest);
    expect(quote).toMatchObject({ ok: true, quote: { totalCents: 10_474 } });
    if (!quote.ok) throw new Error("quote fixture rejected");

    const created = await createGroupBookingsAuthoritative({
      ...serverRequest,
      idempotencyKey: "a1111111-1111-4111-8111-111111111111",
      expectedPricingFingerprint: quote.quote.pricingFingerprint,
    });
    expect(created).toMatchObject({
      ok: true,
      idempotent: false,
      bookingIds: [
        "81111111-1111-4111-8111-111111111111",
        "91111111-1111-4111-8111-111111111111",
      ],
      pricing: { totalCents: quote.quote.totalCents },
    });
    if (!created.ok) throw new Error("create fixture rejected");
    expect(created.pricing).toEqual(quote.quote);
    expect(rpc.mock.calls[1][0]).toBe("create_group_bookings");
    expect(rpc.mock.calls[1][1]).toMatchObject({
      p_group_idempotency_key: "a1111111-1111-4111-8111-111111111111",
      p_expected_pricing_fingerprint: "a".repeat(64),
    });
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_price_cents");
    expect(rpc.mock.calls[1][1]).not.toHaveProperty("p_discount_cents");
  });

  it("fails closed on a partial result and never filters it into success", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        ...rawQuote(),
        code: "booked",
        group_id: "71111111-1111-4111-8111-111111111111",
        booking_ids: ["81111111-1111-4111-8111-111111111111"],
        idempotent: false,
      },
      error: null,
    });
    createServiceRoleClientMock.mockReturnValue({ rpc });
    await expect(
      createGroupBookingsAuthoritative({
        ...serverRequest,
        idempotencyKey: "a1111111-1111-4111-8111-111111111111",
        expectedPricingFingerprint: "a".repeat(64),
      }),
    ).resolves.toEqual({ ok: false, code: "pricing_invalid" });
  });

  it("preserves a quote-time slot conflict for receptionist recovery", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { success: false, code: "slot_conflict" },
      error: null,
    });
    createServiceRoleClientMock.mockReturnValue({ rpc });

    await expect(resolveGroupBookingQuote(serverRequest)).resolves.toEqual({
      ok: false,
      code: "slot_conflict",
    });
  });

  it("preserves exact replay and changed-payload conflict outcomes", async () => {
    const replayRpc = vi.fn().mockResolvedValue({
      data: {
        ...rawQuote(),
        code: "booked",
        group_id: "71111111-1111-4111-8111-111111111111",
        booking_ids: [
          "81111111-1111-4111-8111-111111111111",
          "91111111-1111-4111-8111-111111111111",
        ],
        idempotent: true,
      },
      error: null,
    });
    createServiceRoleClientMock.mockReturnValueOnce({ rpc: replayRpc });
    const replay = await createGroupBookingsAuthoritative({
      ...serverRequest,
      idempotencyKey: "a1111111-1111-4111-8111-111111111111",
      expectedPricingFingerprint: "a".repeat(64),
    });
    expect(replay).toMatchObject({ ok: true, idempotent: true });

    const conflictRpc = vi.fn().mockResolvedValue({
      data: { success: false, code: "idempotency_conflict" },
      error: null,
    });
    createServiceRoleClientMock.mockReturnValueOnce({ rpc: conflictRpc });
    await expect(
      createGroupBookingsAuthoritative({
        ...serverRequest,
        bookings: [
          { ...serverRequest.bookings[0], clientNotes: "changed" },
          serverRequest.bookings[1],
        ],
        idempotencyKey: "a1111111-1111-4111-8111-111111111111",
        expectedPricingFingerprint: "a".repeat(64),
      }),
    ).resolves.toEqual({ ok: false, code: "idempotency_conflict" });
  });

  it("rejects a malformed fingerprint before constructing a provider client", async () => {
    await expect(
      createGroupBookingsAuthoritative({
        ...serverRequest,
        idempotencyKey: "a1111111-1111-4111-8111-111111111111",
        expectedPricingFingerprint: "tampered",
      }),
    ).resolves.toEqual({ ok: false, code: "invalid_request" });
    expect(createServiceRoleClientMock).not.toHaveBeenCalled();
  });
});
