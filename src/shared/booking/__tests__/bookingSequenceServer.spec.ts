import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const serviceRole = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => serviceRole,
}));

import {
  bookingSequenceQuoteMatchesIntent,
  createPublicBookingSequence,
  parseBookingSequenceQuote,
  replayPublicBookingSequence,
} from "@/shared/booking/bookingSequenceServer";

const ids = {
  salon: "11111111-1111-4111-8111-111111111111",
  request: "22222222-2222-4222-8222-222222222222",
  line: "33333333-3333-4333-8333-333333333333",
  service: "44444444-4444-4444-8444-444444444444",
  staff: "55555555-5555-4555-8555-555555555555",
  addon: "66666666-6666-4666-8666-666666666666",
};

function quote() {
  const timing = {
    line_id: ids.line,
    position: 0,
    service_id: ids.service,
    resolved_staff_id: ids.staff,
    resolved_resource_id: null,
    prep_minutes: 10,
    duration_minutes: 30,
    buffer_minutes: 5,
    occupied_start_utc: "2026-08-20T17:50:00.000Z",
    service_start_utc: "2026-08-20T18:00:00.000Z",
    service_end_utc: "2026-08-20T18:30:00.000Z",
    occupied_end_utc: "2026-08-20T18:35:00.000Z",
  };
  return {
    success: true,
    code: "quoted",
    request_id: ids.request,
    pricing_fingerprint: "a".repeat(64),
    contract_version: 1,
    schedule_model: "segments_v1",
    sequence_version: 1,
    salon_id: ids.salon,
    requested_start_time_utc: timing.service_start_utc,
    parent_start_time_utc: timing.service_start_utc,
    parent_end_time_utc: timing.service_end_utc,
    same_staff_for_all: false,
    voucher_id: null,
    currency: "CAD",
    original_price_cents: 5000,
    promo_discount_cents: 500,
    email_discount_cents: 200,
    voucher_discount_cents: 300,
    pre_voucher_subtotal_cents: 5300,
    subtotal_cents: 5000,
    tax_cents: 250,
    tax_amount_cents: 250,
    total_cents: 5250,
    tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: 250 }],
    readiness: {
      contract_version: 1,
      schedule_model: "segments_v1",
      platform_enabled: true,
      salon_enabled: true,
      qa_allowlisted: true,
      catalog_ready: true,
      capacity_contract_ready: true,
      payment_policy_ready: true,
      ready: true,
    },
    timing_segments: [timing],
    segments: [{
      ...timing,
      service_name: "Manicure",
      staff_name: "Mai",
      addon_service_ids: [ids.addon],
      addon_lines: [{
        service_id: ids.addon,
        name: "Art",
        price_cents: 1000,
        duration_minutes: 0,
      }],
      first_addon_id: ids.addon,
      original_service_price_cents: 5000,
      service_pre_voucher_cents: 4500,
      addon_pre_voucher_cents: 1000,
      promo_discount_cents: 500,
      email_discount_cents: 200,
      voucher_discount_cents: 300,
      service_price_cents: 4300,
      addon_price_cents: 700,
      pre_voucher_subtotal_cents: 5300,
      subtotal_cents: 5000,
      tax_cents: 250,
      tax_amount_cents: 250,
      total_cents: 5250,
      tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: 250 }],
    }],
  };
}

function postgresOffset(value: string): string {
  return new Date(Date.parse(value) - 7 * 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "-07:00");
}

describe("parseBookingSequenceQuote", () => {
  it("accepts an exact authoritative sequence receipt", () => {
    expect(parseBookingSequenceQuote(quote())).toMatchObject({
      salonId: ids.salon,
      totalCents: 5250,
      lines: [{ serviceName: "Manicure", staffName: "Mai" }],
    });
  });

  it("accepts real PostgreSQL timestamptz offsets and returns canonical UTC", () => {
    const value = quote();
    for (const key of [
      "requested_start_time_utc",
      "parent_start_time_utc",
      "parent_end_time_utc",
    ] as const) {
      value[key] = postgresOffset(value[key]);
    }
    for (const target of [value.timing_segments[0], value.segments[0]]) {
      for (const key of [
        "occupied_start_utc",
        "service_start_utc",
        "service_end_utc",
        "occupied_end_utc",
      ] as const) {
        target[key] = postgresOffset(target[key]);
      }
    }
    expect(parseBookingSequenceQuote(value)).toMatchObject({
      requestedStartTimeUtc: "2026-08-20T18:00:00.000Z",
      parentStartTimeUtc: "2026-08-20T18:00:00.000Z",
      parentEndTimeUtc: "2026-08-20T18:30:00.000Z",
      lines: [{ occupiedStartUtc: "2026-08-20T17:50:00.000Z" }],
    });
  });

  it("rejects allowlist, timing, add-on, tax, and arithmetic drift", () => {
    const cases = [
      (() => { const value = quote(); value.readiness.qa_allowlisted = false; return value; })(),
      (() => { const value = quote(); value.readiness.payment_policy_ready = false; return value; })(),
      (() => { const value = quote(); value.segments[0].occupied_start_utc = "2026-08-20T17:49:00.000Z"; return value; })(),
      (() => { const value = quote(); value.segments[0].addon_service_ids = []; return value; })(),
      (() => { const value = quote(); value.tax_breakdown[0].name = "PST"; return value; })(),
      (() => { const value = quote(); value.total_cents = 5251; return value; })(),
    ];
    expect(cases.map(parseBookingSequenceQuote)).toEqual(Array(6).fill(null));
  });

  it("binds the quote to exact ordered request material", () => {
    const parsed = parseBookingSequenceQuote(quote())!;
    const intent = {
      salonId: ids.salon,
      requestId: ids.request,
      requestedStartTimeUtc: "2026-08-20T18:00:00.000Z",
      lines: [{
        lineId: ids.line,
        position: 0,
        serviceId: ids.service,
        staffPreference: "any" as const,
        preferredResourceId: null,
        addOnServiceIds: [ids.addon],
      }],
      sameStaffForAll: false,
      voucherCode: null,
      applyEmailDiscount: false,
      customer: { name: "QA", phone: "+16045550199", email: null },
    };
    expect(bookingSequenceQuoteMatchesIntent(parsed, intent)).toBe(true);
    expect(bookingSequenceQuoteMatchesIntent(parsed, {
      ...intent,
      lines: [{ ...intent.lines[0], addOnServiceIds: [] }],
    })).toBe(false);
  });
});

