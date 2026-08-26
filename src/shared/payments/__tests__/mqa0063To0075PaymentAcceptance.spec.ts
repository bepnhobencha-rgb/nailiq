import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBookingPaymentOperationMaterial } from "../bookingPaymentOperations";
import { toProviderMinorAmount } from "../providerMinorUnits";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260820150000_add_authoritative_booking_payment_operations.sql"),
  "utf8",
);
const depositRoute = readFileSync(
  resolve(root, "src/app/api/booking/deposit-intent/route.ts"),
  "utf8",
);
const submitPublicBooking = readFileSync(
  resolve(root, "src/shared/booking/submitPublicBooking.ts"),
  "utf8",
);
const depositPanel = readFileSync(
  resolve(root, "src/components/booking/BookingFlowDepositPanel.tsx"),
  "utf8",
);
const bookingFlowState = readFileSync(
  resolve(root, "src/components/booking/useBookingFlowState.ts"),
  "utf8",
);
const recordDepositRoute = readFileSync(
  resolve(root, "src/app/api/booking/record-deposit/route.ts"),
  "utf8",
);
const depositFinalizeRoute = readFileSync(
  resolve(root, "src/app/api/booking/deposit-finalize/route.ts"),
  "utf8",
);
const depositCreateRoute = readFileSync(
  resolve(root, "src/app/api/booking/deposit-create/route.ts"),
  "utf8",
);
const paymentExecutor = readFileSync(
  resolve(root, "src/shared/payments/executeBookingPaymentOperation.ts"),
  "utf8",
);
const depositRuntime = `${depositRoute}\n${paymentExecutor}`;
const noShowPayments = readFileSync(
  resolve(root, "src/shared/integrations/square/noshow.ts"),
  "utf8",
);
const depositPayments = readFileSync(
  resolve(root, "src/shared/integrations/square/deposits.ts"),
  "utf8",
);

function requirePattern(source: string, pattern: RegExp, message: string) {
  expect(source, message).toMatch(pattern);
}

function forbidPattern(source: string, pattern: RegExp, message: string) {
  expect(source, message).not.toMatch(pattern);
}

function sqlFunction(name: string) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = migration.indexOf(marker);
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf("$function$;", start);
  expect(end, `${name} body must terminate`).toBeGreaterThan(start);
  return migration.slice(start, end + "$function$;".length);
}

