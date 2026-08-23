import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  QA_SQUARE_SANDBOX_DEPOSIT,
  QA_SQUARE_SANDBOX_MARKER,
  preflightQaSquareSandboxCredentialPair,
  timestampsRepresentSameInstant,
  validateQaSquareSandboxConfig,
} from "../../../../scripts/qa-square-sandbox-deposit-once";

const root = process.cwd();
const source = readFileSync(
  resolve(root, "scripts/qa-square-sandbox-deposit-once.ts"),
  "utf8",
);

function validEnv(): Record<string, string> {
  return {
    NAILIQ_QA_SQUARE_SANDBOX_ONCE: "1",
    DISABLE_OUTBOUND_SMS: "1",
    DISABLE_OUTBOUND_CALLS: "1",
    DISABLE_OUTBOUND_EMAIL: "1",
    NAILIQ_QA_SQUARE_RESPONSE_LOSS_ENABLED: "1",
    NAILIQ_QA_SQUARE_RESPONSE_LOSS_SECRET:
      "qa-square-response-loss-secret-00000001",
    SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT: "sandbox",
    PAYMENT_LEDGER_WORKERS_ENABLED: "true",
    VERCEL_ENV: "preview",
    CRON_SECRET: "qa-payment-reconciliation-cron-secret-0001",
    NAILIQ_QA_SQUARE_SANDBOX_BASE_URL:
      "https://nailiq-checklist-a1b2c3d4-huytran.vercel.app",
    NAILIQ_QA_IMMUTABLE_VERCEL_HOST:
      "nailiq-checklist-a1b2c3d4-huytran.vercel.app",
    NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
    NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-only-key-with-safe-length",
    NAILIQ_QA_SQUARE_ENVIRONMENT: "sandbox",
    NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID: "MLABCDEFGHIJKL",
    NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID: "LABCDEFGHIJKL",
    NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID:
      "sandbox-sq0idb-abcdefghijkl",
    NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN:
      "EAAAabcdefghijklmnopqrstuvwxyz0123456789",
  };
}

