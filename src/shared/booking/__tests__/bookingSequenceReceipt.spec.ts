import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseBookingSequenceReceipt } from "../bookingSequenceReceipt";
import { parseBookingManagementInspection } from "../bookingManagementCapabilities";
import { buildHtml } from "../sendBookingConfirmationEmail";

const bookingId = "11111111-1111-4111-8111-111111111111";
const salonId = "22222222-2222-4222-8222-222222222222";
const segmentIds = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const lineIds = [
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
];
const serviceIds = [
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
];
const staffIds = [
  "99999999-9999-4999-8999-999999999999",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
];
const addonId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function segment(position: number) {
  const first = position === 0;
  return {
    line_id: lineIds[position],
    position,
    service_id: serviceIds[position],
    service_name: first ? "Structured Gel" : "Nail Art",
    staff_name: first ? "Mai" : "Linh",
    staff_id: staffIds[position],
    resolved_staff_id: staffIds[position],
    resource_id: null,
    resolved_resource_id: null,
    prep_minutes: first ? 10 : 5,
    duration_minutes: first ? 30 : 40,
    buffer_minutes: first ? 5 : 0,
    occupied_start_utc: first
      ? "2026-08-28T17:50:00.000Z"
      : "2026-08-28T18:25:00.000Z",
    service_start_utc: first
      ? "2026-08-28T18:00:00.000Z"
      : "2026-08-28T18:30:00.000Z",
    service_end_utc: first
      ? "2026-08-28T18:30:00.000Z"
      : "2026-08-28T19:10:00.000Z",
    occupied_end_utc: first
      ? "2026-08-28T18:35:00.000Z"
      : "2026-08-28T19:10:00.000Z",
    original_service_price_cents: first ? 5_000 : 4_000,
    service_pre_voucher_cents: first ? 4_500 : 4_000,
    addon_pre_voucher_cents: first ? 1_000 : 0,
    promo_discount_cents: first ? 500 : 0,
    email_discount_cents: first ? 200 : 0,
    voucher_discount_cents: first ? 300 : 0,
    service_price_cents: 4_000,
    addon_price_cents: first ? 1_000 : 0,
    pre_voucher_subtotal_cents: first ? 5_300 : 4_000,
    subtotal_cents: first ? 5_000 : 4_000,
    tax_cents: first ? 250 : 200,
    total_cents: first ? 5_250 : 4_200,
    promo_id: first ? "cccccccc-cccc-4ccc-8ccc-cccccccccccc" : null,
    promo_name: first ? "QA promo" : null,
    addon_lines: first ? [{
      service_id: addonId,
      name: "Chrome",
      price_cents: 1_000,
      duration_minutes: 0,
      buffer_minutes: 0,
      addon_timing: "concurrent",
    }] : [],
    tax_breakdown: [{
      name: "GST",
      rate: 0.05,
      amount_cents: first ? 250 : 200,
    }],
  };
}

function receipt() {
  const snapshotSegments = [segment(0), segment(1)];
  return {
    success: true,
    code: "loaded",
    booking_id: bookingId,
    salon_id: salonId,
    status: "confirmed",
    schedule_model: "segments_v1",
    sequence_version: 1,
    pricing_fingerprint: "d".repeat(64),
    pricing_snapshot: {
      success: true,
      code: "quoted",
      contract_version: 1,
      schedule_model: "segments_v1",
      sequence_version: 1,
      booking_id: bookingId,
      salon_id: salonId,
      pricing_fingerprint: "d".repeat(64),
      currency: "CAD",
      parent_start_time_utc: "2026-08-28T18:00:00.000Z",
      parent_end_time_utc: "2026-08-28T19:10:00.000Z",
      original_price_cents: 9_000,
      promo_discount_cents: 500,
      email_discount_cents: 200,
      voucher_discount_cents: 300,
      pre_voucher_subtotal_cents: 9_300,
      subtotal_cents: 9_000,
      tax_cents: 450,
      total_cents: 9_450,
      tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: 450 }],
      segment_ids: segmentIds,
      segments: snapshotSegments,
    },
    segments: snapshotSegments.map((row, position) => {
      const persisted: Partial<typeof row> = { ...row };
      delete persisted.pre_voucher_subtotal_cents;
      delete persisted.promo_name;
      return {
        ...persisted,
        segment_id: segmentIds[position],
        reservation_status: "confirmed",
      };
    }),
  };
}

function postgresOffset(value: string): string {
  return new Date(Date.parse(value) - 7 * 60 * 60 * 1000)
    .toISOString()
    .replace("Z", "-07:00");
}

