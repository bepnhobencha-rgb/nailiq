import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  reconcileSquarePublicDepositResponseLoss,
} from "../publicDepositReconciliation";
import type { SquareConfig, SquarePayment } from "../client";
import type { ClaimedPublicDepositPaymentOperation } from "@/shared/payments/bookingPaymentOperations";

const SALON_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_TOKEN = "33333333-3333-4333-8333-333333333333";
const BOOKING_REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_CREATED_AT = "2026-08-22T11:59:00.000Z";
const LEASE_EXPIRES_AT = "2026-08-22T12:02:00.000Z";
const NOW = new Date("2026-08-22T12:30:00.000Z");

const config: SquareConfig = {
  salonId: SALON_ID,
  merchantId: "merchant-1",
  locationId: "location-1",
  accessToken: "sandbox-token",
  applicationId: "sandbox-app-1",
  environment: "sandbox",
  currency: "CAD",
  sync: {
    pullCreate: false,
    pullUpdate: false,
    pullCancel: false,
    pushCreate: false,
    pushUpdate: false,
    pushCancel: false,
  },
};

function claim(
  environment: "sandbox" | "production" = "sandbox",
): ClaimedPublicDepositPaymentOperation {
  return {
    operationId: OPERATION_ID,
    attemptToken: ATTEMPT_TOKEN,
    providerIdempotencyKey: `nq:${OPERATION_ID}`,
    leaseExpiresAt: LEASE_EXPIRES_AT,
    attemptCount: 2,
    material: {
      salonId: SALON_ID,
      serviceId: "55555555-5555-4555-8555-555555555555",
      staffId: "66666666-6666-4666-8666-666666666666",
      startTimeUtc: "2026-08-23T18:00:00.000Z",
      endTimeUtc: "2026-08-23T19:00:00.000Z",
      bookingIdempotencyKey: BOOKING_REQUEST_ID,
      pricingFingerprint: "a".repeat(64),
      clientPhoneFingerprint: "b".repeat(64),
      provider: "square",
      providerAccountFingerprint: "c".repeat(64),
      amountCents: 5_000,
      currency: "CAD",
      depositReason: "policy_required",
      materialFingerprint: "d".repeat(64),
      providerMaterial: {
        providerAccountId: "merchant-1",
        providerLocationId: "location-1",
        providerApplicationId: "sandbox-app-1",
        providerEnvironment: environment,
        currency: "CAD",
        amountCents: 5_000,
        bookingIntentReference: BOOKING_REQUEST_ID,
        pricingFingerprint: "a".repeat(64),
      },
    },
  };
}

function payment(overrides: Partial<SquarePayment> = {}): SquarePayment {
  return {
    id: "payment-1",
    status: "COMPLETED",
    created_at: "2026-08-22T12:00:00.000Z",
    location_id: "location-1",
    amount_money: { amount: 5_000, currency: "CAD" },
    application_details: { application_id: "sandbox-app-1" },
    reference_id: BOOKING_REQUEST_ID,
    ...overrides,
  };
}

