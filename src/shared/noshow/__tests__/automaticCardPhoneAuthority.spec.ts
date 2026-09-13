import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ provider: vi.fn(), find: vi.fn(), persist: vi.fn(), update: vi.fn(), from: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/integrations/square/looseDb", () => ({ looseServiceClient: () => db }));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: m.provider }));
vi.mock("@/shared/booking/persistExistingSquareCardReceipt", () => ({ persistExistingSquareCardReceipt: m.persist }));
vi.mock("@/shared/integrations/square/client", () => ({ createPaymentLink: vi.fn(), getOrder: vi.fn(), getSquareConfig: vi.fn() }));
vi.mock("@/shared/payments/executeBookingPaymentOperation", () => ({ runAuthoritativeBookingPaymentOperation: vi.fn(), runAuthoritativeLateCancelRefund: vi.fn() }));

import { autoAttachReturningCard } from "@/shared/integrations/square/noshow";
import { buildNoShowConsentPolicy } from "@/shared/noshow/noShowConsentPolicy";

const bookingId = "07070000-0000-4000-8000-000000000001";
const salonId = "07070000-0000-4000-8000-000000000002";
const sessionId = "07070000-0000-4000-8000-000000000003";
const foreignId = "07070000-0000-4000-8000-000000000004";
const phone = "15555550123";
const storedPolicy = { en: "Cancel at least 24 hours before your appointment. Missed visits may incur the disclosed fee.", vi: "Vui lòng huỷ trước giờ hẹn ít nhất 24 giờ. Lịch vắng có thể chịu mức phí đã công bố." };
const policy = buildNoShowConsentPolicy({ storedPolicy, salonName: "E2E Synthetic", feeCents: 1000, currency: "CAD", scope: "booking_member" });
let booking: Record<string, unknown>;
let session: Record<string, unknown> | null;
let sessionError: unknown;
let priorConsent: boolean;

const db = {
  from(table: string) {
    m.from(table);
    let columns = "";
    const chain = {
      select(value: string) { columns = value; return chain; },
      eq() { return chain; }, not() { return chain; }, order() { return chain; }, limit() { return chain; },
      update(value: unknown) { m.update(table, value); return chain; },
      async maybeSingle() {
        const row: Record<string, unknown> | null = table === "bookings" ? booking : table === "phone_otp_sessions" ? session : table === "salons" ? {
          noshow_protection_enabled: true, noshow_fee_percent: 20,
          currency_code: "CAD", name: "E2E Synthetic", cancellation_policy: storedPolicy,
        } : null;
        return { data: row && Object.fromEntries(columns.split(",").map(k => k.trim()).map(k => [k, row[k]])), error: table === "phone_otp_sessions" ? sessionError : null };
      },
      then(resolve: (result: {data: unknown[]; error: null}) => unknown) {
        const data = table === "bookings" && priorConsent ? [{noshow_consent_meta: {policyVersion: policy.version, feeCents: 1000, currency: "CAD", scope: "booking_member"}}] : [];
        return Promise.resolve({data, error:null}).then(resolve);
      },
    };
    return chain;
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NAILIQ_CARD_SAVE_DISPATCH_DISABLED", "false");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network_forbidden"); }));
  booking = {id:bookingId,salon_id:salonId,client_phone:phone,price_cents:5000,card_protection_status:"awaiting_card",noshow_card_required:true,otp_session_id:sessionId};
  session = {id:sessionId,salon_id:salonId,phone,verified_channel:"sms",verified_at:"2026-09-01T12:00:00Z",expires_at:"2026-09-01T12:15:00Z",consumed_at:"2026-09-01T12:01:00Z",consumed_by_booking_id:bookingId};
  sessionError = null; priorConsent = true;
  m.provider.mockResolvedValue({kind:"square",findSavedCardByPhone:m.find});
  m.find.mockResolvedValue({cardId:"synthetic-card",customerId:"synthetic-customer",brand:"VISA",last4:"4242",binding:{customerId:"synthetic-customer",merchantId:"synthetic-merchant",environment:"sandbox"}});
  m.persist.mockResolvedValue(true);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  expect(m.from).not.toHaveBeenCalledWith("client_profiles");
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

