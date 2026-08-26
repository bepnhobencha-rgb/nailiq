import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildGroupBookingConfirmationHtml,
  groupConfirmationFingerprintsMatch,
  sendGroupBookingConfirmationEmail,
  type AuthoritativeGroupConfirmationReceipt,
  type GroupConfirmationEmailDeps,
} from "@/shared/booking/sendGroupBookingConfirmationEmail";
import { parseGroupBookingPricingQuote } from "@/shared/booking/groupBookingPricing";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_1 = "22222222-2222-4222-8222-222222222221";
const BOOKING_2 = "22222222-2222-4222-8222-222222222222";

function member(index: number, values: {
  serviceId: string;
  staffId: string;
  original: number;
  promo: number;
  email?: number;
  addon?: number;
  tax: number;
}) {
  const email = values.email ?? 0;
  const addon = values.addon ?? 0;
  const serviceNet = values.original - values.promo - email;
  const preVoucher = serviceNet + addon;
  return {
    member_index: index,
    service_id: values.serviceId,
    staff_id: values.staffId,
    start_time_utc: `2026-08-2${index + 1}T17:00:00.000Z`,
    end_time_utc: `2026-08-2${index + 1}T18:00:00.000Z`,
    addon_service_ids: addon ? [`addon-${index}`] : [],
    addon_lines: addon ? [{
      service_id: `addon-${index}`,
      name: `Art ${index + 1}`,
      price_cents: addon,
      duration_minutes: 10,
      buffer_minutes: 0,
      addon_timing: "sequential",
    }] : [],
    first_addon_id: addon ? `addon-${index}` : null,
    trailing_buffer_minutes: 0,
    promo_id: values.promo ? "promo-id" : null,
    promo_name: values.promo ? "Party promo" : null,
    original_price_cents: values.original,
    promo_discount_cents: values.promo,
    email_discount_cents: email,
    service_pre_voucher_cents: serviceNet,
    addon_pre_voucher_cents: addon,
    pre_voucher_subtotal_cents: preVoucher,
    voucher_discount_cents: 0,
    price_cents: serviceNet,
    addon_price_cents: addon,
    subtotal_cents: preVoucher,
    tax_cents: values.tax,
    tax_amount_cents: values.tax,
    total_cents: preVoucher + values.tax,
    tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: values.tax }],
  };
}

function receipt(options: { free?: boolean } = {}): AuthoritativeGroupConfirmationReceipt {
  const members = options.free
    ? [
        member(0, { serviceId: "service-a", staffId: "staff-a", original: 1_000, promo: 1_000, tax: 0 }),
        member(1, { serviceId: "service-b", staffId: "staff-b", original: 2_000, promo: 2_000, tax: 0 }),
      ]
    : [
        member(0, { serviceId: "service-a", staffId: "staff-a", original: 5_000, promo: 500, email: 200, addon: 1_000, tax: 265 }),
        member(1, { serviceId: "service-b", staffId: "staff-b", original: 4_000, promo: 400, tax: 180 }),
      ];
  const sum = (field: string) => members.reduce((total, row) => total + Number(row[field as keyof typeof row]), 0);
  const raw = {
    success: true,
    code: "booked",
    pricing_fingerprint: "a".repeat(64),
    salon_id: SALON_ID,
    group_size: 2,
    currency: "CAD",
    voucher_id: null,
    original_price_cents: sum("original_price_cents"),
    promo_discount_cents: sum("promo_discount_cents"),
    email_discount_cents: sum("email_discount_cents"),
    voucher_discount_cents: 0,
    pre_voucher_subtotal_cents: sum("pre_voucher_subtotal_cents"),
    subtotal_cents: sum("subtotal_cents"),
    tax_cents: sum("tax_cents"),
    tax_amount_cents: sum("tax_cents"),
    total_cents: sum("total_cents"),
    tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: sum("tax_cents") }],
    member_quotes: members,
  };
  const pricing = parseGroupBookingPricingQuote(raw);
  if (!pricing) throw new Error("invalid group pricing fixture");
  return {
    organizerBookingId: BOOKING_1,
    organizerName: "Mai Nguyen",
    organizerEmail: "mai@example.test",
    groupId: "33333333-3333-4333-8333-333333333333",
    shopSlug: "qa-salon",
    salonId: SALON_ID,
    salonName: "QA Salon",
    salonTimezone: "America/Vancouver",
    salonAddress: "123 Test Street",
    salonReplyEmail: "owner@example.test",
    pricing,
    members: [
      { bookingId: BOOKING_1, clientName: "Mai", serviceName: "Gel Manicure", staffName: "Ana", pricing: pricing.memberQuotes[0] },
      { bookingId: BOOKING_2, clientName: "Linh", serviceName: "Pedicure", staffName: "Bao", pricing: pricing.memberQuotes[1] },
    ],
  };
}

function deps(overrides: Partial<GroupConfirmationEmailDeps> = {}) {
  const send = vi.fn(async (): Promise<{
    data: { id?: string | null } | null;
    error: { message?: unknown } | null;
  }> => ({ data: { id: "resend-group-1" }, error: null }));
  const finalize = vi.fn(async () => true);
  const base: GroupConfirmationEmailDeps = {
    loadReceipt: vi.fn(async () => receipt()),
    claim: vi.fn(async () => "claim-1"),
    provider: () => ({ send }),
    finalize,
    from: () => "NailIQ <test@example.test>",
    ...overrides,
  };
  return { base, send, finalize };
}

const input = {
  organizerBookingId: BOOKING_1,
  salonId: SALON_ID,
  shopSlug: "qa-salon",
};

