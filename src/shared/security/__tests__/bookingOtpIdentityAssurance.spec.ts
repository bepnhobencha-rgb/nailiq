import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: vi.fn(), emailDelivery: vi.fn(), checkSms: vi.fn(), savedCard: vi.fn(), provider: vi.fn(), demo: false, ignoreChannelFilter: false, phase: "send", queries: [] as { phase: string; table: string }[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.db }));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({ consumeDurableRateLimitBuckets: async () => "allowed", consumePublicRequestRateLimit: async () => "allowed" }));
vi.mock("@/shared/lib/twilioVerify", () => ({ sendVerification: () => { throw new Error("No provider dispatch allowed"); }, checkVerification: mocks.checkSms }));
vi.mock("@/shared/lib/demoOtpMode", () => ({ isDemoOtpRuntime: () => mocks.demo }));
vi.mock("@/shared/lib/resend", () => ({ getResendClient: () => ({ emails: { send: mocks.emailDelivery } }), getResendFrom: () => "Synthetic sender <sender@example.test>" }));
vi.mock("@/shared/lib/emailExperience", () => ({ buildEmailExperience: () => ({ html: "synthetic", text: "synthetic", tags: [], headers: {} }) }));
vi.mock("@/shared/booking/otpDeliveryTruth", () => ({
  createBookingOtpDeliveryAttempt: async () => ({ ok: true, attemptId: "22222222-2222-4222-8222-222222222222" }),
  completeBookingOtpDeliveryAttempt: async () => true,
  markBookingOtpDeliveryVerified: async () => true,
  isBookingOtpDeliveryAttemptId: (id: string) => /^[0-9a-f-]{36}$/.test(id),
}));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: mocks.provider }));

// These routes/helpers are the real implementation. Only storage, rate limits,
// delivery and provider adapters are synthetic; email HMAC verification is real.
import { POST as send } from "@/app/api/booking-otp/send/route";
import { POST as verify } from "@/app/api/booking-otp/verify/route";
import { GET as profile } from "@/app/api/customer/profile-verified/route";
import { resolveSavedNoShowCard } from "@/shared/noshow/resolveSavedNoShowCard";
import { requirePhoneVerified } from "@/shared/voiceai/otpGate";

type Row = Record<string, unknown>;
const salonId = "11111111-1111-4111-8111-111111111111";
const sessionId = "33333333-3333-4333-8333-333333333333";
const phone = "16045550191";
const outsiderEmail = "outsider@example.test";
const profileEmail = "existing-customer@example.test";
let tables: Record<string, Row[]>;

