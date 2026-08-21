import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getStripeClient } from "@/shared/lib/stripe";
import {
  parseClaimedPublicDepositPaymentOperation,
  parsePublicDepositPaymentMaterial,
  type ClaimedPublicDepositPaymentOperation,
} from "@/shared/payments/bookingPaymentOperations";
import {
  derivePublicDepositFinalizeToken,
  derivePublicSquareDepositCapabilityToken,
} from "@/shared/payments/publicDepositFinalizeCapability";
import { toProviderMinorAmount } from "@/shared/payments/providerMinorUnits";
import {
  chargeCardToken,
  getSquareConfig,
} from "@/shared/integrations/square/client";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

type Body = {
  salonId?: string;
  serviceId?: string;
  staffId?: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  addonServiceIds?: unknown;
  comboId?: string | null;
  voucherId?: string | null;
  clientPhone?: string;
  clientEmail?: string | null;
  applyEmailDiscount?: boolean;
  bookingRequestId?: string;
  paymentRequestId?: string;
  expectedPricingFingerprint?: string;
  otpSessionId?: string | null;
  squareSourceToken?: string;
  squareCapabilityToken?: string;
  operationId?: string;
};

type Db = ReturnType<typeof createServiceRoleClient>;

function clean(value: unknown, max = 255): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullableUuid(value: unknown): string | null | undefined {
  if (value == null || value === "") return null;
  const parsed = clean(value, 36);
  return UUID_RE.test(parsed) ? parsed : undefined;
}

function noStore(status: number, payload: Record<string, unknown>) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function meter(
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<"allowed" | "blocked" | "unavailable"> {
  try {
    const { data, error } = await db.rpc("rate_limit_hit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error || typeof data !== "boolean") return "unavailable";
    return data ? "allowed" : "blocked";
  } catch {
    return "unavailable";
  }
}

function hashedMeter(scope: string, material: string): string {
  return `public-deposit-intent:${scope}:${createHash("sha256")
    .update(material, "utf8")
    .digest("hex")}`;
}

async function applyMeter(
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
) {
  const result = await meter(db, key, limit, windowSeconds);
  if (result === "unavailable") {
    return noStore(503, { error: "deposit_unavailable" });
  }
  if (result === "blocked") {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(windowSeconds),
        },
      },
    );
  }
  return null;
}

function rpcRow(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

async function completeUnknown(db: Db, claim: ClaimedPublicDepositPaymentOperation) {
  try {
    await db.rpc("complete_booking_payment_operation", {
      p_operation_id: claim.operationId,
      p_attempt_token: claim.attemptToken,
      p_outcome: "unknown",
      p_provider_status: null,
      p_provider_payment_id: null,
      p_provider_refund_id: null,
      p_error_code: "provider_transport_error",
    });
  } catch {
    // The operation and provider key remain reserved for exact reconciliation.
  }
}

async function prepareStripeIntent(
  db: Db,
  claim: ClaimedPublicDepositPaymentOperation,
  paymentRequestId: string,
) {
  const stripe = getStripeClient();
  const publishableKey = clean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, 255);
  if (!stripe || !publishableKey || claim.material.provider !== "stripe") {
    await completeUnknown(db, claim);
    return noStore(503, { error: "deposit_unavailable" });
  }
  let intent: Awaited<ReturnType<typeof stripe.paymentIntents.create>>;
  try {
    intent = await stripe.paymentIntents.create(
      {
        amount: toProviderMinorAmount(
          claim.material.amountCents,
          claim.material.currency,
        ),
        currency: claim.material.currency.toLowerCase(),
        description: "Booking deposit",
        metadata: {
          salon_id: claim.material.salonId,
          booking_intent: claim.material.bookingIdempotencyKey,
          operation_id: claim.operationId,
        },
      },
      {
        stripeAccount: claim.material.providerMaterial.providerAccountId,
        idempotencyKey: claim.providerIdempotencyKey,
      },
    );
  } catch {
    await completeUnknown(db, claim);
    return noStore(503, { error: "deposit_unavailable" });
  }

  const finalizeToken = derivePublicDepositFinalizeToken(
    claim.operationId,
    paymentRequestId,
  );
  const clientSecret = clean(intent.client_secret, 512);
  const providerPaymentId = clean(intent.id, 255);
  if (
    !clientSecret || !providerPaymentId ||
    !["requires_payment_method", "requires_action"].includes(intent.status)
  ) {
    await completeUnknown(db, claim);
    return noStore(503, { error: "deposit_unavailable" });
  }
  let attached: { data: unknown; error: unknown };
  try {
    attached = await db.rpc("attach_public_deposit_provider_intent", {
      p_operation_id: claim.operationId,
      p_attempt_token: claim.attemptToken,
      p_provider_payment_id: providerPaymentId,
      p_provider_status: intent.status,
      p_finalize_token: finalizeToken,
    });
  } catch {
    return noStore(503, { error: "deposit_unavailable" });
  }
  const attachedRow = rpcRow(attached.data);
  if (
    attached.error || attachedRow?.success !== true ||
    !["intent_attached", "intent_attach_replay"].includes(String(attachedRow.code ?? ""))
  ) {
    return noStore(503, { error: "deposit_unavailable" });
  }
  return noStore(200, {
    required: true,
    provider: "stripe",
    clientSecret,
    paymentIntentId: providerPaymentId,
    operationId: claim.operationId,
    paymentRequestId,
    materialFingerprint: claim.material.materialFingerprint,
    finalizeToken,
    connectedAccountId: claim.material.providerMaterial.providerAccountId,
    publishableKey,
    amountCents: claim.material.amountCents,
    currency: claim.material.currency,
  });
}