async function expectNoInheritance() {
  expect(await autoAttachReturningCard(bookingId)).toEqual({attached:false,reason:"phone ownership proof required"});
  expect(m.provider).not.toHaveBeenCalled();
  expect(m.find).not.toHaveBeenCalled();
  expect(m.persist).not.toHaveBeenCalled();
  expect(m.update).not.toHaveBeenCalled();
}

describe("automatic returning-card attachment requires committed SMS phone authority", () => {
  it.each(["email", "staff_attested", "demo", "legacy_unverified", undefined, "invalid"])("does not inherit a phone's card for channel %s", async channel => {
    session!.verified_channel = channel;
    // Previously stored profile/email verification cannot upgrade this proof.
    Object.assign(booking, {client_email:"qa@example.test",phone_verified_at:"2026-01-01T00:00:00Z",booking_channel:"desk",verification_method:"otp"});
    await expectNoInheritance();
  });
  it.each([null,"",foreignId])("does not infer authority from a missing or foreign consumed-booking binding: %s", async binding => {
    session!.consumed_by_booking_id = binding;
    await expectNoInheritance();
  });
  it.each([
    {id:foreignId}, {salon_id:foreignId}, {phone:"15555550124"},
    {consumed_at:null}, {verified_at:null}, {expires_at:"not-a-date"},
    {consumed_at:"2026-09-01T11:59:59Z"}, {consumed_at:"2026-09-01T12:15:00Z"},
    {consumed_at:"2026-09-01T12:16:00Z"},
  ])("fails closed on session mismatch or invalid proof chronology: %j", async change => {
    Object.assign(session!, change); await expectNoInheritance();
  });
  it("rejects an unknown session", async () => { session = null; await expectNoInheritance(); });
  it("rejects an uncertain session read even when data is returned", async () => {
    sessionError = {message:"synthetic-private-diagnostic"};
    await expectNoInheritance();
  });
  it.each([undefined,"not-a-session"])("does not read or inherit on a missing/invalid booking session: %s", async id => {
    booking.otp_session_id = id;
    await expectNoInheritance();
    expect(m.from).not.toHaveBeenCalledWith("phone_otp_sessions");
  });
  it("preserves a real SMS proof consumed by this booking after its interactive expiry", async () => {
    expect(Date.parse(String(session!.expires_at))).toBeLessThan(Date.now());
    expect(await autoAttachReturningCard(bookingId)).toEqual({attached:true,reason:"carried forward",last4:"4242"});
    expect(m.find).toHaveBeenCalledExactlyOnceWith(phone);
    expect(m.persist).toHaveBeenCalledWith(expect.objectContaining({bookingId,salonId,source:"prior_matching_consent"}));
  });
  it("still requires exact prior consent after phone ownership is proven", async () => {
    priorConsent = false;
    expect(await autoAttachReturningCard(bookingId)).toEqual({attached:false,reason:"fresh consent required"});
    expect(m.find).not.toHaveBeenCalled(); expect(m.persist).not.toHaveBeenCalled();
  });
  it("does not report a card attached when receipt persistence rejects it", async () => {
    m.persist.mockResolvedValue(false);
    expect(await autoAttachReturningCard(bookingId)).toEqual({attached:false,reason:"fresh consent required"});
  });
  it("preserves an already verified saved receipt without inheriting a new card", async () => {
    booking.card_protection_status = "saved";
    delete booking.otp_session_id;
    expect(await autoAttachReturningCard(bookingId)).toEqual({attached:true,reason:"already saved"});
    expect(m.from).not.toHaveBeenCalledWith("phone_otp_sessions");
    expect(m.find).not.toHaveBeenCalled(); expect(m.persist).not.toHaveBeenCalled();
  });
});
