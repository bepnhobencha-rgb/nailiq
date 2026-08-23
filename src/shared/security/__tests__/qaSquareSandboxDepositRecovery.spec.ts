import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  deriveQaSquareRecoveryCapabilityToken,
  QA_SQUARE_SANDBOX_RECOVERY,
  validateQaSquareSandboxProviderEvidence,
  validateQaSquareSandboxRecoveryCompletion,
  validateQaSquareSandboxRecoveryConfig,
  validateQaSquareSandboxRecoveryMarker,
} from "../../../../scripts/qa-square-sandbox-deposit-recover";
import { QA_SQUARE_SANDBOX_DEPOSIT } from "../../../../scripts/qa-square-sandbox-deposit-once";

const source = readFileSync(
  resolve(process.cwd(), "scripts/qa-square-sandbox-deposit-recover.ts"),
  "utf8",
);
const depositIntentSource = readFileSync(
  resolve(process.cwd(), "src/app/api/booking/deposit-intent/route.ts"),
  "utf8",
);

function validEnv(): Record<string, string> {
  return {
    NAILIQ_QA_SQUARE_SANDBOX_RECOVERY: "1",
    NAILIQ_QA_SQUARE_SANDBOX_ONCE: "1",
    DISABLE_OUTBOUND_SMS: "1",
    DISABLE_OUTBOUND_CALLS: "1",
    DISABLE_OUTBOUND_EMAIL: "1",
    VERCEL_ENV: "development",
    NODE_ENV: "test",
    NAILIQ_QA_LOCAL_SUPABASE: "1",
    NAILIQ_QA_SQUARE_SANDBOX_BASE_URL: "http://127.0.0.1:3100",
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_INTERNAL_URL: "http://127.0.0.1:54321",
    NAILIQ_QA_LOCAL_DB_URL:
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    SUPABASE_SERVICE_ROLE_KEY: "local-service-role-test-key-with-safe-length",
    SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT: "sandbox",
    NAILIQ_QA_SQUARE_ENVIRONMENT: "sandbox",
    NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID:
      QA_SQUARE_SANDBOX_RECOVERY.merchantId,
    NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID:
      QA_SQUARE_SANDBOX_RECOVERY.locationId,
    NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID:
      QA_SQUARE_SANDBOX_RECOVERY.frozenSdkApplicationId,
    NAILIQ_QA_SQUARE_SANDBOX_RECOVERY_TOKEN_APPLICATION_ID:
      QA_SQUARE_SANDBOX_RECOVERY.tokenClientId,
    NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN:
      "EAAAabcdefghijklmnopqrstuvwxyz0123456789",
  };
}

function validMarker(): Record<string, unknown> {
  return {
    mqa: "MQA-0196",
    status: "reconciliation_required",
    updated_at: "2026-08-23T02:09:34.994Z",
    operation_fingerprint: QA_SQUARE_SANDBOX_RECOVERY.operationFingerprint,
    failure_code: "square_response_loss_reconciliation_cron_not_proven",
    response_loss_recovered: false,
  };
}

function validTokenStatus(): Record<string, unknown> {
  return {
    client_id: QA_SQUARE_SANDBOX_RECOVERY.tokenClientId,
    merchant_id: QA_SQUARE_SANDBOX_RECOVERY.merchantId,
    scopes: ["MERCHANT_PROFILE_READ", "PAYMENTS_READ", "PAYMENTS_WRITE"],
    expires_at: "2026-09-22T00:00:00Z",
  };
}

function validLocation(): Record<string, unknown> {
  return {
    location: {
      id: QA_SQUARE_SANDBOX_RECOVERY.locationId,
      merchant_id: QA_SQUARE_SANDBOX_RECOVERY.merchantId,
      status: "ACTIVE",
      currency: "CAD",
      country: "CA",
    },
  };
}

