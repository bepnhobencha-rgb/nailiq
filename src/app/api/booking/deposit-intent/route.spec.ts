import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
  createIntent: vi.fn(),
  retrieveIntent: vi.fn(),
  chargeCardToken: vi.fn(),
  getSquareConfig: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/shared/lib/stripe", () => ({
  getStripeClient: () => ({
    paymentIntents: {
      create: mocks.createIntent,
      retrieve: mocks.retrieveIntent,
    },
  }),
}));
vi.mock("@/shared/integrations/square/client", () => ({
  chargeCardToken: mocks.chargeCardToken,
  getSquareConfig: mocks.getSquareConfig,
}));

import { POST } from "./route";

const SALON_ID = "123e4567-e89b-42d3-a456-426614174000";
const SERVICE_ID = "223e4567-e89b-42d3-a456-426614174000";
const STAFF_ID = "323e4567-e89b-42d3-a456-426614174000";
const BOOKING_REQUEST_ID = "423e4567-e89b-42d3-a456-426614174000";
const PAYMENT_REQUEST_ID = "523e4567-e89b-42d3-a456-426614174000";
const OTP_SESSION_ID = "623e4567-e89b-42d3-a456-426614174000";
const OPERATION_ID = "723e4567-e89b-42d3-a456-426614174000";
const FP = "a".repeat(64);
const ACCOUNT_FP = "fd8fff6944dcc38d42d1561888d7001df7cd1834449ffee4ec7c96aeba5fb177";
const PHONE_FP = "d".repeat(64);
const ATTEMPT_ID = "823e4567-e89b-42d3-a456-426614174000";
const QA_SQUARE_SALON_ID = "019c0000-0000-7000-8000-000000000196";
const QA_SQUARE_BOOKING_REQUEST_ID = "019c0000-0000-7000-8000-000000000199";
const QA_SQUARE_PAYMENT_REQUEST_ID = "019c0000-0000-7000-8000-00000000019a";
const QA_RESPONSE_LOSS_SECRET = "qa-square-response-loss-secret-00000001";
const QA_SQUARE_MERCHANT_ID = "MLQADEPOSIT196";
const QA_SQUARE_LOCATION_ID = "LQADEPOSIT196";
const QA_SQUARE_APPLICATION_ID = "sandbox-sq0idb-qaresponse";
const QA_SQUARE_ACCESS_TOKEN = "EAAAqaSquareSandboxToken00000001";
const SQUARE_ACCOUNT_FP = createHash("sha256")
  .update("square:merchant_qa:location_qa:sandbox", "utf8")
  .digest("hex");
const QA_SQUARE_ACCOUNT_FP = createHash("sha256")
  .update(`square:${QA_SQUARE_MERCHANT_ID}:${QA_SQUARE_LOCATION_ID}:sandbox`, "utf8")
  .digest("hex");

function publicMaterial() {
  return {
    salon_id: SALON_ID,
    service_id: SERVICE_ID,
    staff_id: STAFF_ID,
    start_time_utc: "2026-08-28T18:00:00.000Z",
    end_time_utc: "2026-08-28T19:00:00.000Z",
    booking_idempotency_key: BOOKING_REQUEST_ID,
    pricing_fingerprint: FP,
    client_phone_fingerprint: PHONE_FP,
    operation_kind: "deposit_charge",
    provider: "stripe",
    provider_account_fingerprint: ACCOUNT_FP,
    amount_cents: 2_000,
    currency: "CAD",
    deposit_reason: "new_customer",
    provider_material: {
      provider: "stripe",
      provider_account_id: "acct_qa",
      provider_location_id: null,
      provider_application_id: null,
      provider_environment: null,
      currency: "CAD",
      amount_cents: 2_000,
      booking_intent_reference: BOOKING_REQUEST_ID,
      pricing_fingerprint: FP,
    },
  };
}

function squareMaterial() {
  return {
    ...publicMaterial(),
    provider: "square",
    provider_account_fingerprint: SQUARE_ACCOUNT_FP,
    provider_material: {
      provider: "square",
      provider_account_id: "merchant_qa",
      provider_location_id: "location_qa",
      provider_application_id: "sandbox-app-qa",
      provider_environment: "sandbox",
      currency: "CAD",
      amount_cents: 2_000,
      booking_intent_reference: BOOKING_REQUEST_ID,
      pricing_fingerprint: FP,
    },
  };
}

