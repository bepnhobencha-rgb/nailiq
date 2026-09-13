import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const guards = vi.hoisted(() => ({
  database: vi.fn(() => { throw new Error("mutable_database_forbidden"); }),
  limit: vi.fn(() => { throw new Error("mutable_limit_forbidden"); }),
  sideEffects: vi.fn(() => { throw new Error("outbound_forbidden"); }),
  settleCard: vi.fn(() => { throw new Error("card_provider_forbidden"); }),
  reuseCard: vi.fn(() => { throw new Error("card_reuse_forbidden"); }),
  cardEnabled: vi.fn(() => false),
  reporter: vi.fn(),
}));
vi.mock("@/shared/lib/supabase/publicClient", () => ({ createPublicClient: guards.database }));
vi.mock("@/shared/booking/assertBookingLimit", () => ({ assertBookingLimitAvailable: guards.limit }));
vi.mock("@/shared/booking/publicBookingSideEffects", () => ({ runPublicBookingSideEffects: guards.sideEffects }));
vi.mock("@/shared/booking/settleCommittedBookingCardManagement", () => ({ settleCommittedBookingCardManagement: guards.settleCard }));
vi.mock("@/shared/noshow/saveNoShowCardAction", () => ({ reuseNoShowCardAction: guards.reuseCard }));
vi.mock("@/shared/release/v1IntegrationScope", () => ({ v1AllowsNoShowCardOnFile: guards.cardEnabled }));
vi.mock("@/shared/observability/errorReporter", () => ({
  getCurrentScope: () => ({ setTag: guards.reporter }),
  captureMessage: guards.reporter, captureException: guards.reporter,
}));

import { submitPublicBooking, type BookingParams } from "@/shared/booking/submitPublicBooking";
import { parsePublicBookingPricingQuote } from "@/shared/booking/publicBookingPricing";
import sqlWireReceipt from "./fixtures/paidReplaySqlReceipt.json";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const receipt = () => ({
  success: true, booking_id: id(8), staff_id: id(3),
  pricing_fingerprint: "a".repeat(64), salon_id: id(1), service_id: id(2),
  start_time_utc: "2026-01-01T17:00:00+00:00", end_time_utc: "2026-01-01T18:00:00+00:00",
  combo_id: id(11), voucher_id: id(12), currency: "CAD",
  original_price_cents: 10_000, service_pre_voucher_cents: 9_800,
  price_cents: 9_300, addon_pre_voucher_cents: 1_200, addon_price_cents: 1_200,
  promo_id: null, promo_name: null, promo_discount_cents: 0, email_discount_cents: 200,
  voucher_discount_cents: 500, pre_voucher_subtotal_cents: 11_000,
  subtotal_cents: 10_500, tax_cents: 525, total_cents: 11_025,
  tax_breakdown: [{ name: "GST", rate: 0.05, amount_cents: 525 }],
  addon_lines: [
    { service_id: id(5), name: "Synthetic art", price_cents: 700,
      duration_minutes: 10, buffer_minutes: 0, addon_timing: "sequential" },
    { service_id: id(4), name: "Synthetic finish", price_cents: 500,
      duration_minutes: 5, buffer_minutes: 0, addon_timing: "sequential" },
  ],
});
const envelope = () => ({
  success: true, code: "booking_payment_replay", idempotent: true,
  booking_id: id(8), operation_id: id(6), payment_status: "succeeded",
  material_fingerprint: "b".repeat(64), booking: receipt(),
});

