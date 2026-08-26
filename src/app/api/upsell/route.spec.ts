import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  service: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/security/publicServerActionRateLimit", () => ({
  consumePublicRequestRateLimit: mocks.rate,
}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.service,
}));

import { GET } from "./route";

const SALON = "11111111-1111-4111-8111-111111111111";
const SERVICE = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-33333333333a";
const OTP = "44444444-4444-4444-8444-444444444444";
const ADDON = "55555555-5555-4555-8555-555555555555";
const CLAIM = "66666666-6666-4666-8666-666666666666";
const LOG = "77777777-7777-4777-8777-777777777777";

const OFFER = {
  available: true,
  service_id: ADDON,
  service_name: "Hot Oil Treatment",
  price_cents: 1_200,
  price_type: "fixed",
  price_max_cents: null,
  added_duration_minutes: 25,
  reason: "You usually add this (100% of your visits)",
  confidence: 1,
  session_id: SESSION,
} as const;

function claimResult(outcome: "claimed" | "replayed") {
  return {
    data: [{
      outcome,
      claim_id: CLAIM,
      upsell_log_id: LOG,
      replay: outcome === "replayed",
      offer_payload: OFFER,
    }],
    error: null,
  };
}

function installEligibleCustomerTables() {
  const serviceEq = vi.fn();
  const serviceChain = {
    eq: serviceEq,
    is: vi.fn(),
    single: vi.fn().mockResolvedValue({
      data: {
        id: ADDON,
        name: OFFER.service_name,
        price_cents: OFFER.price_cents,
        price_type: OFFER.price_type,
        price_max_cents: OFFER.price_max_cents,
        duration_minutes: 20,
        buffer_minutes: 5,
        is_addon: true,
        addon_timing: "sequential",
      },
    }),
  };
  serviceEq.mockReturnValue(serviceChain);
  serviceChain.is.mockReturnValue(serviceChain);

  const bookingChain = {
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn().mockResolvedValue({
      data: Array.from({ length: 5 }, () => ({
        service_id: SERVICE,
        addon_service_id: ADDON,
        client_locale: "en",
      })),
    }),
  };
  bookingChain.eq.mockReturnValue(bookingChain);
  bookingChain.order.mockReturnValue(bookingChain);

  const salonChain = {
    eq: vi.fn(),
    single: vi.fn().mockResolvedValue({
      data: { subscription_plan: "pro", plan_override: null, feature_flags: null },
    }),
  };
  salonChain.eq.mockReturnValue(salonChain);

  mocks.from.mockImplementation((table: string) => {
    if (table === "salons") return { select: vi.fn(() => salonChain) };
    if (table === "bookings") return { select: vi.fn(() => bookingChain) };
    if (table === "services") return { select: vi.fn(() => serviceChain) };
    throw new Error(`unexpected table ${table}`);
  });
  return { serviceEq };
}

function request(overrides: Record<string, string> = {}) {
  const query = new URLSearchParams({
    salon_id: SALON,
    phone: "+16045550199",
    selected_service_id: SERVICE,
    session_id: SESSION,
    otp_session_id: OTP,
    ...overrides,
  });
  return new Request(`https://nailiq.test/api/upsell?${query}`);
}