function qaSquareMaterial() {
  return {
    ...squareMaterial(),
    salon_id: QA_SQUARE_SALON_ID,
    booking_idempotency_key: QA_SQUARE_BOOKING_REQUEST_ID,
    amount_cents: 100,
    provider_account_fingerprint: QA_SQUARE_ACCOUNT_FP,
    provider_material: {
      ...squareMaterial().provider_material,
      provider_account_id: QA_SQUARE_MERCHANT_ID,
      provider_location_id: QA_SQUARE_LOCATION_ID,
      provider_application_id: QA_SQUARE_APPLICATION_ID,
      amount_cents: 100,
      booking_intent_reference: QA_SQUARE_BOOKING_REQUEST_ID,
    },
  };
}

function query(result: { data: unknown; error?: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "not", "limit", "in", "gte", "lt"]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.maybeSingle = vi.fn(async () => result);
  return chain;
}

function body(extra: Record<string, unknown> = {}) {
  return {
    salonId: SALON_ID,
    serviceId: SERVICE_ID,
    staffId: STAFF_ID,
    startTimeUtc: "2026-08-28T18:00:00.000Z",
    endTimeUtc: "2026-08-28T19:00:00.000Z",
    clientPhone: "+16045550199",
    clientEmail: "qa@example.test",
    bookingRequestId: BOOKING_REQUEST_ID,
    paymentRequestId: PAYMENT_REQUEST_ID,
    otpSessionId: OTP_SESSION_ID,
    expectedPricingFingerprint: FP,
    ...extra,
  };
}

function replayOnlyBody(extra: Record<string, unknown> = {}) {
  return {
    replayOnly: true,
    operationId: OPERATION_ID,
    paymentRequestId: PAYMENT_REQUEST_ID,
    squareCapabilityToken: "capability-token-bound-to-the-operation",
    ...extra,
  };
}

function request(
  payload: Record<string, unknown> = body(),
  headers: Record<string, string> = {},
  url = "https://nailiq.test/api/booking/deposit-intent",
) {
  const raw = JSON.stringify(payload);
  return new Request(url, {
    method: "POST",
    headers: {
      Origin: new URL(url).origin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
      ...headers,
    },
    body: raw,
  });
}