async function issueSquarePaymentCapability(
  db: Db,
  claim: ClaimedPublicDepositPaymentOperation,
  paymentRequestId: string,
) {
  if (claim.material.provider !== "square") {
    return noStore(503, { error: "deposit_unavailable" });
  }
  const capabilityToken = derivePublicSquareDepositCapabilityToken(
    claim.operationId,
    paymentRequestId,
  );
  let issued: { data: unknown; error: unknown };
  try {
    issued = await db.rpc("issue_public_square_deposit_capability", {
      p_operation_id: claim.operationId,
      p_request_id: paymentRequestId,
      p_attempt_token: claim.attemptToken,
      p_capability_token: capabilityToken,
    });
  } catch {
    return noStore(503, { error: "deposit_unavailable" });
  }
  const row = rpcRow(issued.data);
  const applicationId = clean(row?.square_application_id, 255);
  const locationId = clean(row?.square_location_id, 255);
  const environment = row?.square_environment === "sandbox" ||
      row?.square_environment === "production"
    ? row.square_environment
    : null;
  const expiresAt = clean(row?.capability_expires_at, 64);
  if (
    issued.error || row?.success !== true ||
    !["capability_issued", "capability_replay"].includes(String(row.code ?? "")) ||
    row.operation_id !== claim.operationId || row.capability_token !== capabilityToken ||
    row.material_fingerprint !== claim.material.materialFingerprint ||
    row.amount_cents !== claim.material.amountCents || row.currency !== claim.material.currency ||
    applicationId !== claim.material.providerMaterial.providerApplicationId ||
    locationId !== claim.material.providerMaterial.providerLocationId ||
    environment !== claim.material.providerMaterial.providerEnvironment ||
    !expiresAt || !Number.isFinite(Date.parse(expiresAt))
  ) return noStore(503, { error: "deposit_unavailable" });
  return noStore(200, {
    required: true,
    provider: "square",
    squareApplicationId: applicationId,
    squareLocationId: locationId,
    squareEnvironment: environment,
    squareCapabilityToken: capabilityToken,
    operationId: claim.operationId,
    paymentRequestId,
    materialFingerprint: claim.material.materialFingerprint,
    amountCents: claim.material.amountCents,
    currency: claim.material.currency,
  });
}

function parseSquareCompletionClaim(
  value: unknown,
  expectedOperationId: string,
): ClaimedPublicDepositPaymentOperation | null {
  const row = rpcRow(value);
  if (
    row?.success !== true ||
    !["square_payment_claimed", "square_payment_attempt_replay"].includes(String(row.code ?? "")) ||
    row.status !== "sending" || row.operation_id !== expectedOperationId
  ) return null;
  const attemptToken = clean(row.attempt_token, 36);
  const providerIdempotencyKey = clean(row.provider_idempotency_key, 128);
  const leaseExpiresAt = clean(row.lease_expires_at, 64);
  const materialFingerprint = clean(row.material_fingerprint, 64);
  const material = parsePublicDepositPaymentMaterial(row.material, materialFingerprint);
  if (
    !UUID_RE.test(attemptToken) || providerIdempotencyKey !== `nq:${expectedOperationId}` ||
    !leaseExpiresAt || !Number.isFinite(Date.parse(leaseExpiresAt)) || !material ||
    material.provider !== "square"
  ) return null;
  return {
    operationId: expectedOperationId,
    attemptToken,
    providerIdempotencyKey,
    leaseExpiresAt,
    attemptCount: 1,
    material,
  };
}

