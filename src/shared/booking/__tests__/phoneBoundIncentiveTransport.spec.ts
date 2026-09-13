import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => mocks }));
import { resolvePublicBookingQuote } from "../publicBookingQuoteServer";
import { resolveGroupBookingQuote, createGroupBookingsAuthoritative } from "../groupBookingPricingServer";
import { quotePublicBookingSequence, createPublicBookingSequence } from "../bookingSequenceServer";
import { DEFINITE_CREATE_REJECTIONS } from "../pendingBookingCreate";
import { buildPublicBookingPricingQuoteKey } from "../publicBookingPricing";

const SALON = "10000000-0000-4000-8000-000000000001";
const SERVICE = "10000000-0000-4000-8000-000000000002";
const STAFF = "10000000-0000-4000-8000-000000000003";
const SESSION = "10000000-0000-4000-8000-000000000004";
const REQUEST = "10000000-0000-4000-8000-000000000005";
const LINE = "10000000-0000-4000-8000-000000000006";
const start = "2026-09-20T18:00:00Z";
const end = "2026-09-20T18:30:00Z";
const single = { salonId: SALON, serviceId: SERVICE, resolvedStaffId: STAFF,
  startTimeUtc: start, endTimeUtc: end, addonServiceIds: [], clientPhone: "16045550901",
  clientEmail: "synthetic@example.test", applyEmailDiscount: true };
const group = { salonId: SALON, applyEmailDiscount: true, bookings: [0, 1].map(i => ({
  serviceId: SERVICE, staffId: STAFF, startTimeUtc: start, endTimeUtc: end, addonServiceIds: [],
  clientName: `Synthetic Member ${i}`, clientPhone: `1604555090${i + 1}`, clientEmail: "synthetic@example.test",
})) };
const sequence = { salonId: SALON, requestId: REQUEST, requestedStartTimeUtc: start,
  lines: [{ lineId: LINE, position: 0, serviceId: SERVICE, staffPreference: "any" as const,
    preferredResourceId: null, addOnServiceIds: [] }], sameStaffForAll: false, voucherCode: null,
  applyEmailDiscount: true, customer: { name: "Synthetic Contact", phone: "+16045550901", email: "synthetic@example.test" } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: { success: false, code: "phone_verification_required" }, error: null });
});
describe("phone incentive proof survives public transport without being treated as an outage", () => {
  it.each([null, SESSION])("single passes proof %s and preserves the database instruction", async otpSessionId => {
    expect(await resolvePublicBookingQuote({ ...single, otpSessionId } as never))
      .toEqual({ ok: false, code: "phone_verification_required" });
    expect(mocks.rpc).toHaveBeenCalledWith("resolve_public_booking_pricing", expect.objectContaining({ p_otp_session_id: otpSessionId, p_apply_email_discount: true }));
  });
  it.each([undefined, SESSION])("group quote passes proof %s", async otpSessionId => {
    expect(await resolveGroupBookingQuote({ ...group, otpSessionId })).toEqual({ ok: false, code: "phone_verification_required" });
    expect(mocks.rpc).toHaveBeenCalledWith("quote_group_booking", expect.objectContaining({ p_otp_session_id: otpSessionId ?? null, p_apply_email_discount: true }));
  });
  it("group create preserves proof rejection before any booking receipt", async () => {
    expect(await createGroupBookingsAuthoritative({ ...group, otpSessionId: SESSION,
      idempotencyKey: REQUEST, expectedPricingFingerprint: "a".repeat(64) }))
      .toEqual({ ok: false, code: "phone_verification_required" });
    expect(mocks.rpc).toHaveBeenCalledWith("create_group_bookings", expect.objectContaining({ p_otp_session_id: SESSION }));
  });
  it("sequence quote serializes the proof and preserves the business code", async () => {
    expect(await quotePublicBookingSequence({ ...sequence, otpSessionId: SESSION }))
      .toEqual({ ok: false, code: "phone_verification_required" });
    expect(mocks.rpc).toHaveBeenCalledWith("quote_public_booking_sequence", expect.objectContaining({ p_request: expect.objectContaining({ otp_session_id: SESSION }) }));
  });
  it("sequence create preserves the proof rejection without an ambiguous outcome", async () => {
    expect(await createPublicBookingSequence({ intent: sequence, otpSessionId: SESSION,
      expectedPricingFingerprint: "a".repeat(64), healthAcknowledged: false, smsConsent: false, language: "en" }))
      .toEqual({ ok: false, code: "phone_verification_required" });
    expect(DEFINITE_CREATE_REJECTIONS.has("phone_verification_required")).toBe(true);
  });
  it("rejects malformed proof and caller-asserted authority before the pricing RPC", async () => {
    for (const extra of [{ otpSessionId: "not-a-session" }, { phoneVerified: true }, { verifiedChannel: "sms" }]) {
      expect(await resolvePublicBookingQuote({ ...single, ...extra } as never)).toEqual({ ok: false, code: "invalid_request" });
      expect(await resolveGroupBookingQuote({ ...group, ...extra })).toEqual({ ok: false, code: "invalid_request" });
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not change the caller's explicit no-discount selection", async () => {
    await resolvePublicBookingQuote({ ...single, applyEmailDiscount: false } as never);
    expect(mocks.rpc).toHaveBeenCalledWith("resolve_public_booking_pricing", expect.objectContaining({ p_otp_session_id: null, p_apply_email_discount: false }));
  });
  it("invalidates an existing browser quote when the proof is replaced", () => {
    const key = { ...single, shopSlug: "synthetic", staffId: STAFF, bookingDateYmd: "2026-09-20", timeSlot: "11:00" };
    expect(buildPublicBookingPricingQuoteKey(key)).not.toBe(buildPublicBookingPricingQuoteKey({ ...key, otpSessionId: SESSION }));
    expect(buildPublicBookingPricingQuoteKey({ ...key, otpSessionId: SESSION })).not.toBe(buildPublicBookingPricingQuoteKey({ ...key, otpSessionId: REQUEST }));
  });
});