describe("MQA-0196 Square Sandbox one-shot harness", () => {
  it("accepts only an exactly pinned immutable non-production target", () => {
    const config = validateQaSquareSandboxConfig(validEnv());
    expect(config.baseUrl.origin).toBe(
      "https://nailiq-checklist-a1b2c3d4-huytran.vercel.app",
    );
    expect(config.expectedProjectRef).toBe("abcdefghijklmnopqrst");
    expect(config.localSupabase).toBe(false);
    expect(config.square.environment).toBe("sandbox");

    const local = validEnv();
    local.NAILIQ_QA_SQUARE_SANDBOX_BASE_URL = "http://127.0.0.1:3000";
    local.NAILIQ_QA_LOCAL_SUPABASE = "1";
    local.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
    local.SUPABASE_INTERNAL_URL = "http://127.0.0.1:54321";
    local.NAILIQ_QA_LOCAL_DB_URL =
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    local.VERCEL_ENV = "development";
    delete local.NAILIQ_QA_IMMUTABLE_VERCEL_HOST;
    delete local.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF;
    const localConfig = validateQaSquareSandboxConfig(local);
    expect(localConfig.baseUrl.origin).toBe("http://127.0.0.1:3000");
    expect(localConfig.supabaseUrl).toBe("http://127.0.0.1:54321");
    expect(localConfig.expectedProjectRef).toBe("local");
    expect(localConfig.localSupabase).toBe(true);
  });

  it("requires all action-time and outbound kill switches", () => {
    for (const key of [
      "NAILIQ_QA_SQUARE_SANDBOX_ONCE",
      "DISABLE_OUTBOUND_SMS",
      "DISABLE_OUTBOUND_CALLS",
      "DISABLE_OUTBOUND_EMAIL",
      "NAILIQ_QA_SQUARE_RESPONSE_LOSS_ENABLED",
      "NAILIQ_QA_SQUARE_RESPONSE_LOSS_SECRET",
      "SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT",
      "PAYMENT_LEDGER_WORKERS_ENABLED",
      "VERCEL_ENV",
      "CRON_SECRET",
    ]) {
      const env = validEnv();
      delete env[key];
      expect(() => validateQaSquareSandboxConfig(env)).toThrow();
    }
    expect(() => validateQaSquareSandboxConfig(validEnv(), ["--amount", "1"]))
      .toThrow("cli_arguments_forbidden");
  });

  it("refuses every production or mutable app host", () => {
    for (const baseUrl of [
      "https://nailiq.ca",
      "https://www.nailiq.ca",
      "https://nailiq.vercel.app",
      "https://nailiq-git-main-huytran.vercel.app",
      "https://example.com",
    ]) {
      const env = validEnv();
      env.NAILIQ_QA_SQUARE_SANDBOX_BASE_URL = baseUrl;
      env.NAILIQ_QA_IMMUTABLE_VERCEL_HOST = new URL(baseUrl).hostname;
      expect(() => validateQaSquareSandboxConfig(env)).toThrow();
    }
  });

  it("requires a matching non-production Supabase project ref", () => {
    const production = validEnv();
    production.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF =
      "fshmobzyjhmtvndobwsy";
    production.NEXT_PUBLIC_SUPABASE_URL =
      "https://fshmobzyjhmtvndobwsy.supabase.co";
    expect(() => validateQaSquareSandboxConfig(production)).toThrow(
      "production_supabase_ref_forbidden",
    );

    const mismatch = validEnv();
    mismatch.NEXT_PUBLIC_SUPABASE_URL =
      "https://zzzzzzzzzzzzzzzzzzzz.supabase.co";
    expect(() => validateQaSquareSandboxConfig(mismatch)).toThrow(
      "supabase_project_ref_mismatch",
    );

    const unpinned = validEnv();
    delete unpinned.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF;
    expect(() => validateQaSquareSandboxConfig(unpinned)).toThrow(
      "expected_supabase_project_ref_required",
    );
  });

  it("allows local Supabase only as an exact loopback pair with hosted refs absent", () => {
    function localEnv() {
      const env = validEnv();
      env.NAILIQ_QA_SQUARE_SANDBOX_BASE_URL = "http://127.0.0.1:3000";
      env.NAILIQ_QA_LOCAL_SUPABASE = "1";
      env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
      env.SUPABASE_INTERNAL_URL = "http://127.0.0.1:54321";
      env.NAILIQ_QA_LOCAL_DB_URL =
        "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
      env.VERCEL_ENV = "development";
      delete env.NAILIQ_QA_IMMUTABLE_VERCEL_HOST;
      delete env.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF;
      return env;
    }

    const remoteApp = localEnv();
    remoteApp.NAILIQ_QA_SQUARE_SANDBOX_BASE_URL =
      "https://nailiq-checklist-a1b2c3d4-huytran.vercel.app";
    remoteApp.NAILIQ_QA_IMMUTABLE_VERCEL_HOST =
      "nailiq-checklist-a1b2c3d4-huytran.vercel.app";
    expect(() => validateQaSquareSandboxConfig(remoteApp)).toThrow(
      "paired_local_supabase_required",
    );

    const noLocalGate = localEnv();
    delete noLocalGate.NAILIQ_QA_LOCAL_SUPABASE;
    expect(() => validateQaSquareSandboxConfig(noLocalGate)).toThrow();

    const hostedRefPresent = localEnv();
    hostedRefPresent.NAILIQ_QA_EXPECTED_SUPABASE_PROJECT_REF = "abcdefghijklmnopqrst";
    expect(() => validateQaSquareSandboxConfig(hostedRefPresent)).toThrow(
      "paired_local_supabase_required",
    );

    const wrongInternalUrl = localEnv();
    wrongInternalUrl.SUPABASE_INTERNAL_URL = "http://localhost:54321";
    expect(() => validateQaSquareSandboxConfig(wrongInternalUrl)).toThrow(
      "paired_local_supabase_required",
    );

    const missingLocalDbUrl = localEnv();
    delete missingLocalDbUrl.NAILIQ_QA_LOCAL_DB_URL;
    expect(() => validateQaSquareSandboxConfig(missingLocalDbUrl)).toThrow(
      "paired_local_supabase_required",
    );

    const wrongLocalDbUrl = localEnv();
    wrongLocalDbUrl.NAILIQ_QA_LOCAL_DB_URL =
      "postgresql://postgres:postgres@localhost:54322/postgres";
    expect(() => validateQaSquareSandboxConfig(wrongLocalDbUrl)).toThrow(
      "paired_local_supabase_required",
    );

    const hostedDbUrl = validEnv();
    hostedDbUrl.NAILIQ_QA_LOCAL_DB_URL =
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    expect(() => validateQaSquareSandboxConfig(hostedDbUrl)).toThrow(
      "local_postgres_url_forbidden_for_hosted",
    );
  });

  it("compares canonical quote timestamps by epoch rather than ISO spelling", () => {
    expect(timestampsRepresentSameInstant(
      "2026-08-26T12:00:00+00:00",
      "2026-08-26T12:00:00.000Z",
    )).toBe(true);
    expect(timestampsRepresentSameInstant(
      "2026-08-26T12:00:00-07:00",
      "2026-08-26T19:00:00.000Z",
    )).toBe(true);
    expect(timestampsRepresentSameInstant("invalid", "invalid")).toBe(false);
  });

  it("accepts only Square sandbox-shaped identity material", () => {
    const cases: Array<[string, string]> = [
      ["NAILIQ_QA_SQUARE_ENVIRONMENT", "production"],
      ["NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID", "merchant"],
      ["NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID", "location"],
      ["NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID", "sq0idp-production"],
      ["NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN", "token"],
    ];
    for (const [key, value] of cases) {
      const env = validEnv();
      env[key] = value;
      expect(() => validateQaSquareSandboxConfig(env)).toThrow();
    }
  });

  it("preflights the exact sandbox application and merchant read-only", async () => {
    const config = validateQaSquareSandboxConfig(validEnv());
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        client_id: config.square.applicationId,
        merchant_id: config.square.merchantId,
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;

    await expect(
      preflightQaSquareSandboxCredentialPair(config, fetchMock),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchMock).mock.calls[0];
    expect(String(url)).toBe(
      "https://connect.squareupsandbox.com/oauth2/token/status",
    );
    expect(init).toMatchObject({
      method: "POST",
      cache: "no-store",
      redirect: "error",
    });
    expect(init?.body).toBeUndefined();
  });

  it("refuses a sandbox token issued to another application or merchant", async () => {
    const config = validateQaSquareSandboxConfig(validEnv());
    const applicationMismatch = vi.fn(async () =>
      new Response(JSON.stringify({
        client_id: "sandbox-sq0idb-anotherapp",
        merchant_id: config.square.merchantId,
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;
    const merchantMismatch = vi.fn(async () =>
      new Response(JSON.stringify({
        client_id: config.square.applicationId,
        merchant_id: "MLDIFFERENT123",
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;

    await expect(
      preflightQaSquareSandboxCredentialPair(config, applicationMismatch),
    ).rejects.toThrow("square_sandbox_application_token_mismatch");
    await expect(
      preflightQaSquareSandboxCredentialPair(config, merchantMismatch),
    ).rejects.toThrow("square_sandbox_merchant_token_mismatch");
  });

  it("hard-codes one CAD dollar and Square's success nonce", () => {
    expect(QA_SQUARE_SANDBOX_DEPOSIT).toMatchObject({
      amountCents: 100,
      currency: "CAD",
      sourceToken: "cnon:card-nonce-ok",
      slug: "e2e-square-sandbox-deposit-once",
    });
    for (const key of [
      "salonId",
      "serviceId",
      "staffId",
      "bookingRequestId",
      "paymentRequestId",
    ] as const) {
      expect(QA_SQUARE_SANDBOX_DEPOSIT[key]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("keeps provider dispatch single-shot through response-loss reconciliation", () => {
    expect(QA_SQUARE_SANDBOX_MARKER).toBe(
      "/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence/mqa-0196-square-sandbox-one-shot.json",
    );
    expect(source).toContain('"/api/booking/quote"');
    expect(source).toContain('"/api/booking/deposit-intent"');
    expect(source).toContain('"/api/cron/payment-reconciliation"');
    expect(source).toContain('"/api/booking/deposit-create"');
    expect(source.match(/squareSourceToken:/g)).toHaveLength(2);
    expect(source).toContain("await verifyUnknownOperation");
    expect(source).toContain("await verifyPaidOperation");
    expect(source).toContain("await verifyBoundBooking");
    expect(source).toContain("[QA_RESPONSE_LOSS_HEADER]: config.responseLossSecret");
    expect(source).toContain('openSync(path, "wx", 0o600)');
    expect(source).toContain("fsyncSync(descriptor)");
    expect(source).toContain('"one_shot_marker_already_exists"');
    expect(source).toContain('created.body.code !== "booked_and_deposit_bound"');
    expect(source).toContain('createReplay.body.code !== "booking_payment_replay"');
    expect(source).toContain('"RECONCILIATION_REQUIRED"');
    expect(source).toContain("fixturePreserved: providerDispatchAttempted");
    expect(source).toContain('const LOCAL_POSTGRES_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"');
    expect(source).toContain('localDbUrl !== LOCAL_POSTGRES_URL');
    expect(source).toContain('execFileAsync("psql"');
    expect(source).toContain('DELETE FROM public.booking_payment_operations WHERE salon_id = qa_salon_id');
    expect(source).toContain('{ originalFailureCode: finalCode }');
    expect(source).not.toContain('execFileAsync("psql", [config.localDbUrl');
    expect(source).not.toMatch(/\b(?:unlinkSync|rmSync|rmdirSync)\s*\(/);
    expect(source).not.toMatch(/process\.argv\[[23]\]/);
    expect(source).not.toMatch(/NAILIQ_QA_SQUARE_(?:AMOUNT|SOURCE_TOKEN)/);

    const runSource = source.slice(source.indexOf("export async function runQaSquareSandboxDepositOnce"));
    const markerPreflight = runSource.indexOf("if (existsSync(QA_SQUARE_SANDBOX_MARKER))");
    const credentialPreflight = runSource.indexOf(
      "await preflightQaSquareSandboxCredentialPair(config)",
    );
    const dbClient = runSource.indexOf("const db = createClient");
    const marker = runSource.indexOf("createOneShotMarker(operationId");
    const providerAttempt = runSource.indexOf("providerDispatchAttempted = true");
    const faultedStageTwo = runSource.indexOf("const stageTwo = await appPost");
    const cron = runSource.indexOf('appGet(config, "/api/cron/payment-reconciliation")');
    const replay = runSource.indexOf("const stageTwoReplay = await appPost");
    const create = runSource.indexOf("const created = await appPost");
    expect(markerPreflight).toBeGreaterThan(-1);
    expect(markerPreflight).toBeLessThan(dbClient);
    expect(credentialPreflight).toBeGreaterThan(markerPreflight);
    expect(credentialPreflight).toBeLessThan(dbClient);
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(providerAttempt);
    expect(providerAttempt).toBeLessThan(faultedStageTwo);
    expect(marker).toBeLessThan(faultedStageTwo);
    expect(faultedStageTwo).toBeLessThan(cron);
    expect(cron).toBeLessThan(replay);
    expect(replay).toBeLessThan(create);
  });
});