async function applyMaterialMeters(db: Db, material: ClaimedPublicDepositPaymentOperation["material"]) {
  for (const [key, limit, seconds] of [
    [hashedMeter("salon", material.salonId), 30, 600],
    [hashedMeter("salon-day", material.salonId), 120, 86_400],
    [hashedMeter("phone", material.clientPhoneFingerprint), 10, 3_600],
    [hashedMeter("intent", `${material.bookingIdempotencyKey}:${material.pricingFingerprint}`), 6, 3_600],
  ] as const) {
    const blocked = await applyMeter(db, key, limit, seconds);
    if (blocked) return blocked;
  }
  return null;
}

async function completeSquarePaymentCapability(
  db: Db,
  input: {
    operationId: string;
    paymentRequestId: string;
    capabilityToken: string;
    sourceToken: string;
  },
) {
  let claimed: { data: unknown; error: unknown };
  try {
    claimed = await db.rpc("claim_public_square_deposit_completion", {
      p_operation_id: input.operationId,
      p_request_id: input.paymentRequestId,
      p_capability_token: input.capabilityToken,
    });
  } catch {
    return noStore(503, { error: "deposit_unavailable" });
  }
  const row = rpcRow(claimed.data);
  if (claimed.error) return noStore(503, { error: "deposit_unavailable" });
  if (
    row?.success === true && row.code === "operation_replay" &&
    row.status === "succeeded" && row.operation_id === input.operationId &&
    HASH_RE.test(clean(row.material_fingerprint, 64))
  ) {
    return noStore(200, {
      required: true,
      paymentCompleted: true,
      operationId: input.operationId,
      paymentRequestId: input.paymentRequestId,
      materialFingerprint: row.material_fingerprint,
    });
  }
  const claim = parseSquareCompletionClaim(claimed.data, input.operationId);
  if (!claim) {
    return noStore(
      row?.code === "reconciliation_required" ? 503 : 400,
      { error: row?.code === "reconciliation_required" ? "deposit_pending" : "deposit_unavailable" },
    );
  }
  const blocked = await applyMaterialMeters(db, claim.material);
  if (blocked) return blocked;

  let receipt: { paymentId: string; status: string };
  try {
    const cfg = await getSquareConfig(db as never, claim.material.salonId);
    if (
      cfg.merchantId !== claim.material.providerMaterial.providerAccountId ||
      cfg.locationId !== claim.material.providerMaterial.providerLocationId ||
      cfg.environment !== claim.material.providerMaterial.providerEnvironment ||
      cfg.currency !== claim.material.currency
    ) throw new Error("square_provider_account_mismatch");
    receipt = await chargeCardToken(cfg, {
      sourceId: input.sourceToken,
      amountCents: toProviderMinorAmount(
        claim.material.amountCents,
        claim.material.currency,
      ),
      idempotencyKey: claim.providerIdempotencyKey,
      referenceId: claim.material.bookingIdempotencyKey,
    });
  } catch {
    await completeUnknown(db, claim);
    return noStore(503, { error: "deposit_pending" });
  }
  const normalized = receipt.status.toUpperCase();
  const outcome = normalized === "COMPLETED"
    ? "succeeded"
    : ["PENDING", "OPEN", "APPROVED"].includes(normalized)
      ? "pending_provider"
      : "definite_failure";
  const completed = await db.rpc("complete_booking_payment_operation", {
    p_operation_id: claim.operationId,
    p_attempt_token: claim.attemptToken,
    p_outcome: outcome,
    p_provider_status: receipt.status,
    p_provider_payment_id: receipt.paymentId,
    p_provider_refund_id: null,
    p_error_code: outcome === "definite_failure" ? "provider_rejected" : null,
  });
  const completedRow = rpcRow(completed.data);
  if (
    completed.error || outcome !== "succeeded" || completedRow?.success !== true ||
    !["succeeded", "completion_replay"].includes(String(completedRow.code ?? ""))
  ) return noStore(outcome === "definite_failure" ? 402 : 503, { error: "deposit_pending" });
  return noStore(200, {
    required: true,
    paymentCompleted: true,
    operationId: claim.operationId,
    paymentRequestId: input.paymentRequestId,
    materialFingerprint: claim.material.materialFingerprint,
  });
}

