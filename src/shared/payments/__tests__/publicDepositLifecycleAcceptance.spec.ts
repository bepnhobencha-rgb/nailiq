import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260820150000_add_authoritative_booking_payment_operations.sql"),
  "utf8",
);
const intentRoute = readFileSync(
  resolve(root, "src/app/api/booking/deposit-intent/route.ts"),
  "utf8",
);
const finalizeRoute = readFileSync(
  resolve(root, "src/app/api/booking/deposit-finalize/route.ts"),
  "utf8",
);
const submitPublicBooking = readFileSync(
  resolve(root, "src/shared/booking/submitPublicBooking.ts"),
  "utf8",
);

function sqlFunction(name: string) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = migration.indexOf(marker);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf("$function$;", start);
  expect(end, `${name} must terminate`).toBeGreaterThan(start);
  return migration.slice(start, end + "$function$;".length);
}

function sourceTree(dir: string): string {
  return readdirSync(dir).map((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" ? "" : sourceTree(path);
    }
    return /\.(?:ts|tsx)$/.test(name) && !/\.(?:spec|test)\.(?:ts|tsx)$/.test(name)
      ? readFileSync(path, "utf8")
      : "";
  }).join("\n");
}

const runtimeSource = sourceTree(resolve(root, "src"));
describe("public deposit crash/replay lifecycle acceptance", () => {
  it("replays an owned operation before recomputing current availability or pricing", () => {
    const claim = sqlFunction("claim_public_deposit_payment_operation");
    const exactRequestLookup = claim.indexOf("WHERE salon_id=p_salon_id AND request_id=p_request_id");
    const currentMaterial = claim.indexOf("resolve_public_deposit_payment_material");
    expect(exactRequestLookup, "exact request replay lookup must exist").toBeGreaterThanOrEqual(0);
    expect(
      exactRequestLookup,
      "a committed/ambiguous operation must remain replayable after the slot or quote changes",
    ).toBeLessThan(currentMaterial);
  });

  it("recovers an expired sending/attach attempt with the same provider identity", () => {
    const claim = sqlFunction("claim_public_deposit_payment_operation");
    expect(claim).toMatch(/status IN \('sending','reconciling'\)[\s\S]{0,180}?lease_expires_at<=now\(\)[\s\S]{0,500}?'reconciliation_required'/);
    expect(intentRoute).toMatch(/reconciliation_required[\s\S]{0,900}?claim_booking_payment_operation_reconciliation/);
    expect(intentRoute).toMatch(/providerIdempotencyKey|provider_idempotency_key/);
  });

  it("keeps requires_action pending-customer instead of marking it failed or paid", () => {
    expect(intentRoute).toMatch(/\["requires_payment_method",\s*"requires_action"\]\.includes\(intent\.status\)/);
    const attach = sqlFunction("attach_public_deposit_provider_intent");
    expect(attach).toMatch(/v_status NOT IN \('requires_payment_method','requires_action'\)/);
    expect(attach).toMatch(/SET status='pending_customer'/);
  });

  it("resumes customer confirmation only after retrieving the exact stored PaymentIntent", () => {
    expect(runtimeSource).toMatch(/resume_public_deposit_customer_confirmation/);
    const resumeAt = runtimeSource.indexOf("resume_public_deposit_customer_confirmation");
    const localWindow = runtimeSource.slice(Math.max(0, resumeAt - 5_000), resumeAt + 2_000);
    expect(localWindow).toMatch(/paymentIntents\.retrieve\([\s\S]{0,300}?(?:providerPaymentId|provider_payment_id)/);
    expect(localWindow).not.toMatch(/paymentIntents\.create\(/);
  });

  it("finalization reconciliation retrieves only the DB-claimed provider receipt", () => {
    const claimAt = finalizeRoute.indexOf("claim_public_deposit_finalization");
    const claimedReceiptAt = finalizeRoute.indexOf("claim.provider_payment_id", claimAt);
    const retrieveAt = finalizeRoute.indexOf("paymentIntents.retrieve(", claimedReceiptAt);
    expect(claimAt).toBeGreaterThanOrEqual(0);
    expect(claimedReceiptAt).toBeGreaterThan(claimAt);
    expect(retrieveAt).toBeGreaterThan(claimedReceiptAt);
    expect(finalizeRoute).not.toMatch(/paymentIntents\.retrieve\([^)]*(?:body|request)\./);
  });

  it("runs a durable worker for paid-unbound compensation after app/process loss", () => {
    expect(runtimeSource).toMatch(/discover_due_unbound_deposit_compensations/);
    expect(runtimeSource).toMatch(/claim_due_unbound_deposit_refund/);
    expect(runtimeSource).toMatch(/dispatchClaimedBookingPaymentOperation/);
  });

  it("provides a service-only transaction that creates then binds or rolls both back", () => {
    const atomic = sqlFunction("create_public_booking_with_deposit_payment");
    expect(atomic).toMatch(/p_payment_operation_id uuid[\s\S]{0,500}?p_payment_request_id uuid[\s\S]{0,500}?p_expected_payment_material_fingerprint text/);
    expect(atomic).toMatch(/v_create:=public\.create_public_booking\([\s\S]{0,1800}?v_bind:=public\.bind_public_deposit_payment_operation\(/);
    expect(atomic).toMatch(/EXCEPTION WHEN SQLSTATE 'NI001'[\s\S]{0,500}?'atomic_deposit_bind_failed'/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.create_public_booking_with_deposit_payment\([\s\S]{0,500}?FROM PUBLIC, anon, authenticated/);
  });

  it("uses the atomic paid-deposit create boundary instead of post-create bind", () => {
    expect(submitPublicBooking).toMatch(/create_public_booking_with_deposit_payment/);
    expect(submitPublicBooking).not.toMatch(/create_public_booking[\s\S]{0,20_000}?fetch\("\/api\/booking\/deposit-bind"/);
  });

  it("leases due generic reconciliation work through a service-only DB boundary", () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.discover_due_booking_payment_reconciliations\(/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.discover_due_booking_payment_reconciliations\(integer\)[\s\S]{0,120}?FROM PUBLIC, anon, authenticated/);
  });

  it("runs a generic due reconciliation worker without blind redispatch", () => {
    expect(runtimeSource).toMatch(/discover_due_booking_payment_reconciliations/);
    expect(runtimeSource).toMatch(/claim_booking_payment_operation_reconciliation/);
    expect(runtimeSource).toMatch(/dispatchClaimedBookingPaymentOperation/);
  });
});