function validPayment(): Record<string, unknown> {
  return {
    id: "sandbox-payment-receipt-test",
    created_at: QA_SQUARE_SANDBOX_RECOVERY.paymentCreatedAt,
    status: "COMPLETED",
    reference_id: QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId,
    location_id: QA_SQUARE_SANDBOX_RECOVERY.locationId,
    source_type: "CARD",
    amount_money: { amount: 100, currency: "CAD" },
    application_details: {
      application_id: QA_SQUARE_SANDBOX_RECOVERY.tokenClientId,
    },
    receipt_number: "sandbox-receipt",
    receipt_url: "https://squareupsandbox.com/receipt/test",
  };
}

describe("MQA-0196 guarded Square Sandbox recovery", () => {
  it("accepts only the exact loopback app, local Supabase and fixed Sandbox identities", () => {
    const config = validateQaSquareSandboxRecoveryConfig(validEnv());
    expect(config.baseUrl.origin).toBe("http://127.0.0.1:3100");
    expect(config.supabaseUrl).toBe("http://127.0.0.1:54321");
    expect(config.localDbUrl).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    );

    for (const [key, value] of [
      ["NAILIQ_QA_SQUARE_SANDBOX_BASE_URL", "https://www.nailiq.ca"],
      ["NEXT_PUBLIC_SUPABASE_URL", "https://fshmobzyjhmtvndobwsy.supabase.co"],
      ["NAILIQ_QA_LOCAL_DB_URL", "postgresql://example.invalid/postgres"],
      ["NAILIQ_QA_SQUARE_ENVIRONMENT", "production"],
      ["VERCEL_ENV", "production"],
      ["NODE_ENV", "production"],
      ["NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID", "MLWRONG00000"],
      ["NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID", "LWRONG00000"],
      ["NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID", "sandbox-sq0idb-wrongapp"],
      ["NAILIQ_QA_SQUARE_SANDBOX_RECOVERY_TOKEN_APPLICATION_ID", "sandbox-sq0idb-wrongtokenapp"],
    ] as const) {
      const env = validEnv();
      env[key] = value;
      expect(() => validateQaSquareSandboxRecoveryConfig(env)).toThrow();
    }
  });

  it("requires every manual and outbound gate and accepts no CLI override", () => {
    for (const key of [
      "NAILIQ_QA_SQUARE_SANDBOX_RECOVERY",
      "NAILIQ_QA_SQUARE_SANDBOX_ONCE",
      "DISABLE_OUTBOUND_SMS",
      "DISABLE_OUTBOUND_CALLS",
      "DISABLE_OUTBOUND_EMAIL",
      "NAILIQ_QA_LOCAL_SUPABASE",
      "SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT",
    ]) {
      const env = validEnv();
      delete env[key];
      expect(() => validateQaSquareSandboxRecoveryConfig(env)).toThrow();
    }
    expect(() => validateQaSquareSandboxRecoveryConfig(validEnv(), ["--retry"]))
      .toThrow("cli_arguments_forbidden");
  });

  it("accepts only the exact unresolved one-shot marker", () => {
    expect(validateQaSquareSandboxRecoveryMarker(validMarker())).toEqual({
      updatedAt: "2026-08-23T02:09:34.994Z",
      operationFingerprint: QA_SQUARE_SANDBOX_RECOVERY.operationFingerprint,
    });
    for (const [key, value] of [
      ["status", "pass_sandbox"],
      ["operation_fingerprint", "0000000000000000"],
      ["failure_code", "different_failure"],
      ["response_loss_recovered", true],
    ] as const) {
      expect(() => validateQaSquareSandboxRecoveryMarker({
        ...validMarker(),
        [key]: value,
      })).toThrow("recovery_marker_state_mismatch");
    }
  });

  it("requires one exact CAD receipt under the token client id, not the frozen SDK id", () => {
    const evidence = validateQaSquareSandboxProviderEvidence(
      validTokenStatus(),
      validLocation(),
      [validPayment()],
    );
    expect(evidence.paymentId).toBe("sandbox-payment-receipt-test");
    expect(evidence.paymentFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(evidence.tokenClientId).toBe(QA_SQUARE_SANDBOX_RECOVERY.tokenClientId);
    expect(evidence.tokenClientId).not.toBe(
      QA_SQUARE_SANDBOX_RECOVERY.frozenSdkApplicationId,
    );

    expect(() => validateQaSquareSandboxProviderEvidence(
      validTokenStatus(), validLocation(), [validPayment(), validPayment()],
    )).toThrow("square_payment_count_not_exactly_one");
    expect(() => validateQaSquareSandboxProviderEvidence(
      validTokenStatus(), validLocation(), [{
        ...validPayment(),
        amount_money: { amount: 101, currency: "CAD" },
      }],
    )).toThrow("square_payment_receipt_mismatch");
    expect(() => validateQaSquareSandboxProviderEvidence(
      validTokenStatus(), validLocation(), [{
        ...validPayment(),
        application_details: {
          application_id: QA_SQUARE_SANDBOX_RECOVERY.frozenSdkApplicationId,
        },
      }],
    )).toThrow("square_payment_receipt_mismatch");
  });

  it("derives the exact deterministic browser capability without persisting plaintext", () => {
    const secret = "local-signing-secret-for-tests-only-00000001";
    const first = deriveQaSquareRecoveryCapabilityToken(
      "019c0000-0000-7000-8000-000000000196",
      QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId,
      secret,
    );
    const second = deriveQaSquareRecoveryCapabilityToken(
      "019c0000-0000-7000-8000-000000000196",
      QA_SQUARE_SANDBOX_DEPOSIT.paymentRequestId,
      secret,
    );
    expect(first).toBe(second);
    expect(first).toMatch(/^sq1\.[A-Za-z0-9_-]{43}$/);
  });

  it("accepts only the succeeded_unbound completion returned before booking bind", () => {
    const operationId = "019c0000-0000-7000-8000-000000000196";
    const materialFingerprint = "a".repeat(64);
    const result = {
      success: true,
      code: "succeeded_unbound",
      status: "succeeded",
      operation_id: operationId,
      material_fingerprint: materialFingerprint,
    };
    expect(() => validateQaSquareSandboxRecoveryCompletion(
      result,
      operationId,
      materialFingerprint,
    )).not.toThrow();
    expect(() => validateQaSquareSandboxRecoveryCompletion(
      { ...result, code: "succeeded" },
      operationId,
      materialFingerprint,
    )).toThrow("recovery_completion_write_rejected");
  });

  it("keeps replay-only structurally isolated from meters and every provider path", () => {
    const replayHandler = depositIntentSource.slice(
      depositIntentSource.indexOf("async function replayCompletedSquarePaymentCapability"),
      depositIntentSource.indexOf("export async function POST"),
    );
    expect(replayHandler).toContain('db.rpc("claim_public_square_deposit_completion"');
    expect(replayHandler).toContain('row.code === "operation_replay"');
    expect(replayHandler).toContain('row.status === "succeeded"');
    expect(replayHandler).not.toContain("applyMeter");
    expect(replayHandler).not.toContain("applyMaterialMeters");
    expect(replayHandler).not.toContain("getSquareConfig");
    expect(replayHandler).not.toContain("chargeCardToken");
    expect(replayHandler).not.toContain("getStripeClient");

    const post = depositIntentSource.slice(
      depositIntentSource.indexOf("export async function POST"),
    );
    const replayBranch = post.indexOf('if (Object.hasOwn(body, "replayOnly"))');
    const firstMeter = post.indexOf("const ipBlocked = await applyMeter");
    expect(replayBranch).toBeGreaterThan(-1);
    expect(replayBranch).toBeLessThan(firstMeter);
    expect(post).toContain('body.replayOnly !== true || qaResponseLossSecret.length > 0');
    expect(post).toContain("Object.keys(body).length !== allowedKeys.size");
    expect(post).toContain('"squareCapabilityToken"');
  });

  it("keeps provider access read-only and orders every guarded recovery boundary", () => {
    const providerTransport = source.slice(
      source.indexOf("async function squareReadOnlyRequest"),
      source.indexOf("function stateFingerprint"),
    );
    expect(source).not.toContain("/api/cron/");
    expect(source).not.toContain("/api/booking/deposit-create");
    expect(source).not.toContain("chargeCardToken");
    expect(source).not.toContain("createPayment(");
    expect(source).not.toContain('"/v2/refunds"');
    expect(source).not.toContain("squareSourceToken");
    expect(source).not.toContain("cardNonce");
    expect(source).not.toContain("compensateUnboundDeposit");
    expect(source).not.toContain("dispatchClaimedBookingPaymentOperation");
    expect(source).not.toContain("load_unbound_deposit_refund_material");
    expect(providerTransport).not.toContain("idempotency_key");
    expect(source).not.toContain("x-nailiq-qa-square-response-loss");
    expect(source).not.toContain("providerWindowEnd");
    expect(source).toContain('url.pathname !== "/oauth2/token/status"');
    expect(source).toContain('url.pathname === "/v2/payments"');
    expect(source).toContain('method: "GET" | "POST"');
    expect(source).toContain("const windowEnd = new Date().toISOString()");
    expect(source.match(/readBoundedPaymentsThroughNow\(config\)/g)).toHaveLength(2);
    expect(source).toContain(
      "record(payment)?.reference_id === QA_SQUARE_SANDBOX_DEPOSIT.bookingRequestId",
    );
    expect(source).toContain('p_limit: 2');
    expect(source).toContain('p_outcome: "succeeded"');
    expect(source).toContain('row.code !== "succeeded_unbound"');
    expect(source.match(/db\.rpc\("create_public_booking_with_deposit_payment"/g))
      .toHaveLength(2);
    expect(source).toContain('manual_guarded_recovery: true');
    expect(source).toContain('cron_proven: false');
    expect(source).toContain('provider_write_performed: false');

    const run = source.slice(
      source.indexOf("export async function runQaSquareSandboxDepositRecovery"),
    );
    const marker = run.indexOf("validateQaSquareSandboxRecoveryMarker");
    const operation = run.indexOf("const initial = await loadUnknownOperation");
    const providerRead = run.indexOf("const [tokenStatus, location, initialPaymentRead]");
    const reread = run.indexOf("const unchanged = await loadUnknownOperation");
    const markerBeforeMutation = run.indexOf("requireUnchangedRecoveryMarker", reread);
    const stagedJournal = run.indexOf('writeRecoveryJournal("db_claim_starting"');
    const claim = run.indexOf("const claim = await claimExactRecoveryOperation");
    const complete = run.indexOf("await completeExactRecoveryOperation");
    const ledgerJournal = run.indexOf('writeRecoveryJournal("ledger_succeeded"');
    const capability = run.indexOf("deriveQaSquareRecoveryCapabilityToken");
    const stageTwoReplay = run.indexOf("await verifyStageTwoOperationReplay");
    const booking = run.indexOf("await createAndReplayBooking");
    const finalProviderRead = run.indexOf("const finalPaymentRead = await readBoundedPaymentsThroughNow");
    const markerBeforeCleanup = run.indexOf("requireUnchangedRecoveryMarker", finalProviderRead);
    const cleanup = run.indexOf("await cleanupExactLocalFixture");
    const finalMarker = run.indexOf("writeDurableJson(QA_SQUARE_SANDBOX_MARKER");
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(operation);
    expect(operation).toBeLessThan(capability);
    expect(capability).toBeLessThan(providerRead);
    expect(providerRead).toBeLessThan(reread);
    expect(reread).toBeLessThan(markerBeforeMutation);
    expect(markerBeforeMutation).toBeLessThan(stagedJournal);
    expect(stagedJournal).toBeLessThan(claim);
    expect(claim).toBeLessThan(complete);
    expect(complete).toBeLessThan(ledgerJournal);
    expect(ledgerJournal).toBeLessThan(stageTwoReplay);
    expect(stageTwoReplay).toBeLessThan(booking);
    expect(booking).toBeLessThan(finalProviderRead);
    expect(finalProviderRead).toBeLessThan(markerBeforeCleanup);
    expect(markerBeforeCleanup).toBeLessThan(cleanup);
    expect(cleanup).toBeLessThan(finalMarker);
    expect(run).toContain("fixturePreserved: !fixtureCleaned");
  });
});