function params(): BookingParams {
  const expected = parsePublicBookingPricingQuote(receipt(), {
    resolvedStaffId: id(3), resolvedStaffName: "Synthetic staff", voucherCode: "QA5",
  })!;
  return {
    // These mutable inputs are deliberately stale/invalid. Recovery must not
    // inspect catalog, date, hours, cap or draft contact after payment/commit.
    shopSlug: "deleted-synthetic-salon", serviceId: "catalog-item-deleted",
    staffId: "staff-deactivated", timeSlot: "invalid-current-slot",
    bookingDateYmd: "2020-01-01", clientName: "", clientPhone: "invalid",
    clientEmail: "changed@example.test", emailCaptureDiscount: false,
    otpSessionId: id(10), noShowCardSourceId: "old-source-never-replay",
    noShowCardVerificationToken: "old-verification-never-replay",
    noShowReuseSavedCard: true, noShowConsent: true, smsConsent: true,
    referenceImagePath: "never-dispatch", referralCode: "never-dispatch",
    marketingConsent: true, language: "vi", idempotencyKey: id(9),
    idempotencyReplay: true, expectedPricingQuote: expected,
    paidDeposit: { operationId: id(6), paymentRequestId: id(7), materialFingerprint: "b".repeat(64) },
    paidReplayServiceName: "Synthetic retained service",
    paidReplayMaterial: {
      salonId: id(1), serviceId: id(2), staffId: id(3),
      clientName: "Synthetic Guest", clientPhone: "16045550799",
      clientEmail: "qa@example.test", clientNotes: "Retained synthetic note",
      startTimeUtc: "2026-01-01T17:00:00.000Z", endTimeUtc: "2026-01-01T18:00:00.000Z",
      addonServiceIds: [id(5), id(4)], resourceId: null, comboId: id(11), voucherId: id(12),
      applyEmailDiscount: true, expectedPricingFingerprint: "a".repeat(64),
    },
  };
}