function db() {
  return {
    from: vi.fn(),
    rpc: vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      data: args.p_outcome === "succeeded"
        ? { success: true, code: "succeeded", status: "succeeded" }
        : { success: false, code: "provider_outcome_unknown", status: "unknown" },
      error: null,
    })),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Square public deposit response-loss reconciliation", () => {
  it("is default-off and performs no config or provider read without the exact flag", async () => {
    const database = db();
    const getConfig = vi.fn();
    const findPayment = vi.fn();

    await expect(reconcileSquarePublicDepositResponseLoss(
      database,
      claim(),
      null,
      OPERATION_CREATED_AT,
      { getConfig, findPayment, now: () => NOW },
    )).resolves.toEqual({ status: "disabled" });

    expect(getConfig).not.toHaveBeenCalled();
    expect(findPayment).not.toHaveBeenCalled();
    expect(database.rpc).not.toHaveBeenCalled();
  });

  it("rejects an environment mismatch before config or provider reads", async () => {
    vi.stubEnv("SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT", "sandbox");
    const database = db();
    const getConfig = vi.fn();
    const findPayment = vi.fn();

    await expect(reconcileSquarePublicDepositResponseLoss(
      database,
      claim("production"),
      null,
      OPERATION_CREATED_AT,
      { getConfig, findPayment, now: () => NOW },
    )).resolves.toEqual({ status: "unknown", reason: "environment_mismatch" });

    expect(getConfig).not.toHaveBeenCalled();
    expect(findPayment).not.toHaveBeenCalled();
    expect(database.rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_outcome: "unknown",
        p_error_code: "provider_outcome_ambiguous",
      }),
    );
  });

  it("completes exactly one matching completed payment atomically", async () => {
    vi.stubEnv("SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT", "sandbox");
    const database = db();
    const exactPayment = payment();
    const getConfig = vi.fn(async () => config);
    const findPayment = vi.fn(async () => exactPayment);

    await expect(reconcileSquarePublicDepositResponseLoss(
      database,
      claim(),
      null,
      OPERATION_CREATED_AT,
      { getConfig, findPayment, now: () => NOW },
    )).resolves.toEqual({ status: "succeeded", paymentId: "payment-1" });

    expect(findPayment).toHaveBeenCalledWith(config, {
      referenceId: BOOKING_REQUEST_ID,
      amountCents: 5_000,
      currency: "CAD",
      beginTime: "2026-08-22T11:58:00.000Z",
      endTime: "2026-08-22T12:19:00.000Z",
    });
    expect(database.rpc).toHaveBeenCalledTimes(1);
    expect(database.rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      {
        p_operation_id: OPERATION_ID,
        p_attempt_token: ATTEMPT_TOKEN,
        p_outcome: "succeeded",
        p_provider_status: "COMPLETED",
        p_provider_payment_id: "payment-1",
        p_provider_refund_id: null,
        p_error_code: null,
      },
    );
  });

  it("ends the exact lookup window at now when reconciliation starts before 20 minutes", async () => {
    vi.stubEnv("SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT", "sandbox");
    const database = db();
    const findPayment = vi.fn(async () => payment());

    await reconcileSquarePublicDepositResponseLoss(
      database,
      claim(),
      null,
      OPERATION_CREATED_AT,
      {
        getConfig: vi.fn(async () => config),
        findPayment,
        now: () => new Date("2026-08-22T12:05:00.000Z"),
      },
    );

    expect(findPayment).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        beginTime: "2026-08-22T11:58:00.000Z",
        endTime: "2026-08-22T12:05:00.000Z",
      }),
    );
  });

  it("keeps no-match outcomes unknown without issuing a mutation", async () => {
    vi.stubEnv("SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT", "sandbox");
    const database = db();
    const findPayment = vi.fn(async () => null);

    await expect(reconcileSquarePublicDepositResponseLoss(
      database,
      claim(),
      null,
      OPERATION_CREATED_AT,
      { getConfig: vi.fn(async () => config), findPayment, now: () => NOW },
    )).resolves.toEqual({ status: "unknown", reason: "payment_not_found" });

    expect(findPayment).toHaveBeenCalledTimes(1);
    expect(database.rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_outcome: "unknown",
        p_provider_payment_id: null,
        p_error_code: "provider_outcome_ambiguous",
      }),
    );
  });

  it.each([
    "square_payment_recovery_multiple_matches",
    "square_payment_recovery_receipt_invalid",
  ])("keeps a provider lookup conflict unknown: %s", async (message) => {
    vi.stubEnv("SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT", "sandbox");
    const database = db();
    const findPayment = vi.fn(async () => {
      throw new Error(message);
    });

    await expect(reconcileSquarePublicDepositResponseLoss(
      database,
      claim(),
      null,
      OPERATION_CREATED_AT,
      { getConfig: vi.fn(async () => config), findPayment, now: () => NOW },
    )).resolves.toEqual({ status: "unknown", reason: "provider_lookup_ambiguous" });

    expect(database.rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_outcome: "unknown",
        p_error_code: "provider_outcome_ambiguous",
      }),
    );
  });

  it.each([
    ["status", { status: "APPROVED" }],
    ["reference", { reference_id: "55555555-5555-4555-8555-555555555555" }],
    ["location", { location_id: "location-2" }],
    ["application", { application_details: { application_id: "sandbox-app-2" } }],
    ["amount", { amount_money: { amount: 4_999, currency: "CAD" } }],
    ["currency", { amount_money: { amount: 5_000, currency: "USD" } }],
    ["time", { created_at: "2026-08-22T12:20:00.000Z" }],
  ])("rejects a non-exact %s receipt returned by the lookup", async (_field, override) => {
    vi.stubEnv("SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT", "sandbox");
    const database = db();

    await expect(reconcileSquarePublicDepositResponseLoss(
      database,
      claim(),
      null,
      OPERATION_CREATED_AT,
      {
        getConfig: vi.fn(async () => config),
        findPayment: vi.fn(async () => payment(override)),
        now: () => NOW,
      },
    )).resolves.toEqual({ status: "unknown", reason: "provider_receipt_mismatch" });

    expect(database.rpc).toHaveBeenCalledWith(
      "complete_booking_payment_operation",
      expect.objectContaining({
        p_outcome: "unknown",
        p_provider_payment_id: null,
        p_error_code: "provider_outcome_ambiguous",
      }),
    );
  });

  it.each([
    ["merchant", { merchantId: "merchant-2" }],
    ["location", { locationId: "location-2" }],
    ["application", { applicationId: "sandbox-app-2" }],
    ["environment", { environment: "production" as const }],
    ["currency", { currency: "USD" }],
  ])("rejects a mismatched %s config before the provider lookup", async (_field, override) => {
    vi.stubEnv("SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT", "sandbox");
    const database = db();
    const findPayment = vi.fn();

    await expect(reconcileSquarePublicDepositResponseLoss(
      database,
      claim(),
      null,
      OPERATION_CREATED_AT,
      {
        getConfig: vi.fn(async () => ({ ...config, ...override })),
        findPayment,
        now: () => NOW,
      },
    )).resolves.toEqual({ status: "unknown", reason: "provider_context_mismatch" });

    expect(findPayment).not.toHaveBeenCalled();
  });

  it("contains only a Square lookup and the existing atomic completion RPC", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/shared/integrations/square/publicDepositReconciliation.ts"),
      "utf8",
    );
    expect(source).toContain("findExactSquarePaymentByReference");
    expect(source).toContain("complete_booking_payment_operation");
    expect(source).not.toMatch(/chargeCardToken|createSquare|createPayment|fetch\s*\(/);
  });

  it("wires dedicated discovery only behind an exact environment and excludes it generically", () => {
    const route = readFileSync(
      resolve(process.cwd(), "src/app/api/cron/payment-reconciliation/route.ts"),
      "utf8",
    );
    const migration = readFileSync(
      resolve(
        process.cwd(),
        "supabase/migrations/20260823011500_add_public_square_deposit_reconciliation_discovery.sql",
      ),
      "utf8",
    );
    const environmentGate = route.indexOf(
      'squareEnvironment === "sandbox" || squareEnvironment === "production"',
    );
    const dedicatedDiscovery = route.indexOf(
      '"discover_due_public_square_deposit_reconciliations"',
    );
    const genericDiscovery = route.indexOf(
      '"discover_due_booking_payment_reconciliations"',
    );
    const genericFunctionStart = migration.indexOf(
      "CREATE OR REPLACE FUNCTION public.discover_due_booking_payment_reconciliations",
    );
    const dedicatedFunction = migration.slice(0, genericFunctionStart);
    const genericFunction = migration.slice(genericFunctionStart);
    expect(environmentGate).toBeGreaterThan(-1);
    expect(dedicatedDiscovery).toBeGreaterThan(environmentGate);
    expect(genericDiscovery).toBeGreaterThan(dedicatedDiscovery);
    expect(route.slice(environmentGate, genericDiscovery)).toMatch(
      /if \(squareDiscoveryEnabled\)[\s\S]*discover_due_public_square_deposit_reconciliations/,
    );
    expect(genericFunction).toMatch(
      /AND NOT \([\s\S]{0,120}p\.provider = 'square'[\s\S]{0,120}p\.delivery_mode = 'public_customer_present'/,
    );
    expect(dedicatedFunction).toContain("p.status IN ('pending_provider', 'unknown')");
    expect(dedicatedFunction).not.toMatch(
      /provider_payment_id IS NULL[\s\S]{0,80}p\.status = 'unknown'/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.discover_due_public_square_deposit_reconciliations\(text, integer\)[\s\S]{0,100}FROM PUBLIC, anon, authenticated/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.discover_due_public_square_deposit_reconciliations\(text, integer\)[\s\S]{0,60}TO service_role/,
    );
  });
});
