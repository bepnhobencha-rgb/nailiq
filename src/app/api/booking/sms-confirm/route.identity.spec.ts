import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: vi.fn(),
  rate: vi.fn(),
  send: vi.fn(),
  token: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: mocks.db }));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({ consumeDurableRateLimitBuckets: mocks.rate }));
vi.mock("@/shared/booking/claimedConfirmationSms", () => ({
  sendClaimedBookingConfirmationSms: mocks.send,
  classifyDurableConfirmationStatus: vi.fn(),
}));
vi.mock("@/shared/noshow/generateReminderToken", () => ({ generateReminderToken: mocks.token }));
vi.mock("@/shared/booking/bookingSequenceReceiptServer", () => ({ loadBookingSequenceReceipt: vi.fn() }));
vi.mock("@/shared/observability/errorReporter", () => ({ captureException: vi.fn() }));

import { POST } from "./route";

const BOOKING = "10000000-0000-4000-8000-000000000001";
const SALON = "10000000-0000-4000-8000-000000000002";
const PROFILE = "10000000-0000-4000-8000-000000000003";
const SESSION = "10000000-0000-4000-8000-000000000004";
const OTHER = "10000000-0000-4000-8000-000000000099";
const PHONE = "16045550191";
const NOW = new Date("2026-09-12T20:00:00Z");
type Row = Record<string, unknown>;
type Query = { table: string; operation: string; filters: [string, unknown][]; value?: Row };