describe("authoritative immediate group confirmation email", () => {
  it("lets exactly one concurrent durable claimant cross the provider boundary", async () => {
    let claimed = false;
    const claim = vi.fn(async () => {
      if (claimed) return "skip" as const;
      claimed = true;
      return "claim-1";
    });
    const fixture = deps({ claim });
    const results = await Promise.all([
      sendGroupBookingConfirmationEmail(input, fixture.base),
      sendGroupBookingConfirmationEmail(input, fixture.base),
    ]);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.outcome).sort()).toEqual(["sent", "suppressed"]);
    expect(results.find((result) => result.outcome === "suppressed")).toMatchObject({
      reason: "duplicate_or_in_progress",
      claimFinalized: false,
    });
  });

  it("sends nothing when the persisted snapshot is missing or invalid", async () => {
    const fixture = deps({ loadReceipt: vi.fn(async () => null) });
    const result = await sendGroupBookingConfirmationEmail(input, fixture.base);
    expect(result).toMatchObject({ outcome: "suppressed", reason: "authoritative_receipt_unavailable" });
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.base.claim).not.toHaveBeenCalled();
  });

  it("sends nothing when any persisted member fingerprint differs from the organizer snapshot", async () => {
    const expected = "a".repeat(64);
    const loadReceipt = vi.fn(async () =>
      groupConfirmationFingerprintsMatch(expected, [expected, "b".repeat(64)])
        ? receipt()
        : null,
    );
    const fixture = deps({ loadReceipt });
    const result = await sendGroupBookingConfirmationEmail(input, fixture.base);
    expect(result).toMatchObject({ outcome: "suppressed", reason: "authoritative_receipt_unavailable" });
    expect(fixture.send).not.toHaveBeenCalled();
    expect(fixture.base.claim).not.toHaveBeenCalled();
  });

  it("renders free receipts and authoritative member, add-on, discount, tax and aggregate values", () => {
    const paidReceipt = receipt();
    const paidHtml = buildGroupBookingConfirmationHtml(paidReceipt);
    expect(paidHtml).toContain("Gel Manicure");
    expect(paidHtml).toContain("Art 1");
    expect(paidHtml).toContain("Party promo");
    expect(paidHtml).toContain("Email incentive");
    expect(paidHtml).toContain("GST (5%)");
    expect(paidHtml).toContain("$55.65");
    expect(paidHtml).toContain("$37.80");
    expect(paidHtml).toContain("$93.45");
    expect(paidHtml).toContain("$4.45");
    expect(paidHtml).toMatch(/Service<\/td><td[^>]*>\$50\.00<\/td>/);
    expect(paidHtml).toMatch(/Add-ons<\/td><td[^>]*>\$10\.00<\/td>/);
    for (const memberReceipt of paidReceipt.pricing.memberQuotes) {
      const displayedTotal =
        memberReceipt.serviceOriginalCents +
        memberReceipt.addonPreVoucherCents -
        memberReceipt.discountLines.reduce((sum, line) => sum + line.amountCents, 0) +
        memberReceipt.taxCents;
      expect(displayedTotal).toBe(memberReceipt.totalCents);
    }
    const aggregateDisplayedTotal =
      paidReceipt.pricing.serviceOriginalCents +
      paidReceipt.pricing.memberQuotes.reduce(
        (sum, memberReceipt) => sum + memberReceipt.addonPreVoucherCents,
        0,
      ) -
      paidReceipt.pricing.discountLines.reduce((sum, line) => sum + line.amountCents, 0) +
      paidReceipt.pricing.taxCents;
    expect(aggregateDisplayedTotal).toBe(paidReceipt.pricing.totalCents);

    const freeHtml = buildGroupBookingConfirmationHtml(receipt({ free: true }));
    expect(freeHtml).toContain("$0.00");
    expect(freeHtml).toContain("$30.00");
    expect(freeHtml).toContain("Party promo");
  });

  it("marks explicit provider errors failed and never invents a receipt", async () => {
    const fixture = deps();
    fixture.send.mockResolvedValueOnce({ data: null, error: { message: "rejected" } });
    const result = await sendGroupBookingConfirmationEmail(input, fixture.base);
    expect(result).toMatchObject({ outcome: "failed", providerId: null, claimFinalized: true });
    expect(fixture.finalize).toHaveBeenCalledWith("claim-1", expect.objectContaining({ status: "failed", messageSid: null }));
  });

  it.each([
    ["missing receipt", async () => ({ data: {}, error: null }), "provider_missing_receipt"],
    ["provider throw", async () => { throw new Error("transport lost"); }, "provider_exception"],
  ])("keeps %s outcomes unknown", async (_label, providerSend, reason) => {
    const fixture = deps();
    fixture.base.provider = () => ({ send: providerSend });
    const result = await sendGroupBookingConfirmationEmail(input, fixture.base);
    expect(result).toMatchObject({ outcome: "unknown", reason, providerId: null, claimFinalized: true });
    expect(fixture.finalize).toHaveBeenCalledWith("claim-1", expect.objectContaining({ status: "unknown", messageSid: null }));
  });

  it("reports durable completion loss without retrying the provider", async () => {
    const fixture = deps({ finalize: vi.fn(async () => false) });
    const result = await sendGroupBookingConfirmationEmail(input, fixture.base);
    expect(result).toMatchObject({ outcome: "sent", providerId: "resend-group-1", claimFinalized: false });
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.base.finalize).toHaveBeenCalledTimes(2);
  });
});