function builder(table: string) {
  mocks.queries.push({ phase: mocks.phase, table });
  if (!(table in tables)) throw new Error(`Unexpected synthetic table ${table}`);
  const filters: ((row: Row) => boolean)[] = [];
  let operation: "read" | "insert" | "update" = "read";
  let patch: Row = {};
  let head = false;
  let result: { data: Row[] | null; count: number; error: null } | undefined;
  function execute() {
    if (result) return result;
    let found = tables[table].filter(row => filters.every(filter => filter(row)));
    if (operation === "insert") {
      const row = {
        id: table === "phone_otp_sessions" ? sessionId : "44444444-4444-4444-8444-444444444444",
        created_at: new Date().toISOString(), verified_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(), consumed_at: null, attempts: 0,
        ...patch,
      };
      tables[table].push(row); found = [row];
    } else if (operation === "update") {
      for (const row of found) Object.assign(row, patch);
    }
    return result = { data: head ? null : found, count: found.length, error: null };
  }
  const query = {
    select: (_columns?: unknown, options?: { head?: boolean }) => { head = options?.head === true; return query; },
    eq: (key: string, value: unknown) => { if (!(key === "verified_channel" && mocks.ignoreChannelFilter)) filters.push(row => row[key] === value); return query; },
    is: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
    gt: (key: string, value: string) => { filters.push(row => key === "expires_at" ? Date.parse(String(row[key])) > Date.parse(value) : String(row[key]) > value); return query; },
    gte: (key: string, value: string) => { filters.push(row => String(row[key]) >= value); return query; },
    order: () => query,
    limit: () => query,
    insert: (value: Row) => { operation = "insert"; patch = value; return query; },
    update: (value: Row) => { operation = "update"; patch = value; return query; },
    maybeSingle: async () => { const value = execute(); return { ...value, data: value.data?.[0] ?? null }; },
    single: async () => { const value = execute(); return { ...value, data: value.data?.[0] ?? null }; },
    then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(execute()).then(resolve, reject),
  };
  return query;
}
function request(body: Row) {
  return new Request("https://synthetic.test/api/booking-otp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-12T20:00:00.000Z"));
  mocks.demo = false; mocks.ignoreChannelFilter = false;
  // No real network, database connection, provider SDK or recipients exist here.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Audit network forbidden"); }));
  vi.stubEnv("DISABLE_OUTBOUND_EMAIL", "false");
  vi.stubEnv("INTERNAL_API_SECRET", "synthetic-otp-audit-secret");
  mocks.phase = "send"; mocks.queries = [];
  tables = {
    salons: [{ id: salonId, slug: "synthetic-salon", name: "Synthetic salon", phone_otp_enabled: true, email_links_enabled: true }],
    email_otp_codes: [], phone_otp_sessions: [],
    client_profiles: [{ id: "55555555-5555-4555-8555-555555555555", phone, name: "Synthetic Existing Customer", email: profileEmail, deleted_at: null, is_vip: true }],
    bookings: [{ id: "66666666-6666-4666-8666-666666666666", salon_id: salonId, client_phone: phone, status: "confirmed", start_time_utc: "2026-09-20T18:00:00Z", service_id: "77777777-7777-4777-8777-777777777777", staff_id: "88888888-8888-4888-8888-888888888888" }],
    services: [{ id: "77777777-7777-4777-8777-777777777777", salon_id: salonId, name: "Synthetic service", deleted_at: null }],
    staff: [{ id: "88888888-8888-4888-8888-888888888888", salon_id: salonId, name: "Synthetic staff", deleted_at: null }],
  };
  mocks.db.mockReturnValue({ from: builder });
  mocks.emailDelivery.mockResolvedValue({ data: { id: "synthetic-delivery" }, error: null });
  mocks.checkSms.mockResolvedValue({ ok: false, error: "invalid_code" });
  mocks.savedCard.mockResolvedValue({ brand: "Visa", last4: "4242" });
  mocks.provider.mockResolvedValue({ findSavedCardByPhone: mocks.savedCard });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function session(overrides: Row = {}) {
  tables.phone_otp_sessions = [{
    id: sessionId, phone, salon_id: salonId, verified_channel: "sms",
    expires_at: new Date(Date.now() + 60_000).toISOString(), consumed_at: null, ...overrides,
  }];
}

function profileRequest(overrides: { sessionId?: string; phone?: string; salonId?: string } = {}) {
  return new Request(`https://synthetic.test/api/customer/profile-verified?otp_session_id=${overrides.sessionId ?? sessionId}&phone=${overrides.phone ?? phone}&salon_id=${overrides.salonId ?? salonId}`);
}

async function denyPhoneAuthority() {
  mocks.phase = "profile";
  const response = await profile(profileRequest());
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ found: false, error: "invalid_session" });
  expect(mocks.queries.filter(query => query.phase === "profile").map(query => query.table)).toEqual(["phone_otp_sessions"]);
  mocks.phase = "saved-card";
  expect(await resolveSavedNoShowCard({ salonId, otpSessionId: sessionId })).toEqual({ hasSavedCard: false });
  expect(mocks.provider).not.toHaveBeenCalled();
  expect(mocks.savedCard).not.toHaveBeenCalled();
  mocks.phase = "voice-gate";
  expect(await requirePhoneVerified(mocks.db() as SupabaseClient, salonId, phone, { otpSessionId: sessionId }))
    .toMatchObject({ ok: false, error: "otp_required" });
  expect(fetch).not.toHaveBeenCalled();
}

async function allowSmsAuthority() {
  mocks.phase = "profile";
  const response = await profile(profileRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ found: true, name: "Synthetic Existing Customer", email: profileEmail, isVip: true, visitCount: 1 });
  mocks.phase = "saved-card";
  expect(await resolveSavedNoShowCard({ salonId, otpSessionId: sessionId })).toEqual({ hasSavedCard: true, brand: "Visa", last4: "4242" });
  expect(mocks.savedCard).toHaveBeenCalledExactlyOnceWith(phone);
  mocks.phase = "voice-gate";
  expect(await requirePhoneVerified(mocks.db() as SupabaseClient, salonId, phone, { otpSessionId: sessionId })).toEqual({ ok: true, via: "otp" });
  expect(fetch).not.toHaveBeenCalled();
}

