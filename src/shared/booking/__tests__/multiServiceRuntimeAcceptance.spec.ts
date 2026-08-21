import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const optional = (path: string) =>
  existsSync(resolve(root, path)) ? read(path) : "";

const quoteRoute = optional("src/app/api/booking/sequence-quote/route.ts");
const createRoute = optional("src/app/api/booking/sequence-create/route.ts");
const sequenceServer = optional("src/shared/booking/bookingSequenceServer.ts");
const sequenceReadiness = read("src/shared/booking/bookingSequenceReadiness.ts");
const receiptParser = read("src/shared/booking/bookingSequenceReceipt.ts");
const receiptServer = read("src/shared/booking/bookingSequenceReceiptServer.ts");
const readiness = read("src/shared/dashboard/loadGoLiveReadiness.ts");
const confirmation = read("src/shared/booking/sendBookingConfirmationEmail.ts");
const capability = read("src/shared/booking/bookingManagementCapabilities.ts");
const sequenceMigration = read(
  "supabase/migrations/20260820180036_add_authoritative_booking_service_sequences.sql",
);
const statusRoute = read("src/app/api/booking/status/route.ts");
const confirmRoute = read("src/app/api/booking/confirm-action/route.ts");

function expectBoundedPublicMutation(source: string) {
  expect(source).toMatch(/isSameOrigin|Allowed.*Origin|sameOrigin/i);
  expect(source).toMatch(/readJsonObjectWithLimit|TextEncoder[\s\S]{0,180}?byteLength/);
  expect(source).toMatch(/Cache-Control["']?:?\s*["']no-store|"Cache-Control":\s*"no-store"/);
  expect(source).toMatch(/rate_limit_hit|RateLimitAllowed|rateLimitAllowed/);
}

describe("multi-service runtime contract acceptance", () => {
  it("exposes a bounded POST quote route only after dual/readiness authorization", () => {
    expect(quoteRoute, "sequence quote route is not implemented").not.toBe("");
    expect(quoteRoute).toContain("export async function POST");
    expectBoundedPublicMutation(quoteRoute);
    expect(quoteRoute).toContain("loadPublicBookingSequenceReadiness");
    expect(quoteRoute).toContain("bookingSequenceServer");
    expect(sequenceReadiness).toContain("load_public_booking_sequence_readiness");
    expect(sequenceServer).toContain("quote_public_booking_sequence");
    expect(quoteRoute).toMatch(/phone[\s\S]{0,300}?rate/i);
  });

  it("checks exact replay before mutable gates and keeps OTP before a fresh create", () => {
    expect(createRoute, "sequence create route is not implemented").not.toBe("");
    expect(createRoute).toContain("export async function POST");
    expectBoundedPublicMutation(createRoute);
    expect(createRoute).toContain("loadPublicBookingSequenceReadiness");
    expect(createRoute).toContain("bookingSequenceServer");
    expect(sequenceReadiness).toContain("load_public_booking_sequence_readiness");
    expect(sequenceServer).toContain("create_public_booking_sequence");
    expect(createRoute).toMatch(/otpSessionId|otp_session_id/);
    const postStart = createRoute.indexOf("export async function POST");
    const postEnd = createRoute.indexOf("async function authorizeSequenceOtp", postStart);
    const postBody = createRoute.slice(postStart, postEnd);
    const readinessIndex = postBody.indexOf("await loadPublicBookingSequenceReadiness(");
    const otpIndex = postBody.indexOf("await authorizeSequenceOtp(");
    const replayIndex = postBody.indexOf("await replayPublicBookingSequence(");
    const createIndex = postBody.indexOf("await createPublicBookingSequence(");
    expect(replayIndex).toBeGreaterThan(-1);
    expect(readinessIndex).toBeGreaterThan(-1);
    expect(readinessIndex).toBeGreaterThan(replayIndex);
    expect(otpIndex).toBeGreaterThan(readinessIndex);
    expect(createIndex).toBeGreaterThan(otpIndex);
    expect(createRoute).toMatch(/phone[\s\S]{0,300}?rate/i);
  });

  it("lets the DB replay first, then atomically rejects configured payment policy before a fresh write", () => {
    expect(sequenceServer, "sequence server helper is not implemented").not.toBe("");
    const appRunnerStart = sequenceServer.indexOf(
      "async function runPublicBookingSequenceCreateRpc",
    );
    const appRunnerEnd = sequenceServer.indexOf(
      "/** Read-only response-loss lookup.",
      appRunnerStart,
    );
    const appRunner = sequenceServer.slice(appRunnerStart, appRunnerEnd);
    const rpcIndex = appRunner.indexOf("createServiceRoleClient().rpc(");
    expect(rpcIndex).toBeGreaterThan(-1);
    expect(appRunner.slice(0, rpcIndex)).not.toMatch(
      /noshow_protection_enabled|payment_provider|\.from\("salons"/,
    );
    expect(appRunner).not.toMatch(/loadSequenceSalonSlug|\.from\("salons"/);
    expect(appRunner).toMatch(/persistedSnapshot\.salon_slug !== salonSlug/);
    expect(sequenceServer).toMatch(
      /createPublicBookingSequence[\s\S]{0,300}?runPublicBookingSequenceCreateRpc\("create_public_booking_sequence"/,
    );

    const dbCreateStart = sequenceMigration.indexOf(
      "CREATE OR REPLACE FUNCTION public.create_public_booking_sequence",
    );
    const dbCreateEnd = sequenceMigration.indexOf(
      "REVOKE ALL ON FUNCTION public.create_public_booking_sequence",
      dbCreateStart,
    );
    const dbCreate = sequenceMigration.slice(dbCreateStart, dbCreateEnd);
    const replayRead = dbCreate.indexOf("SELECT b.* INTO v_existing");
    const replayReturn = dbCreate.indexOf(
      "RETURN v_existing.public_booking_pricing_snapshot",
      replayRead,
    );
    const policyRead = dbCreate.indexOf(
      "v_health_ack_required, v_locked_noshow_protection_enabled",
      replayReturn,
    );
    const freshInsert = dbCreate.indexOf("INSERT INTO public.bookings");
    expect(replayRead).toBeGreaterThan(-1);
    expect(replayReturn).toBeGreaterThan(replayRead);
    expect(policyRead).toBeGreaterThan(replayReturn);
    expect(freshInsert).toBeGreaterThan(policyRead);
    expect(dbCreate).toMatch(
      /v_locked_noshow_protection_enabled OR v_locked_payment_provider IS NOT NULL[\s\S]{0,180}?'payment_not_supported'/,
    );
    expect(sequenceServer).not.toMatch(/getStripeClient|getSquareConfig|chargeCard|paymentIntents/);
    expect(createRoute).not.toMatch(/ensureNoShowCardRequirement|saveCard|deposit/);
  });

  it("projects authoritative sequence readiness into Go-Live without trusting clicks", () => {
    expect(readiness).toContain("load_public_booking_sequence_readiness");
    expect(readiness).toMatch(/contract_version|contractVersion/);
    expect(readiness).toMatch(/capacity_contract_ready|capacityContractReady/);
    expect(readiness).toMatch(/catalog_ready|catalogReady/);
    expect(readiness).toMatch(/platform_enabled|platformEnabled/);
    expect(readiness).toMatch(/salon_enabled|salonEnabled/);
    expect(readiness).toMatch(/qa_allowlisted|qaAllowlisted/);
    expect(readiness).toMatch(/multi.service[\s\S]{0,500}?(required|ready|pass)/i);
  });

  it("builds a sequence confirmation from the persisted server receipt before provider send", () => {
    expect(confirmation).toContain("bookingSequenceReceiptServer");
    expect(confirmation).toContain("loadBookingSequenceReceipt");
    expect(receiptServer).toContain("load_booking_sequence_receipt");
    expect(receiptServer).toContain("parseBookingSequenceReceipt");
    expect(receiptParser).toContain("segmentMatchesSnapshot");
    const receiptIndex = confirmation.indexOf("await loadBookingSequenceReceipt");
    const claimIndex = confirmation.indexOf("claimNotificationOnce");
    const providerIndex = confirmation.indexOf("resend.emails.send");
    expect(receiptIndex).toBeGreaterThan(-1);
    expect(claimIndex).toBeGreaterThan(receiptIndex);
    expect(providerIndex).toBeGreaterThan(claimIndex);
    expect(confirmation).toMatch(/segments[\s\S]{0,500}?(service_name|serviceName)/);
    expect(confirmation).toMatch(/segments[\s\S]{0,700}?(subtotal_cents|total_cents|totalCents)/);
  });

  it("returns persisted sequence segments through capability-scoped status management", () => {
    expect(capability).toContain("inspect_booking_management_capability_with_sequence");
    expect(capability).toContain("parseBookingSequenceReceipt");
    expect(capability).toMatch(
      /scheduleModel === "segments_v1" && !sequenceReceipt/,
    );
    expect(sequenceMigration).toMatch(
      /inspect_booking_management_capability_with_sequence[\s\S]{0,2200}?load_booking_sequence_receipt/,
    );
    expect(statusRoute).toContain("booking: inspected.inspection.booking");
    expect(confirmRoute).toContain("booking: inspected.inspection.booking");
  });
});