describe("actual public submit: immutable paid booking replay", () => {
  let fetcher: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    guards.cardEnabled.mockReturnValue(false);
    fetcher = vi.fn(async () => new Response(JSON.stringify(envelope()), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    // No test may touch DB/catalog, provider/card mutation or post-commit sends.
    expect(guards.limit).not.toHaveBeenCalled();
    expect(guards.sideEffects).not.toHaveBeenCalled();
    expect(guards.settleCard).not.toHaveBeenCalled();
    expect(guards.reuseCard).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("recovers past committed appointment despite invalid current catalog/cap/slot and consumed or expired proof", async () => {
    const input = params();
    const result = await submitPublicBooking(input);
    expect(guards.database).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/booking/deposit-create");
    const options = fetcher.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(options.body as string)).toEqual({
      ...input.paidReplayMaterial,
      expectedPricingFingerprint: undefined,
      pricingFingerprint: input.expectedPricingQuote!.pricingFingerprint,
      idempotencyKey: id(9), paymentOperationId: id(6), paymentRequestId: id(7),
      paymentMaterialFingerprint: "b".repeat(64), replayOnly: true, otpSessionId: null,
    });
    expect(options.body).not.toContain("old-source");
    expect(options.body).not.toContain("old-verification");
    expect(options.body).not.toContain("changed@example.test");
    expect(result).toMatchObject({
      bookingId: id(8), status: "confirmed", serviceName: "Synthetic retained service",
      staffName: "Synthetic staff", totalCents: 11_025, price_cents: 10_500,
      cardManagementToken: null, cardManagementPending: false,
      cardManagementRecoveryHref: null,
      confirmationDelivery: { sms: "unverified", email: "unverified" },
    });
    expect(guards.reporter).not.toHaveBeenCalled();
  });

  it("keeps an explicit protection recovery link without asserting saved card or replaying its token", async () => {
    guards.cardEnabled.mockReturnValue(true);
    const result = await submitPublicBooking(params());
    expect(result.cardManagementPending).toBe(true);
    expect(result.cardManagementToken).toBeNull();
    expect(result.cardManagementRecoveryHref).toBe(`/booking/recover-card#recover=${id(1)}.${id(8)}.${id(9)}.${"a".repeat(64)}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("accepts the actual offline SQL create/bind/replay receipt with consumed expired SMS", async () => {
    const input = params();
    input.paidReplayMaterial = sqlWireReceipt.material;
    input.expectedPricingQuote = parsePublicBookingPricingQuote(sqlWireReceipt.quote, {
      resolvedStaffId: sqlWireReceipt.material.staffId, resolvedStaffName: "Synthetic SQL staff",
    });
    input.idempotencyKey = sqlWireReceipt.idempotencyKey;
    input.paidDeposit = {
      operationId: sqlWireReceipt.response.operation_id,
      paymentRequestId: sqlWireReceipt.paymentRequestId,
      materialFingerprint: sqlWireReceipt.response.material_fingerprint,
    };
    fetcher.mockResolvedValue(new Response(JSON.stringify(sqlWireReceipt.response), { status: 200 }));
    const result = await submitPublicBooking(input);
    expect(result.bookingId).toBe(sqlWireReceipt.response.booking_id);
    expect(result.totalCents).toBe(sqlWireReceipt.quote.total_cents);
    expect(guards.database).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not invent message requests absent from the retained booking", async () => {
    const input = params();
    input.paidReplayMaterial!.clientEmail = null;
    input.smsConsent = false;
    const result = await submitPublicBooking(input);
    expect(result.confirmationDelivery).toEqual({ sms: "not_requested", email: "not_requested" });
  });

  it.each([undefined, null])("keeps missing retained material (%s) locked instead of reconstructing it", async value => {
    await expect(submitPublicBooking({ ...params(), paidReplayMaterial: value })).rejects.toThrow("deposit_booking_recovery_required");
    expect(fetcher).not.toHaveBeenCalled();
    expect(guards.database).not.toHaveBeenCalled();
  });

  it.each([
    ["salon", { salonId: id(30) }], ["service", { serviceId: id(30) }],
    ["staff", { staffId: id(30) }], ["interval", { endTimeUtc: "2026-01-01T19:00:00Z" }],
    ["fingerprint", { expectedPricingFingerprint: "c".repeat(64) }],
    ["voucher", { voucherId: null }], ["combo", { comboId: null }],
    ["addon order", { addonServiceIds: [id(4), id(5)] }],
  ])("rejects retained %s differing from the confirmed quote before any request", async (_label, delta) => {
    const input = params();
    input.paidReplayMaterial = { ...input.paidReplayMaterial!, ...delta };
    await expect(submitPublicBooking(input)).rejects.toThrow("deposit_booking_recovery_required");
    expect(fetcher).not.toHaveBeenCalled();
    expect(guards.database).not.toHaveBeenCalled();
  });

  it.each([
    ["unbound", { success: false, code: "booking_recovery_required" }],
    ["fresh create receipt", { ...envelope(), code: "booked", idempotent: false }],
    ["operation", { ...envelope(), operation_id: id(30) }],
    ["payment fingerprint", { ...envelope(), material_fingerprint: "c".repeat(64) }],
    ["invalid booking ID", { ...envelope(), booking_id: "not-a-booking" }],
    ["mismatched booking ID", { ...envelope(), booking_id: id(30) }],
    ["refund pending", { ...envelope(), payment_status: "unknown" }],
    ["wrong staff", { ...envelope(), booking: { ...receipt(), staff_id: id(30) } }],
    ["wrong tenant", { ...envelope(), booking: { ...receipt(), salon_id: id(30) } }],
    ["wrong quote fingerprint", { ...envelope(), booking: { ...receipt(), pricing_fingerprint: "c".repeat(64) } }],
    ["wrong interval", { ...envelope(), booking: { ...receipt(), end_time_utc: "2026-01-01T19:00:00Z" } }],
    ["malformed arithmetic", { ...envelope(), booking: { ...receipt(), total_cents: 0 } }],
    ["changed but valid tax", { ...envelope(), booking: { ...receipt(), tax_cents: 0, total_cents: 10_500, tax_breakdown: [] } }],
    ["missing pricing", { ...envelope(), booking: { success: true, booking_id: id(8) } }],
  ])("never returns false success or falls through to create on %s", async (_label, value) => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(value), { status: 200 }));
    await expect(submitPublicBooking(params())).rejects.toThrow("deposit_booking_recovery_required");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(guards.database).not.toHaveBeenCalled();
    expect(guards.reporter).not.toHaveBeenCalled();
  });

  it.each([409, 503])("keeps HTTP %s recovery errors locked", async status => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(envelope()), { status }));
    await expect(submitPublicBooking(params())).rejects.toThrow("deposit_booking_recovery_required");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps lost response locked after a bounded wait even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    fetcher.mockImplementation(() => new Promise(() => {}));
    const pending = expect(submitPublicBooking(params())).rejects.toThrow("deposit_booking_recovery_required");
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;
    expect((fetcher.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("repeated recovery only returns the same binding and never starts a new operation", async () => {
    const input = params();
    expect((await submitPublicBooking(input)).bookingId).toBe((await submitPublicBooking(input)).bookingId);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
    expect(guards.database).not.toHaveBeenCalled();
  });

  it("preserves fresh-create preflight when the caller explicitly did not submit before", async () => {
    const input = { ...params(), idempotencyReplay: false,
      clientName: "Synthetic Guest", clientPhone: "16045550799" };
    await expect(submitPublicBooking(input)).rejects.toThrow("mutable_database_forbidden");
    expect(guards.database).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