export async function POST(req: Request) {
  if (!isSameOriginMutation(req)) return noStore(403, { error: "forbidden" });
  if (req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return noStore(400, { error: "bad_request" });
  }
  const parsedBody = await readJsonObjectWithLimit(req, 16_384);
  if (!parsedBody) return noStore(400, { error: "bad_request" });
  const body = parsedBody as Body;
  const squareSourceToken = clean(body.squareSourceToken, 255);
  const squareCapabilityToken = clean(body.squareCapabilityToken, 256);
  const requestedOperationId = clean(body.operationId, 36);
  if (body.squareSourceToken !== undefined && (!squareSourceToken || squareSourceToken.length < 10)) {
    return noStore(400, { error: "bad_request" });
  }

  const db = createServiceRoleClient();
  const forwarded = req.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  const ip = forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
  const ipBlocked = await applyMeter(db, hashedMeter("ip", ip), 12, 300);
  if (ipBlocked) return ipBlocked;
  const ipHourlyBlocked = await applyMeter(db, hashedMeter("ip-hour", ip), 60, 3_600);
  if (ipHourlyBlocked) return ipHourlyBlocked;

  // Square stage two is authorized by the short-lived DB-bound capability.
  // It deliberately does not re-read mutable pricing/OTP state or accept any
  // browser money/account fields after the card token has been created.
  if (squareSourceToken) {
    const paymentRequestId = clean(body.paymentRequestId, 36);
    if (
      !UUID_RE.test(requestedOperationId) || !UUID_RE.test(paymentRequestId) ||
      squareCapabilityToken.length < 32
    ) return noStore(400, { error: "bad_request" });
    return completeSquarePaymentCapability(db, {
      operationId: requestedOperationId,
      paymentRequestId,
      capabilityToken: squareCapabilityToken,
      sourceToken: squareSourceToken,
    });
  }
  if (body.squareCapabilityToken !== undefined || body.operationId !== undefined) {
    return noStore(400, { error: "bad_request" });
  }

  const salonId = clean(body.salonId, 36);
  const serviceId = clean(body.serviceId, 36);
  const staffId = clean(body.staffId, 36);
  const startTimeUtc = clean(body.startTimeUtc, 64);
  const endTimeUtc = clean(body.endTimeUtc, 64);
  const bookingRequestId = clean(body.bookingRequestId, 36);
  const paymentRequestId = clean(body.paymentRequestId, 36);
  const expectedPricingFingerprint = clean(body.expectedPricingFingerprint, 64);
  const clientPhone = clean(body.clientPhone, 32);
  const clientEmail = body.clientEmail == null ? null : clean(body.clientEmail, 254);
  const comboId = nullableUuid(body.comboId);
  const voucherId = nullableUuid(body.voucherId);
  const addonServiceIds = Array.isArray(body.addonServiceIds)
    ? body.addonServiceIds.map((value) => clean(value, 36))
    : [];
  if (
    ![salonId, serviceId, staffId, bookingRequestId, paymentRequestId].every((id) => UUID_RE.test(id)) ||
    !startTimeUtc || !endTimeUtc || !Number.isFinite(Date.parse(startTimeUtc)) ||
    !Number.isFinite(Date.parse(endTimeUtc)) || Date.parse(endTimeUtc) <= Date.parse(startTimeUtc) ||
    !HASH_RE.test(expectedPricingFingerprint) || !clientPhone ||
    comboId === undefined || voucherId === undefined || addonServiceIds.length > 20 ||
    addonServiceIds.some((id) => !UUID_RE.test(id)) ||
    (clientEmail !== null && (!clientEmail || !clientEmail.includes("@")))
  ) return noStore(400, { error: "bad_request" });

  const { data: salon, error: salonError } = await db
    .from("salons" as never)
    .select("id, phone_otp_enabled")
    .eq("id", salonId)
    .maybeSingle();
  const salonRow = salon as { id?: string; phone_otp_enabled?: boolean | null } | null;
  if (salonError || salonRow?.id !== salonId) {
    return noStore(503, { error: "deposit_unavailable" });
  }
  if (salonRow.phone_otp_enabled === true) {
    const otpSessionId = clean(body.otpSessionId, 36);
    if (!UUID_RE.test(otpSessionId)) return noStore(401, { error: "deposit_not_authorized" });
    try {
      const { data: otpValid, error: otpError } = await db.rpc(
        "validate_phone_otp_session",
        { p_session_id: otpSessionId, p_salon_id: salonId, p_phone: clientPhone },
      );
      if (otpError || otpValid !== true) {
        return noStore(401, { error: "deposit_not_authorized" });
      }
    } catch {
      return noStore(503, { error: "deposit_unavailable" });
    }
  }

  const canonicalArgs = {
    p_salon_id: salonId,
    p_service_id: serviceId,
    p_staff_id: staffId,
    p_start_time_utc: startTimeUtc,
    p_end_time_utc: endTimeUtc,
    p_addon_service_ids: addonServiceIds,
    p_combo_id: comboId,
    p_voucher_id: voucherId,
    p_client_phone: clientPhone,
    p_client_email: clientEmail,
    p_apply_email_discount: body.applyEmailDiscount === true,
    p_booking_idempotency_key: bookingRequestId,
    p_expected_pricing_fingerprint: expectedPricingFingerprint,
  };
  let loaded: { data: unknown; error: unknown };
  try {
    loaded = await db.rpc("load_public_deposit_payment_material", canonicalArgs);
  } catch {
    return noStore(503, { error: "deposit_unavailable" });
  }
  const loadedRow = rpcRow(loaded.data);
  if (loaded.error) return noStore(503, { error: "deposit_unavailable" });
  let material = parsePublicDepositPaymentMaterial(
    loadedRow?.material,
    clean(loadedRow?.material_fingerprint, 64),
  );
  let preclaimed: { data: unknown; error: unknown } | null = null;
  if (
    loadedRow?.success !== true || loadedRow.code !== "material_loaded" || !material ||
    material.salonId !== salonId || material.serviceId !== serviceId ||
    material.staffId !== staffId || material.bookingIdempotencyKey !== bookingRequestId ||
    material.pricingFingerprint !== expectedPricingFingerprint
  ) {
    // Live pricing/provider material may drift after a provider response was
    // lost. Ask the replay-first DB claim for this exact request; it can return
    // only persisted matching material or a failure, never a new operation when
    // the live resolver above failed.
    try {
      preclaimed = await db.rpc("claim_public_deposit_payment_operation", {
        ...canonicalArgs,
        p_request_id: paymentRequestId,
      });
    } catch {
      return noStore(503, { error: "deposit_unavailable" });
    }
    const persisted = rpcRow(preclaimed.data);
    if (
      !preclaimed.error && persisted?.success === false &&
      persisted.code === "deposit_not_required"
    ) return noStore(200, { required: false });
    const persistedMaterial = parsePublicDepositPaymentMaterial(
      persisted?.material,
      clean(persisted?.material_fingerprint, 64),
    );
    if (
      preclaimed.error || !persistedMaterial ||
      persistedMaterial.salonId !== salonId ||
      persistedMaterial.bookingIdempotencyKey !== bookingRequestId ||
      ![
        "attempt_replay",
        "customer_confirmation_pending",
        "operation_replay",
        "reconciliation_required",
        "in_flight",
      ].includes(String(persisted?.code ?? ""))
    ) return noStore(503, { error: "deposit_unavailable" });
    material = persistedMaterial;
  }

  const materialBlocked = await applyMaterialMeters(db, material);
  if (materialBlocked) return materialBlocked;

  let claimed: { data: unknown; error: unknown };
  if (preclaimed) claimed = preclaimed;
  else try {
    claimed = await db.rpc("claim_public_deposit_payment_operation", {
      ...canonicalArgs,
      p_request_id: paymentRequestId,
    });
  } catch {
    return noStore(503, { error: "deposit_unavailable" });
  }
  if (claimed.error) return noStore(503, { error: "deposit_unavailable" });
  let claim = parseClaimedPublicDepositPaymentOperation(claimed.data);
  const claimRow = rpcRow(claimed.data);
  if (
    !claim &&
    ["reconciliation_required", "in_flight", "intent_in_flight"].includes(String(claimRow?.code ?? ""))
  ) {
    const operationId = clean(claimRow?.operation_id, 36);
    if (!UUID_RE.test(operationId)) return noStore(503, { error: "deposit_unavailable" });
    try {
      const reconciled = await db.rpc("claim_booking_payment_operation_reconciliation", {
        p_operation_id: operationId,
        p_request_id: paymentRequestId,
        p_expected_material_fingerprint: material.materialFingerprint,
      });
      if (reconciled.error) return noStore(503, { error: "deposit_unavailable" });
      claim = parseClaimedPublicDepositPaymentOperation(reconciled.data);
    } catch {
      return noStore(503, { error: "deposit_unavailable" });
    }
  }
  if (claim) {
    return claim.material.provider === "square"
      ? issueSquarePaymentCapability(db, claim, paymentRequestId)
      : prepareStripeIntent(db, claim, paymentRequestId);
  }

  if (
    claimRow?.success === true &&
    claimRow.code === "customer_confirmation_pending" &&
    claimRow.status === "pending_customer"
  ) {
    const operationId = clean(claimRow.operation_id, 36);
    const providerPaymentId = clean(claimRow.provider_payment_id, 255);
    const replayMaterial = parsePublicDepositPaymentMaterial(
      claimRow.material,
      clean(claimRow.material_fingerprint, 64),
    );
    if (!UUID_RE.test(operationId) || !providerPaymentId || !replayMaterial) {
      return noStore(503, { error: "deposit_unavailable" });
    }
    const stripe = getStripeClient();
    const publishableKey = clean(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, 255);
    if (!stripe || !publishableKey || replayMaterial.provider !== "stripe") {
      return noStore(503, { error: "deposit_unavailable" });
    }
    try {
      const intent = await stripe.paymentIntents.retrieve(
        providerPaymentId,
        {},
        { stripeAccount: replayMaterial.providerMaterial.providerAccountId },
      );
      const finalizeToken = derivePublicDepositFinalizeToken(operationId, paymentRequestId);
      const resumed = await db.rpc("resume_public_deposit_customer_confirmation", {
        p_operation_id: operationId,
        p_request_id: paymentRequestId,
        p_expected_material_fingerprint: replayMaterial.materialFingerprint,
        p_provider_payment_id: providerPaymentId,
        p_provider_status: intent.status,
        p_provider_error_code: null,
        p_new_finalize_token: finalizeToken,
      });
      const resumedRow = rpcRow(resumed.data);
      if (resumed.error) return noStore(503, { error: "deposit_unavailable" });
      if (resumedRow?.code === "provider_reconciliation_claimed") {
        const attemptToken = clean(resumedRow.attempt_token, 36);
        if (!UUID_RE.test(attemptToken)) return noStore(503, { error: "deposit_unavailable" });
        const outcome = intent.status === "succeeded" ? "succeeded" : "pending_provider";
        const completed = await db.rpc("complete_booking_payment_operation", {
          p_operation_id: operationId,
          p_attempt_token: attemptToken,
          p_outcome: outcome,
          p_provider_status: intent.status,
          p_provider_payment_id: providerPaymentId,
          p_provider_refund_id: null,
          p_error_code: null,
        });
        const completedRow = rpcRow(completed.data);
        if (
          !completed.error && outcome === "succeeded" && completedRow?.success === true &&
          ["succeeded", "completion_replay"].includes(String(completedRow.code ?? ""))
        ) {
          return noStore(200, {
            required: true,
            paymentCompleted: true,
            operationId,
            paymentRequestId,
            materialFingerprint: replayMaterial.materialFingerprint,
          });
        }
        return noStore(503, { error: "deposit_pending" });
      }
      if (
        resumedRow?.success !== true || resumedRow.code !== "customer_confirmation_resumed" ||
        !intent.client_secret || !["requires_payment_method", "requires_action"].includes(intent.status)
      ) {
        return noStore(503, { error: "deposit_unavailable" });
      }
      return noStore(200, {
        required: true,
        provider: "stripe",
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        operationId,
        paymentRequestId,
        materialFingerprint: replayMaterial.materialFingerprint,
        finalizeToken,
        connectedAccountId: replayMaterial.providerMaterial.providerAccountId,
        publishableKey,
        amountCents: replayMaterial.amountCents,
        currency: replayMaterial.currency,
      });
    } catch {
      return noStore(503, { error: "deposit_unavailable" });
    }
  }

  if (["in_flight", "intent_in_flight", "reconciliation_required"].includes(String(claimRow?.code ?? ""))) {
    return noStore(503, { error: "deposit_pending" });
  }
  return noStore(503, { error: "deposit_unavailable" });
}