describe("POST /api/booking/deposit-intent Sellable-V1 boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServiceRoleClient.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
    for (const key of [
      "NAILIQ_QA_SQUARE_RESPONSE_LOSS_ENABLED",
      "NAILIQ_QA_SQUARE_RESPONSE_LOSS_SECRET",
      "NAILIQ_QA_LOCAL_SUPABASE",
      "NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF",
      "E2E_EXPECTED_PROJECT_REF",
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_INTERNAL_URL",
      "SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT",
      "PAYMENT_LEDGER_WORKERS_ENABLED",
      "DISABLE_OUTBOUND_SMS",
      "DISABLE_OUTBOUND_CALLS",
      "DISABLE_OUTBOUND_EMAIL",
      "VERCEL_ENV",
    ]) delete process.env[key];
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_local_only";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "local-test-service-secret";
    mocks.from.mockImplementation((table: string) => {
      if (table === "salons") return query({
        data: {
          id: SALON_ID,
          currency_code: "CAD",
          deposit_pct_new_customer: 20,
          phone_otp_enabled: true,
          stripe_connect_account_id: "acct_qa",
          stripe_connect_charges_enabled: true,
        },
      });
      if (table === "services") return query({ data: { price_cents: 10_000 } });
      return query({ data: [] });
    });
    mocks.rpc.mockImplementation(async (name: string) => name === "rate_limit_hit"
      ? { data: null, error: { message: "rate limiter unavailable" } }
      : { data: [{ is_vip: false }], error: null });
    mocks.createIntent.mockResolvedValue({ id: "pi_test_receipt", client_secret: "secret" });
    mocks.retrieveIntent.mockResolvedValue({
      id: "pi_test_receipt",
      client_secret: "secret",
      status: "requires_action",
    });
    mocks.getSquareConfig.mockResolvedValue({
      salonId: SALON_ID,
      merchantId: "merchant_qa",
      locationId: "location_qa",
      applicationId: "sandbox-sq0idb-testapp",
      currency: "CAD",
      environment: "sandbox",
    });
    mocks.chargeCardToken.mockResolvedValue({ paymentId: "square-payment-1", status: "COMPLETED" });
  });

  it("rejects cross-origin intent creation before DB or provider access", async () => {
    const response = await POST(request(body(), {
      Origin: "https://scanner.example",
      "Sec-Fetch-Site": "cross-site",
    }));

    expect(response.status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it("replays only an exact already-succeeded Square operation before every meter and provider path", async () => {
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name !== "claim_public_square_deposit_completion") {
        return { data: null, error: { message: `unexpected ${name}` } };
      }
      expect(args).toEqual({
        p_operation_id: OPERATION_ID,
        p_request_id: PAYMENT_REQUEST_ID,
        p_capability_token: "capability-token-bound-to-the-operation",
      });
      return {
        data: {
          success: true,
          code: "operation_replay",
          status: "succeeded",
          operation_id: OPERATION_ID,
          material_fingerprint: FP,
        },
        error: null,
      };
    });

    const response = await POST(request(replayOnlyBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      required: true,
      paymentCompleted: true,
      operationId: OPERATION_ID,
      paymentRequestId: PAYMENT_REQUEST_ID,
      materialFingerprint: FP,
    });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalledWith("rate_limit_hit", expect.anything());
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.getSquareConfig).not.toHaveBeenCalled();
    expect(mocks.chargeCardToken).not.toHaveBeenCalled();
    expect(mocks.createIntent).not.toHaveBeenCalled();
    expect(mocks.retrieveIntent).not.toHaveBeenCalled();
  });

  it.each([
    ["reconciliation", {
      success: false,
      code: "reconciliation_required",
      status: "unknown",
      operation_id: OPERATION_ID,
      material_fingerprint: FP,
    }, 503],
    ["new Square claim", {
      success: true,
      code: "square_payment_claimed",
      status: "sending",
      operation_id: OPERATION_ID,
      material_fingerprint: FP,
    }, 409],
    ["wrong terminal operation", {
      success: true,
      code: "operation_replay",
      status: "succeeded",
      operation_id: "823e4567-e89b-42d3-a456-426614174000",
      material_fingerprint: FP,
    }, 409],
  ] as const)("fails replay-only %s before meters, config or provider dispatch", async (_name, row, status) => {
    mocks.rpc.mockResolvedValue({ data: row, error: null });

    const response = await POST(request(replayOnlyBody()));

    expect(response.status).toBe(status);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).not.toHaveBeenCalledWith("rate_limit_hit", expect.anything());
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.getSquareConfig).not.toHaveBeenCalled();
    expect(mocks.chargeCardToken).not.toHaveBeenCalled();
    expect(mocks.createIntent).not.toHaveBeenCalled();
    expect(mocks.retrieveIntent).not.toHaveBeenCalled();
  });

  it.each([
    ["source token", { squareSourceToken: "cnon:card-nonce-ok" }, {}],
    ["card nonce", { cardNonce: "cnon:card-nonce-ok" }, {}],
    ["unknown field", { salonId: SALON_ID }, {}],
    ["false flag", { replayOnly: false }, {}],
    ["QA fault header", {}, { "x-nailiq-qa-square-response-loss": QA_RESPONSE_LOSS_SECRET }],
  ] as const)("rejects replay-only with %s before creating a DB or provider client", async (_name, extra, headers) => {
    const response = await POST(request(replayOnlyBody(extra), headers));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.getSquareConfig).not.toHaveBeenCalled();
    expect(mocks.chargeCardToken).not.toHaveBeenCalled();
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it("caps actual streamed bytes when Content-Length is absent or spoofed small", async () => {
    for (const contentLength of [undefined, "100"]) {
      vi.clearAllMocks();
      const headers: Record<string, string> = contentLength
        ? { "Content-Length": contentLength }
        : {};
      const response = await POST(request(body({ padding: "x".repeat(20_000) }), headers));
      expect([400, 413]).toContain(response.status);
      expect(mocks.from).not.toHaveBeenCalled();
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect(mocks.createIntent).not.toHaveBeenCalled();
    }
  });

  it("fails closed before provider dispatch when the durable limiter is unavailable", async () => {
    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(mocks.rpc).toHaveBeenCalledWith("rate_limit_hit", expect.objectContaining({
      p_limit: expect.any(Number),
      p_window_seconds: expect.any(Number),
    }));
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it.each([
    [1, "error"],
    [1, "throw"],
    [2, "null"],
    [3, "throw"],
    [4, "error"],
    [5, "null"],
    [6, "throw"],
  ] as const)("fails closed when durable meter %i returns %s", async (blockedMeter, mode) => {
    let meter = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "validate_phone_otp_session") return { data: true, error: null };
      if (name === "load_public_deposit_payment_material") return {
        data: {
          success: true,
          code: "material_loaded",
          material_fingerprint: "e".repeat(64),
          material: publicMaterial(),
        },
        error: null,
      };
      if (name !== "rate_limit_hit") return { data: [{ is_vip: false }], error: null };
      meter += 1;
      if (meter !== blockedMeter) return { data: true, error: null };
      if (mode === "throw") throw new Error("rate limiter unavailable");
      if (mode === "null") return { data: null, error: null };
      return { data: null, error: { message: "rate limiter unavailable" } };
    });

    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it("uses exact durable burst and long-window meters in authorization order", async () => {
    const rateArgs: Array<Record<string, unknown>> = [];
    const rpcNames: string[] = [];
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      rpcNames.push(name);
      if (name === "rate_limit_hit") {
        rateArgs.push(args);
        return { data: true, error: null };
      }
      if (name === "validate_phone_otp_session") return { data: true, error: null };
      if (name === "load_public_deposit_payment_material") return {
        data: {
          success: true,
          code: "material_loaded",
          material_fingerprint: "e".repeat(64),
          material: publicMaterial(),
        },
        error: null,
      };
      if (name === "claim_public_deposit_payment_operation") return {
        data: { success: false, code: "intent_in_flight" },
        error: null,
      };
      return { data: null, error: { message: "unexpected rpc" } };
    });

    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(rateArgs.map(({ p_limit, p_window_seconds }) => [p_limit, p_window_seconds]))
      .toEqual([
        [12, 300],
        [60, 3_600],
        [30, 600],
        [120, 86_400],
        [10, 3_600],
        [6, 3_600],
      ]);
    expect(String(rateArgs[0]?.p_key)).toMatch(/^public-deposit-intent:ip:[0-9a-f]{64}$/);
    expect(String(rateArgs[2]?.p_key)).toMatch(/^public-deposit-intent:salon:[0-9a-f]{64}$/);
    expect(String(rateArgs[4]?.p_key)).toMatch(/^public-deposit-intent:phone:[0-9a-f]{64}$/);
    expect(String(rateArgs[5]?.p_key)).toMatch(/^public-deposit-intent:intent:[0-9a-f]{64}$/);
    expect(rpcNames.indexOf("validate_phone_otp_session"))
      .toBeLessThan(rpcNames.indexOf("load_public_deposit_payment_material"));
    expect(rpcNames.indexOf("load_public_deposit_payment_material"))
      .toBeLessThan(rpcNames.indexOf("claim_public_deposit_payment_operation"));
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", { otpSessionId: undefined }],
    ["wrong", { otpSessionId: "723e4567-e89b-42d3-a456-426614174000" }],
    ["consumed", { otpSessionId: OTP_SESSION_ID }],
    ["cross-salon", { otpSessionId: OTP_SESSION_ID }],
  ] as const)("rejects a %s OTP session before canonical material or provider", async (_case, extra) => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "validate_phone_otp_session") return { data: false, error: null };
      return { data: [{ is_vip: false }], error: null };
    });

    const response = await POST(request(body(extra)));
    expect([401, 403, 404, 409]).toContain(response.status);
    expect(mocks.createIntent).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toMatch(/consumed|expired|cross.?salon|phone_otp_sessions/i);
  });

  it("lets an exact unconsumed same-salon OTP session reach canonical material without consuming it", async () => {
    const rpcNames: string[] = [];
    mocks.rpc.mockImplementation(async (name: string) => {
      rpcNames.push(name);
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "validate_phone_otp_session") return { data: true, error: null };
      if (name === "load_public_deposit_payment_material") {
        return { data: { success: false, code: "deposit_not_required" }, error: null };
      }
      if (name === "claim_public_deposit_payment_operation") {
        return { data: { success: false, code: "deposit_not_required" }, error: null };
      }
      return { data: [{ is_vip: false }], error: null };
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ required: false });
    expect(rpcNames).toContain("validate_phone_otp_session");
    expect(rpcNames).toContain("load_public_deposit_payment_material");
    expect(rpcNames.indexOf("validate_phone_otp_session"))
      .toBeLessThan(rpcNames.indexOf("load_public_deposit_payment_material"));
    expect(mocks.createIntent).not.toHaveBeenCalled();
  });

  it("does not mint or retrieve a pending-customer capability for a rotated payment request", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "validate_phone_otp_session") return { data: true, error: null };
      if (name === "load_public_deposit_payment_material") return {
        data: {
          success: true,
          code: "material_loaded",
          material_fingerprint: "e".repeat(64),
          material: publicMaterial(),
        },
        error: null,
      };
      if (name === "claim_public_deposit_payment_operation") return {
        data: {
          success: true,
          code: "intent_replay",
          status: "pending_customer",
          operation_id: OPERATION_ID,
          provider_payment_id: "pi_test_receipt",
          material_fingerprint: "e".repeat(64),
          material: publicMaterial(),
        },
        error: null,
      };
      return { data: null, error: { message: "unexpected rpc" } };
    });

    const response = await POST(request(body({
      paymentRequestId: "823e4567-e89b-42d3-a456-426614174000",
    })));
    expect([409, 503]).toContain(response.status);
    expect(mocks.retrieveIntent).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toMatch(/finalizeToken|clientSecret/i);
  });

  it("accepts a succeeded-unbound Stripe completion after customer confirmation", async () => {
    mocks.retrieveIntent.mockResolvedValue({
      id: "pi_test_receipt",
      client_secret: "secret",
      status: "succeeded",
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "validate_phone_otp_session") return { data: true, error: null };
      if (name === "load_public_deposit_payment_material") return {
        data: {
          success: true,
          code: "material_loaded",
          material_fingerprint: FP,
          material: publicMaterial(),
        },
        error: null,
      };
      if (name === "claim_public_deposit_payment_operation") return {
        data: {
          success: true,
          code: "customer_confirmation_pending",
          status: "pending_customer",
          operation_id: OPERATION_ID,
          provider_payment_id: "pi_test_receipt",
          material_fingerprint: FP,
          material: publicMaterial(),
        },
        error: null,
      };
      if (name === "resume_public_deposit_customer_confirmation") return {
        data: {
          success: true,
          code: "provider_reconciliation_claimed",
          status: "reconciling",
          operation_id: OPERATION_ID,
          attempt_token: ATTEMPT_ID,
          material_fingerprint: FP,
          material: publicMaterial(),
        },
        error: null,
      };
      if (name === "complete_booking_payment_operation") return {
        data: {
          success: true,
          code: "succeeded_unbound",
          status: "succeeded",
          operation_id: OPERATION_ID,
          material_fingerprint: FP,
        },
        error: null,
      };
      return { data: null, error: { message: `unexpected ${name}` } };
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      required: true,
      paymentCompleted: true,
      operationId: OPERATION_ID,
      paymentRequestId: PAYMENT_REQUEST_ID,
      materialFingerprint: FP,
    });
    expect(mocks.retrieveIntent).toHaveBeenCalledTimes(1);
    expect(mocks.retrieveIntent).toHaveBeenCalledWith(
      "pi_test_receipt",
      {},
      { stripeAccount: "acct_qa" },
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_operation_id: OPERATION_ID,
        p_attempt_token: ATTEMPT_ID,
        p_outcome: "succeeded",
        p_provider_status: "succeeded",
        p_provider_payment_id: "pi_test_receipt",
      }),
    );
    expect(mocks.createIntent).not.toHaveBeenCalled();
    expect(mocks.chargeCardToken).not.toHaveBeenCalled();
  });

  it("issues a browser-safe Square capability, then charges once with the persisted provider key", async () => {
    let completed = false;
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "validate_phone_otp_session") return { data: true, error: null };
      if (name === "load_public_deposit_payment_material") return {
        data: {
          success: true,
          code: "material_loaded",
          material_fingerprint: FP,
          material: squareMaterial(),
        },
        error: null,
      };
      if (name === "claim_public_deposit_payment_operation") return {
        data: {
          success: true,
          code: "claimed",
          status: "sending",
          operation_id: OPERATION_ID,
          attempt_token: ATTEMPT_ID,
          provider_idempotency_key: `nq:${OPERATION_ID}`,
          lease_expires_at: "2026-08-20T22:00:00.000Z",
          attempt_count: 1,
          material_fingerprint: FP,
          material: squareMaterial(),
        },
        error: null,
      };
      if (name === "issue_public_square_deposit_capability") return {
        data: {
          success: true,
          code: "capability_issued",
          operation_id: OPERATION_ID,
          capability_token: args.p_capability_token,
          capability_expires_at: "2026-08-20T22:00:00.000Z",
          square_application_id: "sandbox-app-qa",
          square_location_id: "location_qa",
          square_environment: "sandbox",
          amount_cents: 2_000,
          currency: "CAD",
          material_fingerprint: FP,
        },
        error: null,
      };
      if (name === "claim_public_square_deposit_completion") {
        return completed
          ? {
              data: {
                success: true,
                code: "operation_replay",
                status: "succeeded",
                operation_id: OPERATION_ID,
                material_fingerprint: FP,
                result: { provider_payment_id: "square-payment-1" },
              },
              error: null,
            }
          : {
              data: {
                success: true,
                code: "square_payment_claimed",
                status: "sending",
                operation_id: OPERATION_ID,
                attempt_token: ATTEMPT_ID,
                provider_idempotency_key: `nq:${OPERATION_ID}`,
                lease_expires_at: "2026-08-20T22:00:00.000Z",
                material_fingerprint: FP,
                material: squareMaterial(),
              },
              error: null,
            };
      }
      if (name === "complete_booking_payment_operation") {
        completed = true;
        return { data: { success: true, code: "succeeded_unbound" }, error: null };
      }
      return { data: null, error: { message: `unexpected ${name}` } };
    });

    const issued = await POST(request());
    expect(issued.status).toBe(200);
    const capability = await issued.json() as Record<string, unknown>;
    expect(capability).toMatchObject({
      provider: "square",
      operationId: OPERATION_ID,
      squareApplicationId: "sandbox-app-qa",
      squareLocationId: "location_qa",
      squareEnvironment: "sandbox",
      amountCents: 2_000,
      currency: "CAD",
    });
    expect(capability).not.toHaveProperty("providerIdempotencyKey");
    expect(capability).not.toHaveProperty("attemptToken");
    expect(mocks.chargeCardToken).not.toHaveBeenCalled();

    const completionBody = {
      operationId: OPERATION_ID,
      paymentRequestId: PAYMENT_REQUEST_ID,
      squareCapabilityToken: capability.squareCapabilityToken,
      squareSourceToken: "cnon:card-nonce-from-square",
    };
    const paid = await POST(request(completionBody));
    expect(paid.status).toBe(200);
    expect(mocks.chargeCardToken).toHaveBeenCalledTimes(1);
    expect(mocks.chargeCardToken).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: "merchant_qa",
        locationId: "location_qa",
        environment: "sandbox",
        currency: "CAD",
      }),
      expect.objectContaining({ amountCents: 2_000, idempotencyKey: `nq:${OPERATION_ID}` }),
    );

    const replay = await POST(request(completionBody));
    expect(replay.status).toBe(200);
    expect(mocks.chargeCardToken).toHaveBeenCalledTimes(1);
  });

  it("persists a Square transport outage as pending and refuses an ordinary second dispatch", async () => {
    let completionClaims = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_public_square_deposit_completion") {
        completionClaims += 1;
        return completionClaims === 1
          ? {
              data: {
                success: true,
                code: "square_payment_claimed",
                status: "sending",
                operation_id: OPERATION_ID,
                attempt_token: ATTEMPT_ID,
                provider_idempotency_key: `nq:${OPERATION_ID}`,
                lease_expires_at: "2026-08-20T22:00:00.000Z",
                material_fingerprint: FP,
                material: squareMaterial(),
              },
              error: null,
            }
          : {
              data: {
                success: false,
                code: "reconciliation_required",
                status: "unknown",
                operation_id: OPERATION_ID,
                material_fingerprint: FP,
              },
              error: null,
            };
      }
      if (name === "complete_booking_payment_operation") {
        return { data: { success: false, code: "provider_outcome_unknown" }, error: null };
      }
      return { data: null, error: { message: `unexpected ${name}` } };
    });
    mocks.chargeCardToken.mockRejectedValue(new Error("response lost"));
    const completionBody = {
      operationId: OPERATION_ID,
      paymentRequestId: PAYMENT_REQUEST_ID,
      squareCapabilityToken: "capability-token-bound-to-the-operation",
      squareSourceToken: "cnon:card-nonce-from-square",
    };

    const first = await POST(request(completionBody));
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: "deposit_pending" });
    expect(mocks.chargeCardToken).toHaveBeenCalledTimes(1);
    expect(mocks.chargeCardToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: `nq:${OPERATION_ID}` }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_operation_id: OPERATION_ID,
        p_attempt_token: ATTEMPT_ID,
        p_outcome: "unknown",
        p_error_code: "provider_transport_error",
      }),
    );

    const ordinaryRetry = await POST(request(completionBody));
    expect(ordinaryRetry.status).toBe(503);
    expect(await ordinaryRetry.json()).toEqual({ error: "deposit_pending" });
    expect(mocks.chargeCardToken).toHaveBeenCalledTimes(1);
  });

  it.each(["hosted", "local"] as const)(
    "QA-only response-loss drops a successful %s sandbox receipt into durable unknown",
    async (databaseMode) => {
    process.env.NAILIQ_QA_SQUARE_RESPONSE_LOSS_ENABLED = "1";
    process.env.NAILIQ_QA_SQUARE_RESPONSE_LOSS_SECRET = QA_RESPONSE_LOSS_SECRET;
    if (databaseMode === "local") {
      process.env.NAILIQ_QA_LOCAL_SUPABASE = "1";
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
      process.env.SUPABASE_INTERNAL_URL = "http://127.0.0.1:54321";
    } else {
      process.env.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF = "abcdefghijklmnopqrst";
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
    }
    process.env.SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT = "sandbox";
    process.env.PAYMENT_LEDGER_WORKERS_ENABLED = "true";
    process.env.DISABLE_OUTBOUND_SMS = "1";
    process.env.DISABLE_OUTBOUND_CALLS = "1";
    process.env.DISABLE_OUTBOUND_EMAIL = "1";
    process.env.VERCEL_ENV = databaseMode === "local" ? "development" : "preview";
    mocks.getSquareConfig.mockResolvedValue({
      salonId: QA_SQUARE_SALON_ID,
      merchantId: QA_SQUARE_MERCHANT_ID,
      locationId: QA_SQUARE_LOCATION_ID,
      applicationId: QA_SQUARE_APPLICATION_ID,
      accessToken: QA_SQUARE_ACCESS_TOKEN,
      currency: "CAD",
      environment: "sandbox",
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_public_square_deposit_completion") return {
        data: {
          success: true,
          code: "square_payment_claimed",
          status: "sending",
          operation_id: OPERATION_ID,
          attempt_token: ATTEMPT_ID,
          provider_idempotency_key: `nq:${OPERATION_ID}`,
          lease_expires_at: "2026-08-20T22:00:00.000Z",
          material_fingerprint: FP,
          material: qaSquareMaterial(),
        },
        error: null,
      };
      if (name === "complete_booking_payment_operation") return {
        data: {
          success: false,
          code: "provider_outcome_unknown",
          status: "unknown",
          operation_id: OPERATION_ID,
        },
        error: null,
      };
      return { data: null, error: { message: `unexpected ${name}` } };
    });
    mocks.chargeCardToken.mockResolvedValue({
      paymentId: "sandbox-payment-discarded",
      status: "COMPLETED",
    });

    const response = await POST(request({
      operationId: OPERATION_ID,
      paymentRequestId: QA_SQUARE_PAYMENT_REQUEST_ID,
      squareCapabilityToken: "capability-token-bound-to-the-operation",
      squareSourceToken: "cnon:card-nonce-ok",
    }, {
      "x-nailiq-qa-square-response-loss": QA_RESPONSE_LOSS_SECRET,
    }, databaseMode === "local"
      ? "http://127.0.0.1:3000/api/booking/deposit-intent"
      : undefined));

    expect(response.status).toBe(503);
    const responseBody = await response.json();
    expect(responseBody).toEqual({ error: "deposit_pending" });
    expect(mocks.chargeCardToken).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_operation_id: OPERATION_ID,
        p_attempt_token: ATTEMPT_ID,
        p_outcome: "unknown",
        p_provider_status: null,
        p_provider_payment_id: null,
        p_error_code: "provider_transport_error",
      }),
    );
    expect(JSON.stringify(responseBody)).not.toContain("sandbox-payment-discarded");
  });

  it.each(["non-fixed material", "invalid sandbox access token"] as const)(
    "keeps the QA %s gate after capability claim and before Square",
    async (gateCase) => {
    process.env.NAILIQ_QA_SQUARE_RESPONSE_LOSS_ENABLED = "1";
    process.env.NAILIQ_QA_SQUARE_RESPONSE_LOSS_SECRET = QA_RESPONSE_LOSS_SECRET;
    process.env.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF = "abcdefghijklmnopqrst";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
    process.env.SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT = "sandbox";
    process.env.PAYMENT_LEDGER_WORKERS_ENABLED = "true";
    process.env.DISABLE_OUTBOUND_SMS = "1";
    process.env.DISABLE_OUTBOUND_CALLS = "1";
    process.env.DISABLE_OUTBOUND_EMAIL = "1";
    process.env.VERCEL_ENV = "preview";
    const fixedMaterial = gateCase === "invalid sandbox access token";
    mocks.getSquareConfig.mockResolvedValue(fixedMaterial
      ? {
          salonId: QA_SQUARE_SALON_ID,
          merchantId: QA_SQUARE_MERCHANT_ID,
          locationId: QA_SQUARE_LOCATION_ID,
          applicationId: QA_SQUARE_APPLICATION_ID,
          accessToken: "not-a-sandbox-token",
          currency: "CAD",
          environment: "sandbox",
        }
      : {
          salonId: SALON_ID,
          merchantId: "merchant_qa",
          locationId: "location_qa",
          applicationId: "sandbox-sq0idb-ordinary",
          accessToken: "EAAAordinarySandboxToken000000001",
          currency: "CAD",
          environment: "sandbox",
        });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_public_square_deposit_completion") return {
        data: {
          success: true,
          code: "square_payment_claimed",
          status: "sending",
          operation_id: OPERATION_ID,
          attempt_token: ATTEMPT_ID,
          provider_idempotency_key: `nq:${OPERATION_ID}`,
          lease_expires_at: "2026-08-20T22:00:00.000Z",
          material_fingerprint: FP,
          material: fixedMaterial ? qaSquareMaterial() : squareMaterial(),
        },
        error: null,
      };
      return { data: null, error: { message: `unexpected ${name}` } };
    });

    const response = await POST(request({
      operationId: OPERATION_ID,
      paymentRequestId: QA_SQUARE_PAYMENT_REQUEST_ID,
      squareCapabilityToken: "capability-token-bound-to-the-operation",
      squareSourceToken: "cnon:card-nonce-ok",
    }, {
      "x-nailiq-qa-square-response-loss": QA_RESPONSE_LOSS_SECRET,
    }));

    expect(response.status).toBe(403);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_public_square_deposit_completion",
      expect.anything(),
    );
    expect(mocks.chargeCardToken).not.toHaveBeenCalled();
  });

  it.each([
    ["missing enable", () => delete process.env.NAILIQ_QA_SQUARE_RESPONSE_LOSS_ENABLED],
    ["missing Vercel environment", () => delete process.env.VERCEL_ENV],
    ["production Vercel environment", () => { process.env.VERCEL_ENV = "production"; }],
    ["production Supabase", () => {
      process.env.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF = "fshmobzyjhmtvndobwsy";
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://fshmobzyjhmtvndobwsy.supabase.co";
    }],
    ["wrong secret", () => {
      process.env.NAILIQ_QA_SQUARE_RESPONSE_LOSS_SECRET = "different-response-loss-secret-000001";
    }],
    ["non-sandbox reconciliation", () => {
      process.env.SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT = "production";
    }],
    ["SMS kill switch off", () => delete process.env.DISABLE_OUTBOUND_SMS],
    ["calls kill switch off", () => delete process.env.DISABLE_OUTBOUND_CALLS],
    ["email kill switch off", () => delete process.env.DISABLE_OUTBOUND_EMAIL],
    ["payment worker disabled", () => delete process.env.PAYMENT_LEDGER_WORKERS_ENABLED],
    ["hosted Supabase ref missing", () => {
      delete process.env.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF;
    }],
    ["hosted Supabase internal URL mismatch", () => {
      process.env.SUPABASE_INTERNAL_URL = "https://zzzzzzzzzzzzzzzzzzzz.supabase.co";
    }],
    ["local Supabase on a non-loopback app URL", () => {
      delete process.env.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF;
      process.env.NAILIQ_QA_LOCAL_SUPABASE = "1";
      process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
      process.env.SUPABASE_INTERNAL_URL = "http://127.0.0.1:54321";
    }],
  ] as const)("rejects QA response-loss for %s before provider dispatch", async (_name, mutate) => {
    process.env.NAILIQ_QA_SQUARE_RESPONSE_LOSS_ENABLED = "1";
    process.env.NAILIQ_QA_SQUARE_RESPONSE_LOSS_SECRET = QA_RESPONSE_LOSS_SECRET;
    process.env.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF = "abcdefghijklmnopqrst";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://abcdefghijklmnopqrst.supabase.co";
    process.env.SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT = "sandbox";
    process.env.PAYMENT_LEDGER_WORKERS_ENABLED = "true";
    process.env.DISABLE_OUTBOUND_SMS = "1";
    process.env.DISABLE_OUTBOUND_CALLS = "1";
    process.env.DISABLE_OUTBOUND_EMAIL = "1";
    process.env.VERCEL_ENV = "preview";
    mutate();
    mocks.getSquareConfig.mockResolvedValue({
      salonId: QA_SQUARE_SALON_ID,
      merchantId: QA_SQUARE_MERCHANT_ID,
      locationId: QA_SQUARE_LOCATION_ID,
      applicationId: QA_SQUARE_APPLICATION_ID,
      accessToken: QA_SQUARE_ACCESS_TOKEN,
      currency: "CAD",
      environment: "sandbox",
    });
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_public_square_deposit_completion") return {
        data: {
          success: true,
          code: "square_payment_claimed",
          status: "sending",
          operation_id: OPERATION_ID,
          attempt_token: ATTEMPT_ID,
          provider_idempotency_key: `nq:${OPERATION_ID}`,
          lease_expires_at: "2026-08-20T22:00:00.000Z",
          material_fingerprint: FP,
          material: qaSquareMaterial(),
        },
        error: null,
      };
      return { data: null, error: { message: `unexpected ${name}` } };
    });

    const response = await POST(request({
      operationId: OPERATION_ID,
      paymentRequestId: QA_SQUARE_PAYMENT_REQUEST_ID,
      squareCapabilityToken: "capability-token-bound-to-the-operation",
      squareSourceToken: "cnon:card-nonce-ok",
    }, {
      "x-nailiq-qa-square-response-loss": QA_RESPONSE_LOSS_SECRET,
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "deposit_unavailable" });
    expect(mocks.chargeCardToken).not.toHaveBeenCalled();
    expect(mocks.createServiceRoleClient).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