function offsetReceipt() {
  const value = receipt();
  value.pricing_snapshot.parent_start_time_utc = postgresOffset(
    value.pricing_snapshot.parent_start_time_utc,
  );
  value.pricing_snapshot.parent_end_time_utc = postgresOffset(
    value.pricing_snapshot.parent_end_time_utc,
  );
  for (const collection of [value.pricing_snapshot.segments, value.segments]) {
    for (const row of collection) {
      for (const key of [
        "occupied_start_utc",
        "service_start_utc",
        "service_end_utc",
        "occupied_end_utc",
      ] as const) {
        row[key] = postgresOffset(row[key]!);
      }
    }
  }
  return value;
}

describe("parseBookingSequenceReceipt", () => {
  it("reconciles ordered persisted segments with the parent receipt", () => {
    const parsed = parseBookingSequenceReceipt(receipt());
    expect(parsed).not.toBeNull();
    expect(parsed?.segments.map((line) => ({
      lineId: line.lineId,
      service: line.serviceName,
      staff: line.staffName,
      prep: line.prepMinutes,
      subtotal: line.subtotalCents,
      total: line.totalCents,
    }))).toEqual([
      {
        lineId: lineIds[0], service: "Structured Gel", staff: "Mai",
        prep: 10, subtotal: 5_000, total: 5_250,
      },
      {
        lineId: lineIds[1], service: "Nail Art", staff: "Linh",
        prep: 5, subtotal: 4_000, total: 4_200,
      },
    ]);
    expect(parsed?.totalCents).toBe(9_450);
  });

  it("reconciles the offset timestamptz representation returned by PostgreSQL", () => {
    expect(parseBookingSequenceReceipt(offsetReceipt())).toMatchObject({
      parentStartTimeUtc: "2026-08-28T18:00:00.000Z",
      parentEndTimeUtc: "2026-08-28T19:10:00.000Z",
      segments: [
        { occupiedStartUtc: "2026-08-28T17:50:00.000Z" },
        { serviceEndUtc: "2026-08-28T19:10:00.000Z" },
      ],
    });
  });

  it("rejects a parent fingerprint, identity, or segment-id mismatch", () => {
    const fingerprint = receipt();
    fingerprint.pricing_snapshot.pricing_fingerprint = "e".repeat(64);
    expect(parseBookingSequenceReceipt(fingerprint)).toBeNull();

    const identity = receipt();
    identity.pricing_snapshot.booking_id = salonId;
    expect(parseBookingSequenceReceipt(identity)).toBeNull();

    const ids = receipt();
    ids.segments[0].segment_id = segmentIds[1];
    expect(parseBookingSequenceReceipt(ids)).toBeNull();
  });

  it("rejects catalog-name or monetary drift between snapshot and rows", () => {
    const name = receipt();
    name.segments[0].service_name = "Mutable catalog name";
    expect(parseBookingSequenceReceipt(name)).toBeNull();

    const money = receipt();
    money.segments[0]!.total_cents = (money.segments[0]!.total_cents ?? 0) + 1;
    expect(parseBookingSequenceReceipt(money)).toBeNull();

    const aggregate = receipt();
    aggregate.pricing_snapshot.total_cents += 1;
    expect(parseBookingSequenceReceipt(aggregate)).toBeNull();
  });

  it("rejects malformed prep equations, customer-work overlap, tax, or add-ons", () => {
    const prep = receipt();
    prep.segments[0].occupied_start_utc = "2026-08-28T17:51:00.000Z";
    expect(parseBookingSequenceReceipt(prep)).toBeNull();

    const overlap = receipt();
    overlap.pricing_snapshot.segments[1] = {
      ...overlap.pricing_snapshot.segments[1],
      occupied_start_utc: "2026-08-28T18:15:00.000Z",
      service_start_utc: "2026-08-28T18:20:00.000Z",
      service_end_utc: "2026-08-28T19:00:00.000Z",
      occupied_end_utc: "2026-08-28T19:00:00.000Z",
    };
    overlap.segments[1] = {
      ...overlap.pricing_snapshot.segments[1],
      segment_id: segmentIds[1],
      reservation_status: "confirmed",
    };
    expect(parseBookingSequenceReceipt(overlap)).toBeNull();

    const tax = receipt();
    tax.segments[0]!.tax_breakdown![0]!.amount_cents = 249;
    expect(parseBookingSequenceReceipt(tax)).toBeNull();

    const addon = receipt();
    addon.pricing_snapshot.segments[0].addon_lines[0].price_cents = 999;
    expect(parseBookingSequenceReceipt(addon)).toBeNull();
  });

  it("rejects missing, duplicate, or out-of-order lines", () => {
    const missing = receipt();
    missing.segments.pop();
    expect(parseBookingSequenceReceipt(missing)).toBeNull();

    const duplicate = receipt();
    duplicate.pricing_snapshot.segments[1].line_id = lineIds[0];
    duplicate.segments[1].line_id = lineIds[0];
    expect(parseBookingSequenceReceipt(duplicate)).toBeNull();

    const order = receipt();
    order.segments.reverse();
    expect(parseBookingSequenceReceipt(order)).toBeNull();
  });

  it("renders every persisted line and the reconciled aggregate receipt", () => {
    const parsed = parseBookingSequenceReceipt(receipt());
    expect(parsed).not.toBeNull();
    const html = buildHtml(
      "QA Salon",
      {
        bookingId,
        shopSlug: "qa-salon",
        clientName: "QA Guest",
        clientEmail: "qa@example.com",
        clientLocale: "en",
        serviceName: "untrusted summary",
        staffName: "untrusted staff",
        startTimeUtc: parsed!.parentStartTimeUtc,
        totalPriceCents: parsed!.totalCents,
        sequenceReceipt: parsed,
        sequenceLineDateTimes: ["Friday, 11:00 AM", "Friday, 11:30 AM"],
      },
      "Friday, 11:00 AM",
      "https://example.test/status",
      "CAD",
      null,
    );
    expect(html).toContain("1. Structured Gel");
    expect(html).toContain("2. Nail Art");
    expect(html).toContain("Friday, 11:00 AM");
    expect(html).toContain("Friday, 11:30 AM");
    expect(html).toContain("Mai");
    expect(html).toContain("Linh");
    expect(html).toContain("10 min");
    expect(html).toContain("5 min");
    expect(html).toContain("Chrome");
    expect(html).toContain("QA promo");
    expect(html).toContain("Email incentive");
    expect(html).toContain("Voucher");
    expect(html).not.toContain("untrusted summary");
    expect(html).not.toContain("untrusted staff");
  });

  it("accepts an exact nested management receipt and rejects nested tampering", () => {
    const inspection = (sequenceReceipt: ReturnType<typeof receipt>) => ({
      ok: true,
      code: "valid",
      action: "status",
      scope_kind: "booking_own",
      epoch: 1,
      expires_at: "2099-08-28T20:00:00.000Z",
      booking: {
        status: "confirmed",
        attendance_status: null,
        start_time_utc: "2026-08-28T18:00:00.000Z",
        end_time_utc: "2026-08-28T19:10:00.000Z",
        service_name: "Structured Gel",
        staff_name: "Mai",
        salon_slug: "qa-salon",
        salon_name: "QA Salon",
        salon_timezone: "America/Vancouver",
        schedule_model: "segments_v1",
        sequence_receipt: sequenceReceipt,
      },
      context: {
        booking_id: bookingId,
        salon_id: salonId,
        service_id: serviceIds[0],
        staff_id: staffIds[0],
        duration_minutes: 70,
        timezone: "America/Vancouver",
        current_start_time_utc: "2026-08-28T18:00:00.000Z",
        current_end_time_utc: "2026-08-28T19:10:00.000Z",
        group_id: null,
        is_group_organizer: false,
      },
      cancel_preview: {
        start_past: false,
        within_window: false,
        will_charge: false,
        policy_locked_by_reschedule: false,
        fee_cents: 0,
        card_last4: null,
        card_brand: null,
        currency: "CAD",
      },
      card_manage: {
        has_card: false,
        card_fingerprint: "f".repeat(64),
        card_last4: null,
        card_brand: null,
        charge_status: null,
      },
      group: null,
    });

    expect(
      parseBookingManagementInspection(inspection(receipt()), "status"),
    ).toMatchObject({
      ok: true,
      inspection: {
        booking: {
          scheduleModel: "segments_v1",
          sequenceReceipt: { totalCents: 9_450, segments: [{ position: 0 }, { position: 1 }] },
        },
      },
    });

    const tampered = receipt();
    tampered.segments[0]!.total_cents = (tampered.segments[0]!.total_cents ?? 0) + 1;
    expect(
      parseBookingManagementInspection(inspection(tampered), "status"),
    ).toEqual({ ok: false, code: "invalid_management_response" });
  });
});