describe("GET /api/upsell customer-history capability boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rate.mockResolvedValue("allowed");
    mocks.service.mockReturnValue({ rpc: mocks.rpc, from: mocks.from });
  });

  it.each([
    ["limited", 429],
    ["unavailable", 503],
  ] as const)("blocks an IP rate result of %s before service-role construction", async (rate, status) => {
    mocks.rate.mockResolvedValueOnce(rate);

    const result = await GET(request());

    expect(result.status).toBe(status);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it("rejects a missing OTP capability before service-role construction", async () => {
    const result = await GET(request({ otp_session_id: "" }));

    expect(result.status).toBe(400);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it("requires a caller-stable session before service-role construction", async () => {
    const result = await GET(request({ session_id: "" }));

    expect(result.status).toBe(400);
    expect(mocks.service).not.toHaveBeenCalled();
  });

  it("rejects an invalid exact OTP capability before any customer-history table read", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    const result = await GET(request());

    expect(result.status).toBe(401);
    expect(mocks.rpc).toHaveBeenCalledWith("validate_phone_otp_session", {
      p_session_id: OTP,
      p_salon_id: SALON,
      p_phone: "16045550199",
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("fails closed when capability validation is unavailable", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "down" } });

    const result = await GET(request());

    expect(result.status).toBe(503);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(result.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns one active real add-on with authoritative price and added duration after capability validation", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "validate_phone_otp_session") return { data: true, error: null };
      if (name === "claim_ai_upsell_offer") return claimResult("claimed");
      throw new Error(`unexpected RPC ${name}`);
    });
    const { serviceEq } = installEligibleCustomerTables();

    const result = await GET(request());

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(OFFER);
    expect(serviceEq).toHaveBeenCalledWith("is_addon", true);
    expect(mocks.rpc).toHaveBeenCalledWith("claim_ai_upsell_offer", {
      p_salon_id: SALON,
      p_session_id: SESSION,
      p_otp_session_id: OTP,
      p_client_phone: "16045550199",
      p_selected_service_id: SERVICE,
      p_suggested_service_id: ADDON,
      p_suggestion_reason: OFFER.reason,
      p_confidence_score: 1,
    });
    expect(mocks.from).not.toHaveBeenCalledWith("ai_upsell_log");
  });

  it("canonicalizes UUID case before acquiring and validating a durable claim", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "validate_phone_otp_session") return { data: true, error: null };
      if (name === "claim_ai_upsell_offer") return claimResult("claimed");
      throw new Error(`unexpected RPC ${name}`);
    });
    installEligibleCustomerTables();

    const result = await GET(request({ session_id: SESSION.toUpperCase() }));

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(OFFER);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_ai_upsell_offer",
      expect.objectContaining({ p_session_id: SESSION }),
    );
  });

  it("returns the same durable offer for two concurrent exact-session claims", async () => {
    let claimCalls = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "validate_phone_otp_session") return { data: true, error: null };
      if (name === "claim_ai_upsell_offer") {
        claimCalls += 1;
        return claimResult(claimCalls === 1 ? "claimed" : "replayed");
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    installEligibleCustomerTables();

    const [first, second] = await Promise.all([GET(request()), GET(request())]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(OFFER);
    expect(await second.json()).toEqual(OFFER);
    expect(claimCalls).toBe(2);
    expect(mocks.from).not.toHaveBeenCalledWith("ai_upsell_log");
  });

  it.each(["capability_mismatch", "offer_material_mismatch"])(
    "fails closed without surfacing an offer on %s",
    async (outcome) => {
      mocks.rpc.mockImplementation(async (name: string) => {
        if (name === "validate_phone_otp_session") return { data: true, error: null };
        if (name === "claim_ai_upsell_offer") {
          return {
            data: [{ outcome, claim_id: null, upsell_log_id: null, replay: false, offer_payload: null }],
            error: null,
          };
        }
        throw new Error(`unexpected RPC ${name}`);
      });
      installEligibleCustomerTables();

      const result = await GET(request());

      expect(result.status).toBe(409);
      expect(await result.json()).toEqual({ available: false, error: "offer_conflict" });
    },
  );

  it("fails closed when an apparent claim has malformed authoritative material", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "validate_phone_otp_session") return { data: true, error: null };
      if (name === "claim_ai_upsell_offer") {
        return {
          ...claimResult("claimed"),
          data: [{ ...claimResult("claimed").data[0], offer_payload: { ...OFFER, session_id: OTP } }],
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    });
    installEligibleCustomerTables();

    const result = await GET(request());

    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ available: false, error: "temporarily_unavailable" });
  });
});