describe("MQA-0063..0075 authoritative payment acceptance", () => {
  it("keeps financial truth and every operation RPC service-role only", () => {
    requirePattern(migration, /ALTER TABLE public\.booking_payment_operations ENABLE ROW LEVEL SECURITY;/, "payment ledger must enable RLS");
    requirePattern(migration, /ALTER TABLE public\.booking_payment_operations FORCE ROW LEVEL SECURITY;/, "payment ledger must force RLS");
    requirePattern(migration, /REVOKE ALL ON TABLE public\.booking_payment_operations FROM PUBLIC, anon, authenticated;/, "browser roles must not read or mutate the ledger");
    requirePattern(migration, /REVOKE ALL ON FUNCTION public\.claim_public_deposit_payment_operation\([\s\S]*?FROM PUBLIC, anon, authenticated;/, "public deposit claim must be service-only");
    requirePattern(migration, /REVOKE ALL ON FUNCTION public\.claim_booking_payment_operation\([\s\S]*?FROM PUBLIC, anon, authenticated;/, "booking charge/refund claim must be service-only");
    requirePattern(migration, /REVOKE ALL ON FUNCTION public\.complete_booking_payment_operation\([\s\S]*?FROM PUBLIC, anon, authenticated;/, "provider completion must be service-only");
    requirePattern(migration, /GRANT EXECUTE ON FUNCTION public\.claim_public_deposit_payment_operation\([\s\S]*?TO service_role;/, "service role must own public deposit claims");
  });

  it("separates definite failure from ambiguous provider outcome and never blindly retries unknown", () => {
    requirePattern(migration, /status text NOT NULL[\s\S]*?'failed'[\s\S]*?'unknown'/, "ledger must model failed and unknown separately");
    requirePattern(migration, /p_outcome NOT IN \([^)]*'definite_failure'[^)]*'unknown'[^)]*\)/, "completion contract must distinguish definite failure and unknown");
    requirePattern(migration, /v_existing\.status IN \('pending_provider','unknown'\)[\s\S]*?'reconciliation_required'/, "ordinary replay must not reclaim an ambiguous operation");
    requirePattern(migration, /status IN \('pending_provider','unknown'\)[\s\S]*?next_reconcile_at/, "only durable reconciliation may resume ambiguous provider work");
  });

  it("uses stable logical request and provider keys with tenant/account-scoped unique receipts", () => {
    requirePattern(migration, /UNIQUE INDEX IF NOT EXISTS booking_payment_operations_request_once\s+ON public\.booking_payment_operations\(salon_id, request_id, operation_kind\)/, "logical replay must be tenant and operation scoped");
    requirePattern(migration, /UNIQUE INDEX IF NOT EXISTS booking_payment_operations_payment_receipt_once\s+ON public\.booking_payment_operations\(provider, provider_account_fingerprint, provider_payment_id\)/, "payment receipts must be unique inside the provider account identity");
    requirePattern(migration, /UNIQUE INDEX IF NOT EXISTS booking_payment_operations_refund_receipt_once\s+ON public\.booking_payment_operations\(provider, provider_account_fingerprint, provider_refund_id\)/, "refund receipts must be unique inside the provider account identity");
    requirePattern(migration, /provider_idempotency_key text NOT NULL UNIQUE/, "provider idempotency identity must be persisted and globally unique");
    requirePattern(migration, /provider_idempotency_key[\s\S]{0,160}'[a-z0-9:-]+'\|\|v_id::text/i, "provider key must derive from the durable operation id");
    forbidPattern(migration, /provider_idempotency_key\s*=\s*['"]?nailiq-pay:[^\n]*gen_random_uuid/i, "retry must never rotate provider identity");

    const generatedKey = migration.match(/provider_idempotency_key[\s\S]{0,160}'([a-z0-9:-]+)'\|\|v_id::text/i);
    expect(generatedKey, "generated provider key shape must be statically inspectable").not.toBeNull();
    expect((generatedKey?.[1].length ?? 999) + 36, "provider key must fit Square's strict 45-character boundary").toBeLessThanOrEqual(45);
  });

  it("serializes concurrent claims for the same booking intent and rejects changed material", () => {
    requirePattern(migration, /booking_payment_operations_active_deposit_intent_once\s+ON public\.booking_payment_operations\(salon_id, booking_intent_idempotency_key\)/, "one active deposit may own a canonical booking intent");
    requirePattern(migration, /pg_advisory_xact_lock\([\s\S]{0,180}?p_booking_idempotency_key/, "same-intent claims must serialize before provider ownership");
    requirePattern(migration, /booking_intent_idempotency_key=p_booking_idempotency_key[\s\S]{0,500}?booking_intent_conflict/, "changed material under the same booking intent must fail closed");
    requirePattern(migration, /status IN \('sending','pending_provider','reconciling','unknown','succeeded'\)/, "ambiguous and completed intents must retain ownership");
  });

  it("binds a pre-booking deposit to the exact canonical create/replay intent", () => {
    const atomicCreateAndBind = sqlFunction("create_public_booking_with_deposit_payment");
    requirePattern(migration, /booking_intent_idempotency_key uuid/, "pre-booking deposit must bind the booking create identity");
    requirePattern(migration, /pricing_fingerprint text/, "pre-booking deposit must bind the authoritative price");
    requirePattern(migration, /booking_payment_operations_prebooking_check[\s\S]*?service_id IS NOT NULL[\s\S]*?staff_id IS NOT NULL[\s\S]*?start_time_utc IS NOT NULL[\s\S]*?end_time_utc IS NOT NULL[\s\S]*?client_phone_fingerprint IS NOT NULL/, "unbound deposit material must contain every canonical booking fact");
    requirePattern(migration, /CREATE OR REPLACE FUNCTION public\.bind_public_deposit_payment_operation\(/, "an exact one-way bind RPC must exist");
    requirePattern(migration, /booking_intent_idempotency_key[\s\S]*?pricing_fingerprint[\s\S]*?service_id[\s\S]*?staff_id[\s\S]*?start_time_utc[\s\S]*?end_time_utc[\s\S]*?client_phone_fingerprint/, "bind must compare all canonical material, not only booking id");
    requirePattern(submitPublicBooking, /params\.paidDeposit[\s\S]{0,120}?create_public_booking_with_deposit_payment/, "paid public booking submission must select the atomic create-and-bind RPC");
    requirePattern(atomicCreateAndBind, /v_create:=public\.create_public_booking\([\s\S]{0,1800}?v_bind:=public\.bind_public_deposit_payment_operation\(/, "the service-only wrapper must create canonically and bind the exact completed deposit in the same transaction before success");
    requirePattern(atomicCreateAndBind, /IF coalesce\(\(v_bind->>'success'\)::boolean,false\) IS NOT TRUE THEN[\s\S]{0,180}?RAISE EXCEPTION/, "a failed bind must abort the canonical booking subtransaction rather than acknowledge unbound success");
  });

  it("can finish provider success before booking create, then bind that same receipt exactly once", () => {
    requirePattern(migration, /WHEN v_op\.operation_kind='deposit_charge' AND v_op\.booking_id IS NULL THEN 'succeeded_unbound'[\s\S]{0,180}?ELSE 'succeeded' END/, "provider success before booking creation must remain truthful and recoverable");
    requirePattern(migration, /booking_payment_operations_active_charge_once\s+ON public\.booking_payment_operations\(booking_id,operation_kind\)[\s\S]{0,220}?operation_kind IN \('deposit_charge','noshow_charge'\)/, "one canonical booking may bind only one active/succeeded charge of each kind");
    requirePattern(migration, /deposit_status=CASE WHEN v_op\.status='succeeded' THEN 'paid'/, "binding a succeeded deposit must atomically install paid financial truth");
    requirePattern(migration, /stripe_payment_intent_id=CASE WHEN v_op\.status='succeeded' AND v_op\.provider='stripe' THEN v_op\.provider_payment_id/, "Stripe receipt must come only from the bound ledger operation");
    requirePattern(migration, /square_payment_id=CASE WHEN v_op\.status='succeeded' AND v_op\.provider='square' THEN v_op\.provider_payment_id/, "Square receipt must come only from the bound ledger operation");
  });

  it("makes compensation and binding mutually exclusive even under concurrent requests", () => {
    const bind = sqlFunction("bind_public_deposit_payment_operation");
    const compensation = sqlFunction("claim_unbound_deposit_refund");

    requirePattern(compensation, /WHERE id=p_parent_operation_id AND operation_kind='deposit_charge' FOR UPDATE/, "compensation must lock the parent deposit before deciding it is unbound");
    requirePattern(bind, /WHERE id=p_operation_id AND request_id=p_request_id FOR UPDATE/, "bind must lock the same parent deposit row");
    requirePattern(bind, /parent_operation_id\s*=\s*v_op\.id[\s\S]{0,240}?(?:compensation|refund)/i, "any existing compensation child must permanently block a later bind");
  });

  it("can complete a compensation refund while its paid parent remains unbound", () => {
    const complete = sqlFunction("complete_booking_payment_operation");
    forbidPattern(complete, /v_op\.operation_kind='deposit_refund'[\s\S]{0,180}?v_op\.booking_id IS NULL\s+OR/, "an unbound compensation refund must be completable without a booking row");
    requirePattern(complete, /v_op\.operation_kind='deposit_refund'[\s\S]{0,650}?parent_operation_id/, "unbound refund completion must validate its persisted parent operation instead of caller booking data");
  });

  it("strictly parses DB-owned unbound compensation material without inventing a booking", () => {
    expect(parseBookingPaymentOperationMaterial({
      salon_id: "11111111-1111-4111-8111-111111111111",
      booking_id: null,
      operation_kind: "deposit_refund",
      parent_operation_id: "22222222-2222-4222-8222-222222222222",
      provider: "stripe",
      provider_account_fingerprint: "1e59e91d89464f41b8479bad2bfe3128cbca2b91f536216d1104011941aa2442",
      amount_cents: 2_000,
      currency: "CAD",
      parent_payment_id: "pi_parent123",
      captured_cents: 2_000,
      refunded_cents: 0,
      reserved_cents: 0,
      remaining_refundable_cents: 2_000,
      material_fingerprint: "a".repeat(64),
      provider_material: {
        provider: "stripe",
        provider_account_id: "acct_1",
        provider_location_id: null,
        provider_environment: null,
        currency: "CAD",
        parent_payment_id: "pi_parent123",
      },
    }, "deposit_refund"), "compensation parser must accept only the DB-owned null-booking form")
      .not.toBeNull();
  });

  it("compensates a paid unbound deposit before returning a terminal booking-create failure", () => {
    requirePattern(depositCreateRoute, /code === "booking_create_failed"[\s\S]{0,240}?compensateUnboundDeposit\(db, paymentOperationId, paymentRequestId\)/, "the trusted server create boundary must compensate a paid unbound deposit after terminal canonical create failure");
    requirePattern(depositCreateRoute, /load_unbound_deposit_refund_material[\s\S]{0,1800}?claim_unbound_deposit_refund/, "compensation must load DB-owned parent material before claiming the exact refund");
    requirePattern(depositCreateRoute, /dispatchClaimedBookingPaymentOperation/, "claimed compensation must use the shared durable provider dispatcher");
    requirePattern(depositCreateRoute, /compensation !== "succeeded"[\s\S]{0,220}?deposit_compensation_pending[\s\S]{0,120}?503/, "the route must not report terminal booking failure as settled while compensation remains ambiguous or incomplete");
    requirePattern(paymentExecutor, /complete_booking_payment_operation/, "the shared dispatcher must durably complete provider success/failure or preserve unknown for reconciliation");
  });

  it("discovers and leases paid unbound deposits for crash-safe compensation", () => {
    requirePattern(migration, /CREATE OR REPLACE FUNCTION public\.discover_due_unbound_deposit_compensations\(\s*p_limit integer DEFAULT 25\s*\)/, "unbound paid deposits must remain discoverable after app response/process loss");
    requirePattern(migration, /CREATE OR REPLACE FUNCTION public\.claim_due_unbound_deposit_refund\(\s*p_parent_operation_id uuid,\s*p_lease_token uuid,\s*p_expected_material_fingerprint text\s*\)/, "a worker must lease the exact persisted parent and fingerprint");
    requirePattern(migration, /REVOKE ALL ON FUNCTION public\.discover_due_unbound_deposit_compensations\(integer\)[\s\S]{0,100}?FROM PUBLIC, anon, authenticated/, "compensation discovery must remain service-only");
    requirePattern(migration, /REVOKE ALL ON FUNCTION public\.claim_due_unbound_deposit_refund\(uuid,uuid,text\)[\s\S]{0,100}?FROM PUBLIC, anon, authenticated/, "compensation lease must remain service-only");
  });

  it("has an executable two-session rehearsal for monetary race and replay invariants", () => {
    const securityDir = resolve(root, "scripts/security");
    const candidate = readdirSync(securityDir).find((name) =>
      /booking[-_].*payment[-_].*operation.*concurren/i.test(name) ||
      /payment[-_].*operation.*concurren/i.test(name)
    );
    expect(candidate, "missing fresh-Postgres payment-operation concurrency rehearsal").toBeTruthy();
    const rehearsal = readFileSync(resolve(securityDir, candidate as string), "utf8");
    requirePattern(rehearsal, /booking[_ -]?intent|same[_ -]?intent/i, "rehearsal must race the same pre-booking deposit intent");
    requirePattern(rehearsal, /provider[_ -]?idempotency[_ -]?key/i, "same-intent replay must prove one stable provider key");
    requirePattern(rehearsal, /bind_public_deposit_payment_operation/, "rehearsal must execute canonical binding");
    requirePattern(rehearsal, /claim_unbound_deposit_refund/, "rehearsal must race compensation against binding");
    requirePattern(rehearsal, /partial|refund_amount_exceeds_remaining|remaining_refundable/i, "rehearsal must prove concurrent cumulative refund bounds");
    const paymentProof = readdirSync(securityDir)
      .filter((name) => /booking[-_].*payment[-_].*operation/i.test(name))
      .map((name) => readFileSync(resolve(securityDir, name), "utf8"))
      .join("\n");
    requirePattern(paymentProof, /authenticated/i, "focused payment gates must prove browser roles cannot mutate financial truth");
  });

  it("requires a valid final provider receipt and classifies expired cards as definite failure", () => {
    requirePattern(migration, /provider_receipt_required/, "success without a provider receipt must fail closed");
    requirePattern(migration, /provider_status_not_final/, "non-final provider states must not become succeeded");
    requirePattern(migration, /v_payment !~ '\^pi_/, "Stripe payment receipts must be shape-validated");
    requirePattern(migration, /v_refund !~ '\^re_/, "Stripe refund receipts must be shape-validated");
    requirePattern(migration, /v_error NOT IN \('card_declined','expired_card','insufficient_funds'/, "expired/declined cards must be explicit definite failures");
    requirePattern(migration, /provider_timeout'[\s\S]{0,180}?'provider_outcome_ambiguous'/, "transport/response-loss outcomes must remain unknown");
  });

  it("reserves cumulative full/partial refunds atomically and rejects over-refund", () => {
    requirePattern(migration, /SELECT \* INTO v_booking FROM public\.bookings[\s\S]{0,180}?FOR UPDATE/, "refund material must lock the authoritative booking counters");
    requirePattern(migration, /status IN \('sending','pending_provider','reconciling','unknown'\)/, "in-flight and ambiguous refunds must reserve their amount");
    requirePattern(migration, /v_remaining := greatest\(0,v_captured-v_refunded-v_reserved\)/, "remaining refundable amount must subtract both completed and reserved refunds");
    requirePattern(migration, /'refund_amount_exceeds_remaining'/, "over-refund must fail before provider dispatch");
    requirePattern(migration, /v_new_refunded\s*:=\s*coalesce\(v_booking\.deposit_refunded_cents[\s\S]{0,300}?deposit_refunded_cents=v_new_refunded/, "deposit refund completion must atomically advance its cumulative counter");
    requirePattern(migration, /v_new_refunded\s*:=\s*coalesce\(v_booking\.noshow_refunded_cents[\s\S]{0,300}?noshow_refunded_cents=v_new_refunded/, "no-show refund completion must atomically advance its cumulative counter");
  });

  it("protects provider-owned booking financial fields from authenticated direct writes", () => {
    requirePattern(migration, /CREATE OR REPLACE FUNCTION public\.protect_booking_provider_financial_truth\(\)/, "financial truth guard trigger function must exist");
    requirePattern(migration, /current_setting\('request\.jwt\.claim\.role'[\s\S]{0,220}?NOT IN \('anon','authenticated'\)/, "browser JWT roles must be denied while trusted server/database execution remains possible");
    requirePattern(migration, /CREATE TRIGGER[\s\S]*?protect_booking_provider_financial_truth/, "the financial truth guard must be installed on bookings");
    requirePattern(migration, /stripe_payment_intent_id[\s\S]{0,220}?square_payment_id[\s\S]{0,220}?deposit_refunded_cents[\s\S]{0,700}?noshow_payment_id[\s\S]{0,220}?noshow_refunded_cents/, "guard must cover charge receipts, states, and refund counters");
  });

  it("requires a bounded same-origin, durably rate-limited public deposit boundary", () => {
    requirePattern(depositRoute, /isSameOriginMutation/, "deposit POST must reject cross-site browser mutations before DB/provider work");
    requirePattern(depositRoute, /readJsonObjectWithLimit/, "deposit POST must cap actual streamed bytes even without Content-Length");
    requirePattern(depositRoute, /rate_limit_hit/, "deposit POST must use a durable database rate limiter");
    requirePattern(depositRoute, /claim_public_deposit_payment_operation/, "deposit POST must claim DB-owned canonical payment material before provider dispatch");
    requirePattern(depositRuntime, /providerIdempotencyKey|provider_idempotency_key/, "provider dispatch must receive the durable operation idempotency key");
    requirePattern(depositRuntime, /complete_booking_payment_operation/, "every provider outcome must be durably completed or marked ambiguous");
    forbidPattern(depositRoute, /evaluateDeposit/, "route must not maintain a second deposit/pricing resolver");
  });

  it("preserves internal smallest-unit money without a second zero-decimal conversion", () => {
    expect(toProviderMinorAmount(2_500, "CAD")).toBe(2_500);
    expect(toProviderMinorAmount(250_000, "VND")).toBe(250_000);
    requirePattern(depositRoute, /toProviderMinorAmount\(/, "provider payload must use the shared smallest-unit identity helper");
    forbidPattern(depositRoute, /ZERO_DECIMAL|amountCents\s*\/\s*100/, "deposit route must never reinterpret DB cents/minor units by currency");
  });

  it("meters public deposit work by IP plus DB-authorized salon, phone, and booking intent", () => {
    requirePattern(depositRoute, /hashedMeter\("ip"[\s\S]{0,180}?12,\s*300[\s\S]{0,180}?hashedMeter\("ip-hour"[\s\S]{0,180}?60,\s*3_600/, "route must durably meter IP burst/hour abuse");
    requirePattern(depositRoute, /hashedMeter\("salon"[\s\S]{0,100}?30,\s*600[\s\S]{0,180}?hashedMeter\("salon-day"[\s\S]{0,100}?120,\s*86_400/, "route must meter the DB-authorized salon burst/day, not a caller-only tenant label");
    requirePattern(depositRoute, /hashedMeter\("phone",\s*material\.clientPhoneFingerprint\)/, "route must meter a canonical hashed phone/customer identity");
    requirePattern(depositRoute, /hashedMeter\("intent",\s*`\$\{material\.bookingIdempotencyKey\}:\$\{material\.pricingFingerprint\}`\)/, "route must meter stable canonical booking intent independently of payment request rotation");
    const loadAt = depositRoute.indexOf("load_public_deposit_payment_material");
    const salonMeterAt = depositRoute.indexOf("applyMaterialMeters(db, material)", loadAt);
    expect(loadAt, "DB-owned deposit material must authorize salon/customer/intent meters").toBeGreaterThanOrEqual(0);
    expect(salonMeterAt, "authorized salon meter must exist").toBeGreaterThan(loadAt);
    forbidPattern(depositRoute, /p_key:\s*[^\n]*(?:clientPhone|bookingRequestId|paymentRequestId)\b(?![\s\S]{0,80}(?:hash|digest))/i, "rate keys must not store raw customer or intent identifiers");
  });

  it("validates but does not consume the salon-bound OTP session before taking a deposit", () => {
    requirePattern(depositRoute, /otpSessionId/, "deposit request must carry the already-verified OTP session");
    requirePattern(depositRoute, /phone_otp_enabled/, "OTP enforcement must come from the authoritative salon row");
    requirePattern(depositRoute, /validate_phone_otp_session/, "deposit route must validate session, salon, and canonical phone together");
    const validateAt = depositRoute.indexOf("validate_phone_otp_session");
    const materialAt = depositRoute.indexOf("claim_public_deposit_payment_operation");
    expect(validateAt, "OTP validation must exist").toBeGreaterThanOrEqual(0);
    expect(materialAt, "canonical deposit claim must exist").toBeGreaterThan(validateAt);
    forbidPattern(depositRoute, /consume-session|consumed_at\s*[:=]|\.from\("phone_otp_sessions"[\s\S]{0,200}?\.update\(/, "deposit preparation must leave the session unconsumed for canonical booking create/bind");
  });

  it("does not redispatch provider work when request IDs rotate or provider response is lost", () => {
    requirePattern(depositRoute, /attempt_replay|customer_confirmation_pending/, "same logical request must recover its persisted operation instead of minting another");
    requirePattern(depositRoute, /resume_public_deposit_customer_confirmation/, "rotated transport retry may only resume the exact stored provider intent through the DB-owned boundary");
    requirePattern(depositRoute, /intent_in_flight|in_flight/, "concurrent same-intent work must not dispatch a second provider call");
    requirePattern(depositRoute, /reconciliation_required/, "pending/unknown provider outcomes must reconcile instead of blind retry");
    requirePattern(depositRuntime, /provider_outcome_unknown|provider_response_lost|provider_transport_error/, "transport/response loss must be completed as unknown");
    forbidPattern(depositRuntime, /idempotencyKey:\s*(?:body\.|paymentRequestId|crypto\.randomUUID|randomUUID\()/, "provider key must come only from the durable claim envelope");
  });

  it("sends the complete canonical booking intent to the pre-booking deposit boundary", () => {
    for (const fact of [
      "staffId",
      "startTimeUtc",
      "endTimeUtc",
      "addonServiceIds",
      "bookingRequestId",
      "paymentRequestId",
      "expectedPricingFingerprint",
    ]) {
      requirePattern(depositPanel, new RegExp(`\\b${fact}\\b`), `deposit UI is missing canonical ${fact}`);
    }
    requirePattern(depositPanel, /const canonicalRequest[\s\S]{0,900}?bookingRequestId,[\s\S]{0,160}?expectedPricingFingerprint:\s*pricingQuote\.pricingFingerprint/, "deposit request must bind the stable create identity to the exact quote");
    requirePattern(depositPanel, /fetch\("\/api\/booking\/deposit-intent"[\s\S]{0,260}?body:\s*JSON\.stringify\(\{[\s\S]{0,180}?\.\.\.canonicalRequest,[\s\S]{0,160}?paymentRequestId:\s*identity\.paymentRequestId/, "deposit request must send the complete canonical material and retained payment request id");
    requirePattern(depositPanel, /stablePublicDepositReplayIdentity\([\s\S]{0,180}?bookingRequestId/, "one logical booking/deposit intent must retain stable create and payment request IDs across retry");
  });

  it("finalizes the DB-owned provider result before onPaid or canonical booking create", () => {
    const confirmAt = depositPanel.indexOf("stripe.confirmPayment");
    const finalizeAt = depositPanel.indexOf('fetch("/api/booking/deposit-finalize"');
    const paidAt = depositPanel.indexOf("onPaid({", finalizeAt);
    expect(confirmAt, "browser provider confirmation must exist").toBeGreaterThanOrEqual(0);
    expect(finalizeAt, "server-owned finalization must exist").toBeGreaterThan(confirmAt);
    expect(paidAt, "onPaid may run only after server finalization").toBeGreaterThan(finalizeAt);
    requirePattern(depositFinalizeRoute, /claim_public_deposit_finalization/, "server route must atomically claim exact finalization ownership");
    requirePattern(depositFinalizeRoute, /complete_booking_payment_operation/, "server route must persist provider truth before returning paid");
    requirePattern(bookingFlowState, /PaidPublicDeposit|depositOperationId|paymentRequestId[\s\S]{0,500}?materialFingerprint/, "confirmed deposit proof must be retained until canonical create/bind");
    forbidPattern(bookingFlowState, /onPaid[\s\S]{0,180}?paymentIntentId[\s\S]{0,180}?connectedAccountId/, "browser state must not treat raw provider IDs as financial proof");
  });

  it("binds finalization capability to one operation and payment request and rejects rotated replay", () => {
    const finalizeClaim = sqlFunction("claim_public_deposit_finalization");
    requirePattern(finalizeClaim, /WHERE id=p_operation_id AND request_id=p_request_id/, "finalization must bind the operation to its original payment request");
    requirePattern(depositFinalizeRoute, /p_operation_id:\s*operationId[\s\S]{0,120}?p_request_id:\s*requestId[\s\S]{0,120}?p_finalize_token:\s*finalizeToken/, "finalization route must pass all three exact capability facts to the atomic claim");
    requirePattern(depositRoute, /customer_confirmation_pending/, "same-request pending-customer replay may recover its deterministic capability");
    forbidPattern(depositRoute, /\["customer_confirmation_pending",\s*"intent_replay"\][\s\S]{0,1600}?derivePublicDepositFinalizeToken\(operationId,\s*paymentRequestId\)/, "a rotated request must not mint a token the persisted operation can never accept");
  });

  it("retires the naked post-create record-deposit mutation", () => {
    forbidPattern(bookingFlowState, /fetch\("\/api\/booking\/record-deposit"/, "browser must not attach a provider receipt to a caller-selected booking id");
    requirePattern(recordDepositRoute, /status:\s*(?:404|410)/, "legacy naked record-deposit route must be inert after canonical bind adoption");
    forbidPattern(recordDepositRoute, /\.from\("bookings" as never\)[\s\S]{0,120}?\.update\(/, "legacy route must not directly stamp provider financial truth");
  });

  it("routes no-show charge through the shared durable claim/completion boundary", () => {
    requirePattern(noShowPayments, /runAuthoritativeBookingPaymentOperation/, "no-show charge must delegate to the authoritative payment executor");
    requirePattern(paymentExecutor, /claim_booking_payment_operation/, "shared executor must claim authoritative material before provider dispatch");
    requirePattern(paymentExecutor, /complete_booking_payment_operation/, "shared executor must persist the exact provider outcome");
  });

  it("removes legacy direct deposit refund paths that bypass the durable ledger", () => {
    requirePattern(depositPayments, /runAuthoritativeBookingPaymentOperation\(\{[\s\S]{0,500}?operationKind:\s*"deposit_refund"/, "deposit refunds must delegate to the authoritative durable executor with the exact operation kind");
    requirePattern(paymentExecutor, /load_booking_payment_operation_material[\s\S]{0,1200}?claim_booking_payment_operation/, "the shared refund executor must load and claim authoritative material before provider dispatch");
    requirePattern(paymentExecutor, /complete_booking_payment_operation/, "the shared refund executor must persist the exact provider outcome in the durable ledger");
    forbidPattern(depositPayments, /\brefundPayment\s*\(/, "the legacy deposit caller must not dispatch a provider refund outside the durable executor");
    forbidPattern(depositPayments, /refundPayment\([\s\S]*?\.from\("bookings"\)\.update\(\{ deposit_status: "refunded" \}\)/, "provider refund then best-effort booking update is response-loss unsafe");
  });
});