// The send and verify routes, email HMAC/consumption and all three consumers are
// real. Only DB/rate/delivery/provider adapters are synthetic. This catches
// issuance/read integration failures that separate mocked session tests miss.
describe("booking OTP proof assurance across issuance and private readers", () => {
  it.each([true, false])("email fallback verifies booking contact but never phone authority (telemetry receipt=%s)", async (withReceipt) => {
    const sent = await send(request({ phone: `+${phone}`, shopSlug: "synthetic-salon", channel: "email", email: outsiderEmail }));
    expect(sent.status).toBe(200);
    const delivery = mocks.emailDelivery.mock.calls[0][0];
    expect(delivery.to).toBe(outsiderEmail);
    expect(outsiderEmail).not.toBe(profileEmail);
    const code = /\b(\d{6})\b/.exec(delivery.subject)?.[1];
    expect(code).toBeDefined();
    if (!withReceipt) tables.email_otp_codes[0].delivery_attempt_id = null;
    mocks.phase = "verify";
    const verified = await verify(request({
      phone: `+${phone}`, shopSlug: "synthetic-salon", email: outsiderEmail, code,
      // A client's claimed proof type cannot promote email to phone authority.
      verified_channel: "sms",
    }));
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ ok: true, sessionId });
    expect(mocks.checkSms).not.toHaveBeenCalled();
    expect(tables.phone_otp_sessions).toHaveLength(1);
    expect(tables.phone_otp_sessions[0]).toMatchObject({ phone, salon_id: salonId, consumed_at: null, verified_channel: "email" });
    expect(tables.email_otp_codes[0].consumed_at).not.toBeNull();
    expect(mocks.queries.some(query => query.table === "client_profiles")).toBe(false);
    await denyPhoneAuthority();
  });

  it.each([false, true])("actual SMS verification grants phone authority, including fallback after an invalid email proof (%s)", async (emailProvided) => {
    mocks.checkSms.mockResolvedValue({ ok: true });
    const verified = await verify(request({
      phone: `+${phone}`, shopSlug: "synthetic-salon", code: "123456",
      ...(emailProvided ? { email: outsiderEmail } : {}),
      // Missing telemetry attempt ID must not erase actual successful SMS proof.
    }));
    expect(verified.status).toBe(200);
    expect(tables.phone_otp_sessions[0]).toMatchObject({ verified_channel: "sms" });
    expect(mocks.checkSms).toHaveBeenCalledExactlyOnceWith(`+${phone}`, "123456");
    await allowSmsAuthority();
  });

  it("demo verification stamps demo assurance and cannot expose a phone profile or saved card", async () => {
    mocks.demo = true;
    const verified = await verify(request({ phone: `+${phone}`, shopSlug: "synthetic-salon", code: "000000" }));
    expect(verified.status).toBe(200);
    expect(tables.phone_otp_sessions[0]).toMatchObject({ verified_channel: "demo" });
    expect(mocks.checkSms).not.toHaveBeenCalled();
    await denyPhoneAuthority();
  });

  it.each(["email", "legacy_unverified", "staff_attested", "demo", "unknown", null, undefined])(
    "rejects %s assurance even if the storage adapter fails to filter its channel", async (channel) => {
      mocks.ignoreChannelFilter = true;
      session({ verified_channel: channel });
      await denyPhoneAuthority();
    },
  );

  it.each([
    ["expired", { expires_at: "2026-09-12T19:59:59.999Z" }],
    ["exact expiry boundary", { expires_at: "2026-09-12T20:00:00.000Z" }],
    ["malformed expiry", { expires_at: "not-a-date" }],
    ["consumed", { consumed_at: "2026-09-12T19:59:59.000Z" }],
    ["wrong salon", { salon_id: "99999999-9999-4999-8999-999999999999" }],
    ["wrong session ID", { id: "99999999-9999-4999-8999-999999999999" }],
  ] as const)("rejects a same-channel SMS session with %s", async (_label, patch) => {
    session(patch);
    await denyPhoneAuthority();
  });

  it("rejects a phone mismatch for the profile and voice readers", async () => {
    session({ phone: "16045550192" });
    expect((await profile(profileRequest())).status).toBe(401);
    expect(await requirePhoneVerified(mocks.db() as SupabaseClient, salonId, phone, { otpSessionId: sessionId }))
      .toMatchObject({ ok: false, error: "otp_required" });
    expect(mocks.queries.some(query => query.table === "client_profiles")).toBe(false);
  });
});