function harness(options: {
  booking?: Row; session?: Row | null; profile?: Row | null;
  sessionError?: boolean; sessionThrows?: boolean; profileError?: boolean;
  outbound?: boolean; preference?: string;
} = {}) {
  const booking: Row = {
    id: BOOKING, salon_id: SALON, group_id: null, group_size: null,
    status: "confirmed", schedule_model: "single", client_phone: PHONE,
    client_name: "Synthetic Booking Contact", service_id: OTHER, staff_id: OTHER,
    start_time_utc: "2026-09-20T18:00:00Z", client_profile_id: PROFILE, otp_session_id: SESSION,
    ...options.booking,
  };
  const session: Row | null = options.session === null ? null : {
    id: SESSION, salon_id: SALON, phone: PHONE, verified_channel: "sms",
    verified_at: "2026-09-12T18:00:00Z", consumed_at: "2026-09-12T18:01:00Z",
    expires_at: "2026-09-12T18:10:00Z", consumed_by_booking_id: BOOKING,
    ...options.session,
  };
  const profile = options.profile === null ? null : {
    id: PROFILE, phone: PHONE, deleted_at: null, ...options.profile,
  };
  const queries: Query[] = [];
  const db = {
    from(table: string) {
      const query: Query = { table, operation: "select", filters: [] };
      queries.push(query);
      const result = () => {
        if (table === "phone_otp_sessions" && options.sessionThrows) throw new Error("synthetic read unavailable");
        const rows: Record<string, unknown> = {
          bookings: booking,
          phone_otp_sessions: session,
          client_profiles: profile,
          customer_preferences: { preferred_language: options.preference ?? "vi" },
          services: { name: "Synthetic Service" }, staff: { name: "Synthetic Staff" },
          salons: {
            id: SALON, name: "Synthetic Salon", slug: "synthetic-salon", timezone: "UTC",
            default_notification_locale: "en", sms_outbound_enabled: options.outbound === true,
            sms_a2p_registered: false,
          },
        };
        const error = (table === "phone_otp_sessions" && options.sessionError)
          || (table === "client_profiles" && options.profileError);
        return { data: rows[table] ?? null, error: error ? { message: "synthetic read failure" } : null };
      };
      // Filters are recorded but deliberately not enforced: malformed adapter
      // rows must not bypass the route's explicit identity/tenant checks.
      const chain = {
        select: () => chain,
        eq: (key: string, value: unknown) => { query.filters.push([key, value]); return chain; },
        is: (key: string, value: unknown) => { query.filters.push([key, value]); return chain; },
        update: (value: Row) => { query.operation = "update"; query.value = value; return chain; },
        upsert: (value: Row) => { query.operation = "upsert"; query.value = value; return chain; },
        maybeSingle: async () => result(),
        then: (resolve: (value: ReturnType<typeof result>) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return chain;
    },
  };
  mocks.db.mockReturnValue(db);
  return { booking, queries };
}

async function confirm(body: Row = { language: "vi" }) {
  return POST(new Request("http://localhost/api/booking/sms-confirm", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookingId: BOOKING, salonId: SALON, ...body }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden in identity regression"); }));
  mocks.rate.mockResolvedValue("allowed");
  mocks.token.mockResolvedValue(null);
  mocks.send.mockResolvedValue({ outcome: "suppressed", reason: "outbound_disabled", claimId: null, messageSid: null, claimFinalized: true });
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("confirmation preference requires booking-bound SMS authority", () => {
  it("email contact with no profile link cannot overwrite a phone-matched customer's preferences", async () => {
    const h = harness({ booking: { client_profile_id: null }, session: { verified_channel: "email" } });
    const response = await confirm({ language: "vi", smsConsent: true });
    expect(response.status).toBe(200);
    expect(h.queries.filter((q) => ["client_profiles", "customer_preferences"].includes(q.table))).toEqual([]);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ bookingId: BOOKING, lang: "vi", suppressionReason: "outbound_disabled" }));
    expect(h.queries.some((q) => q.table === "bookings" && q.operation === "update" && q.value?.sms_consent_at)).toBe(true);
  });

  it.each(["email", "legacy_unverified", "staff_attested", "demo", "claimed_sms", null, undefined])("%s proof cannot read or write global preferences even with a linked FK", async (verified_channel) => {
    const h = harness({ session: { verified_channel } });
    expect((await confirm({})).status).toBe(200);
    expect(h.queries.filter((q) => ["client_profiles", "customer_preferences"].includes(q.table))).toEqual([]);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ lang: "en" }));
  });

  it.each([
    ["missing session", { otp_session_id: null }],
    ["invalid session", { otp_session_id: "not-a-session" }],
    ["missing profile", { client_profile_id: null }],
    ["invalid profile", { client_profile_id: "not-a-profile" }],
  ])("%s retains booking language without looking up a profile by phone", async (_label, booking) => {
    const h = harness({ booking });
    expect((await confirm()).status).toBe(200);
    expect(h.queries.filter((q) => ["phone_otp_sessions", "client_profiles", "customer_preferences"].includes(q.table))).toEqual([]);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ lang: "vi" }));
  });

  it.each([
    ["wrong session", { id: OTHER }], ["wrong salon", { salon_id: OTHER }],
    ["wrong phone", { phone: "16045550192" }], ["wrong booking", { consumed_by_booking_id: OTHER }],
    ["unbound session", { consumed_by_booking_id: null }], ["unconsumed session", { consumed_at: null }],
    ["before verification", { consumed_at: "2026-09-12T17:59:59Z" }],
    ["at expiry", { consumed_at: "2026-09-12T18:10:00Z" }],
    ["future consumption", { consumed_at: "2026-09-12T20:00:01Z", expires_at: "2026-09-12T20:10:00Z" }],
    ["bad verification", { verified_at: "infinity" }], ["bad expiry", { expires_at: "not-a-date" }],
    ["numeric timestamp", { consumed_at: 1 }],
  ])("%s denies profile access while preserving confirmation", async (_label, session) => {
    const h = harness({ session });
    expect((await confirm()).status).toBe(200);
    expect(h.queries.filter((q) => ["client_profiles", "customer_preferences"].includes(q.table))).toEqual([]);
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { session: null }, { sessionError: true }, { sessionThrows: true },
  ])("failed proof read does not fail the appointment confirmation: %j", async (options) => {
    const h = harness(options);
    expect((await confirm()).status).toBe(200);
    expect(h.queries.filter((q) => ["client_profiles", "customer_preferences"].includes(q.table))).toEqual([]);
  });

  it.each([
    { profile: null }, { profileError: true }, { profile: { id: OTHER } },
    { profile: { phone: "16045550192" } }, { profile: { deleted_at: "2026-09-01T00:00:00Z" } },
  ])("rejects a missing or mismatched linked profile: %j", async (options) => {
    const h = harness(options);
    expect((await confirm()).status).toBe(200);
    expect(h.queries.filter((q) => q.table === "customer_preferences")).toEqual([]);
  });

  it("valid consumed SMS proof can persist language after its original OTP TTL expired", async () => {
    const h = harness({ session: { phone: "+1 (604) 555-0191" }, profile: { phone: "+1 604-555-0191" } });
    expect((await confirm()).status).toBe(200);
    expect(h.queries.find((q) => q.table === "client_profiles")?.filters).toContainEqual(["id", PROFILE]);
    expect(h.queries.find((q) => q.table === "client_profiles")?.filters).not.toContainEqual(["phone", PHONE]);
    expect(h.queries.filter((q) => q.table === "customer_preferences")).toEqual([
      expect.objectContaining({ operation: "upsert", value: { client_profile_id: PROFILE, salon_id: SALON, preferred_language: "vi" } }),
    ]);
  });

  it("valid SMS proof can read this salon's stored language when request language is absent", async () => {
    const h = harness();
    expect((await confirm({})).status).toBe(200);
    expect(h.queries.find((q) => q.table === "customer_preferences")?.filters).toEqual([["client_profile_id", PROFILE], ["salon_id", SALON]]);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ lang: "vi" }));
  });

  it("salon mismatch and rate limits still stop all preference and dispatch work", async () => {
    const h = harness();
    expect((await confirm({ salonId: OTHER })).status).toBe(403);
    expect(h.queries.filter((q) => q.table === "customer_preferences")).toEqual([]);
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.rate.mockResolvedValue("limited");
    expect((await confirm()).status).toBe(429);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