describe("createPublicBookingSequence replay material", () => {
  it("sends the same OTP and health material on first create and committed replay", async () => {
    serviceRole.from.mockImplementation(() => {
      throw new Error("current salon lookup must not run after a persisted result");
    });

    const first: Record<string, unknown> = {
      ...quote(),
      code: "booked",
      booking_id: "77777777-7777-4777-8777-777777777777",
      segment_ids: ["88888888-8888-4888-8888-888888888888"],
      idempotent: false,
      salon_slug: "qa-sequence",
      sms_consent: true,
      notification_language: "en",
    };
    first.pricing_snapshot = {
      ...first,
      segment_ids: first.segment_ids,
    };
    const replay = { ...first, idempotent: true };
    serviceRole.rpc
      .mockResolvedValueOnce({ data: first, error: null })
      .mockResolvedValueOnce({ data: replay, error: null });

    const intent = {
      salonId: ids.salon,
      requestId: ids.request,
      requestedStartTimeUtc: "2026-08-20T18:00:00.000Z",
      lines: [{
        lineId: ids.line,
        position: 0,
        serviceId: ids.service,
        staffPreference: "any" as const,
        preferredResourceId: null,
        addOnServiceIds: [ids.addon],
      }],
      sameStaffForAll: false,
      voucherCode: null,
      applyEmailDiscount: false,
      customer: { name: "QA", phone: "+16045550199", email: null },
    };
    const args = {
      intent,
      expectedPricingFingerprint: "a".repeat(64),
      otpSessionId: "99999999-9999-4999-8999-999999999999",
      healthAcknowledged: true,
      smsConsent: true,
      language: "en" as const,
    };

    await expect(createPublicBookingSequence(args)).resolves.toMatchObject({
      ok: true,
      idempotent: false,
    });
    await expect(createPublicBookingSequence(args)).resolves.toMatchObject({
      ok: true,
      idempotent: true,
    });

    expect(serviceRole.rpc).toHaveBeenCalledTimes(2);
    expect(serviceRole.from).not.toHaveBeenCalled();
    const firstRequest = serviceRole.rpc.mock.calls[0]?.[1];
    const replayRequest = serviceRole.rpc.mock.calls[1]?.[1];
    expect(replayRequest).toEqual(firstRequest);
    expect(firstRequest).toMatchObject({
      p_request: {
        otp_session_id: args.otpSessionId,
        health_acknowledged: true,
        sms_consent: true,
        notification_language: "en",
      },
    });
  });

  it("uses the read-only replay RPC with the exact same canonical material", async () => {
    serviceRole.rpc.mockResolvedValueOnce({
      data: { success: false, code: "replay_not_found" },
      error: null,
    });
    const result = await replayPublicBookingSequence({
      intent: {
        salonId: ids.salon,
        requestId: ids.request,
        requestedStartTimeUtc: "2026-08-20T18:00:00.000Z",
        lines: [{
          lineId: ids.line,
          position: 0,
          serviceId: ids.service,
          staffPreference: "any",
          preferredResourceId: null,
          addOnServiceIds: [ids.addon],
        }],
        sameStaffForAll: false,
        voucherCode: null,
        applyEmailDiscount: false,
        customer: { name: "QA", phone: "+16045550199", email: null },
      },
      expectedPricingFingerprint: "a".repeat(64),
      otpSessionId: "99999999-9999-4999-8999-999999999999",
      healthAcknowledged: true,
      smsConsent: false,
      language: "vi",
    });
    expect(result).toEqual({ ok: false, code: "replay_not_found" });
    expect(serviceRole.rpc).toHaveBeenCalledWith(
      "replay_public_booking_sequence",
      expect.objectContaining({
        p_request: expect.objectContaining({
          sms_consent: false,
          notification_language: "vi",
        }),
      }),
    );
  });
});
