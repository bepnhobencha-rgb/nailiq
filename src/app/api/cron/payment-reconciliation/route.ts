import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getStripeClient } from "@/shared/lib/stripe";
import {
  parseBookingPaymentOperationMaterial,
  parseClaimedBookingPaymentOperation,
  parsePublicDepositPaymentMaterial,
  type ClaimedPublicDepositPaymentOperation,
} from "@/shared/payments/bookingPaymentOperations";
import { dispatchClaimedBookingPaymentOperation } from "@/shared/payments/executeBookingPaymentOperation";
import { derivePublicDepositFinalizeToken } from "@/shared/payments/publicDepositFinalizeCapability";
import { toProviderMinorAmount } from "@/shared/payments/providerMinorUnits";
import { reconcileSquareHostedDepositClaim } from "@/shared/integrations/square/deposits";
import { reconcileSquarePublicDepositResponseLoss } from "@/shared/integrations/square/publicDepositReconciliation";
import { requireCronAuthorization } from "@/shared/security/cronAuthorization";
import { runTrackedCron } from "@/shared/security/cronRunHistory";
import { reconcileBookingCardSaveOperations } from "@/shared/booking/reconcileBookingCardSaveOperations";
import { reconcileBookingCardContinuations } from "@/shared/booking/reconcileBookingCardContinuations";
import { v1AllowsCustomerPaymentGateway } from "@/shared/release/v1IntegrationScope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 55;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

async function complete(
  db: ReturnType<typeof createServiceRoleClient>,
  input: {
    operationId: string;
    attemptToken: string;
    outcome: "succeeded" | "pending_provider" | "definite_failure" | "unknown";
    providerStatus: string | null;
    paymentId: string | null;
    errorCode: string | null;
  },
) {
  try {
    return await db.rpc("complete_booking_payment_operation", {
      p_operation_id: input.operationId,
      p_attempt_token: input.attemptToken,
      p_outcome: input.outcome,
      p_provider_status: input.providerStatus,
      p_provider_payment_id: input.paymentId,
      p_provider_refund_id: null,
      p_error_code: input.errorCode,
    });
  } catch {
    return { data: null, error: new Error("completion_write_uncertain") };
  }
}

async function reconcilePublicDeposit(
  db: ReturnType<typeof createServiceRoleClient>,
  claim: ClaimedPublicDepositPaymentOperation,
  requestId: string,
  storedPaymentId: string | null,
): Promise<boolean> {
  if (claim.material.provider !== "stripe" || !UUID_RE.test(requestId)) return false;
  const stripe = getStripeClient();
  if (!stripe) return false;
  let intent: Awaited<ReturnType<typeof stripe.paymentIntents.retrieve>>;
  try {
    intent = storedPaymentId
      ? await stripe.paymentIntents.retrieve(
          storedPaymentId,
          {},
          { stripeAccount: claim.material.providerMaterial.providerAccountId },
        )
      : await stripe.paymentIntents.create(
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
    await complete(db, {
      operationId: claim.operationId,
      attemptToken: claim.attemptToken,
      outcome: "unknown",
      providerStatus: null,
      paymentId: storedPaymentId,
      errorCode: "provider_transport_error",
    });
    return false;
  }

  if (["requires_payment_method", "requires_action"].includes(intent.status)) {
    const finalizeToken = derivePublicDepositFinalizeToken(claim.operationId, requestId);
    let attached: { data: unknown; error: unknown };
    try {
      attached = await db.rpc("attach_public_deposit_provider_intent", {
        p_operation_id: claim.operationId,
        p_attempt_token: claim.attemptToken,
        p_provider_payment_id: intent.id,
        p_provider_status: intent.status,
        p_finalize_token: finalizeToken,
      });
    } catch {
      attached = { data: null, error: new Error("attach_uncertain") };
    }
    const attachedRow = record(Array.isArray(attached.data) ? attached.data[0] : attached.data);
    return !attached.error && attachedRow?.success === true &&
      ["intent_attached", "intent_attach_replay"].includes(String(attachedRow.code ?? ""));
  }

  const outcome = intent.status === "succeeded"
    ? "succeeded"
    : ["processing", "requires_capture"].includes(intent.status)
      ? "pending_provider"
      : intent.status === "canceled"
        ? "definite_failure"
        : "unknown";
  const completed = await complete(db, {
    operationId: claim.operationId,
    attemptToken: claim.attemptToken,
    outcome,
    providerStatus: intent.status,
    paymentId: intent.id,
    errorCode: outcome === "definite_failure"
      ? "provider_rejected"
      : outcome === "unknown" ? "provider_outcome_ambiguous" : null,
  });
  const completedRow = record(Array.isArray(completed.data) ? completed.data[0] : completed.data);
  return !completed.error && outcome === "succeeded" && completedRow?.success === true;
}

export async function GET(request: NextRequest) {
  const authorizationError = requireCronAuthorization(request);
  if (authorizationError) return authorizationError;
  const paymentWorkerDisabled = process.env.PAYMENT_LEDGER_WORKERS_ENABLED !== "true";
  const paymentWorkerEnabled = !paymentWorkerDisabled;
  const cardWorkerEnabled = process.env.BOOKING_CARD_RECONCILIATION_ENABLED === "true";
  const continuationWorkerEnabled =
    process.env.BOOKING_CARD_CONTINUATION_RECONCILIATION_ENABLED === "true";
  if (!paymentWorkerEnabled && !cardWorkerEnabled && !continuationWorkerEnabled) {
    return NextResponse.json({ ok: true, code: "disabled", processed: 0 });
  }
  return runTrackedCron("payment_reconciliation", async () => {
    const cardResult = cardWorkerEnabled
      ? await reconcileBookingCardSaveOperations(10)
      : { ok: true, processed: 0, reconciled: 0, unresolved: 0 };
    const continuationResult = continuationWorkerEnabled
      ? await reconcileBookingCardContinuations(10)
      : {
          ok: true, processed: 0, awaitingCustomer: 0, pendingProvider: 0,
          resolved: 0, manualReview: 0, errors: 0,
        };
    if (!paymentWorkerEnabled) {
      const workerOk = cardResult.ok && continuationResult.ok;
      return NextResponse.json({
        ok: workerOk,
        ...(workerOk ? {} : { code: "card_reconciliation_incomplete" }),
        processed: cardResult.processed + continuationResult.processed,
        succeeded: cardResult.reconciled,
        unresolved: cardResult.unresolved + continuationResult.errors,
        ...(cardWorkerEnabled ? { card: cardResult } : {}),
        ...(continuationWorkerEnabled ? { continuation: continuationResult } : {}),
      }, { status: workerOk ? 200 : 503 });
    }
    const db = createServiceRoleClient();
    const squareEnvironment = process.env.SQUARE_PUBLIC_DEPOSIT_RECONCILIATION_ENVIRONMENT;
    const squareDiscoveryEnabled = squareEnvironment === "sandbox" || squareEnvironment === "production";
    let squareDiscovered: { data: unknown; error: unknown } = { data: [], error: null };
    if (squareDiscoveryEnabled) {
      try {
        squareDiscovered = await db.rpc(
          "discover_due_public_square_deposit_reconciliations" as never,
          {
            p_expected_environment: squareEnvironment,
            // Each claim can require a bounded multi-page provider read. Keep
            // the dedicated batch below the 55-second cron budget.
            p_limit: 5,
          } as never,
        );
      } catch {
        squareDiscovered = { data: null, error: new Error("square_discovery_unavailable") };
      }
      if (squareDiscovered.error || !Array.isArray(squareDiscovered.data)) {
        return NextResponse.json(
          { ok: false, code: "square_discovery_unavailable" },
          { status: 503 },
        );
      }
    }
    let discovered: { data: unknown; error: unknown };
    try {
      discovered = await db.rpc("discover_due_booking_payment_reconciliations", {
        p_limit: 25,
      });
    } catch {
      discovered = { data: null, error: new Error("discovery_unavailable") };
    }
    if (discovered.error || !Array.isArray(discovered.data)) {
      return NextResponse.json({ ok: false, code: "discovery_unavailable" }, { status: 503 });
    }
    const dueOperations = [
      ...(squareDiscovered.data as unknown[]),
      ...discovered.data,
    ];
    let processed = 0;
    let succeeded = 0;
    let unresolved = 0;
    for (const value of dueOperations) {
      const item = record(value);
      const operationKind = typeof item?.operation_kind === "string"
        ? item.operation_kind
        : "";
      const requestId = typeof item?.request_id === "string" ? item.request_id : "";
      const fingerprint = typeof item?.material_fingerprint === "string"
        ? item.material_fingerprint
        : "";
      if (
        operationKind === "deposit_charge" &&
        item?.delivery_mode === "square_hosted_link"
      ) {
        processed += 1;
        const result = await reconcileSquareHostedDepositClaim(db, value);
        if (result === "succeeded") succeeded += 1;
        else unresolved += 1;
        continue;
      }
      const publicMaterial = operationKind === "deposit_charge"
        ? parsePublicDepositPaymentMaterial(item?.material, fingerprint)
        : null;
      processed += 1;
      if (publicMaterial && publicMaterial.bookingIdempotencyKey) {
        const operationId = typeof item?.operation_id === "string" ? item.operation_id : "";
        const attemptToken = typeof item?.attempt_token === "string" ? item.attempt_token : "";
        const providerKey = typeof item?.provider_idempotency_key === "string"
          ? item.provider_idempotency_key
          : "";
        if (!UUID_RE.test(operationId) || !UUID_RE.test(attemptToken) || providerKey !== `nq:${operationId}`) {
          unresolved += 1;
          continue;
        }
        const publicClaim = {
          operationId,
          attemptToken,
          providerIdempotencyKey: providerKey,
          leaseExpiresAt: String(item?.lease_expires_at ?? ""),
          attemptCount: Number(item?.attempt_count),
          material: publicMaterial,
        } satisfies ClaimedPublicDepositPaymentOperation;
        const storedPaymentId = typeof item?.provider_payment_id === "string"
          ? item.provider_payment_id
          : null;
        const ok = publicMaterial.provider === "square"
          ? (await reconcileSquarePublicDepositResponseLoss(
              db as never,
              publicClaim,
              storedPaymentId,
              typeof item?.operation_created_at === "string"
                ? item.operation_created_at
                : "",
            )).status === "succeeded"
          : await reconcilePublicDeposit(
              db,
              publicClaim,
              requestId,
              storedPaymentId,
            );
        if (ok) succeeded += 1;
        else unresolved += 1;
        continue;
      }
      if (![
        "deposit_charge", "noshow_charge", "late_cancel_charge",
        "deposit_refund", "noshow_refund", "late_cancel_refund",
      ].includes(operationKind)) {
        unresolved += 1;
        continue;
      }
      if (
        !v1AllowsCustomerPaymentGateway() &&
        [
          "noshow_charge",
          "late_cancel_charge",
          "noshow_refund",
          "late_cancel_refund",
        ].includes(operationKind)
      ) {
        // A reconciliation worker must not become a back door around the V1
        // money boundary. Preserve the unresolved ledger row for a future,
        // separately certified Phase 2 release without touching a provider.
        unresolved += 1;
        continue;
      }
      const ordinaryMaterial = parseBookingPaymentOperationMaterial(
        { ...(item?.material as Record<string, unknown> | null ?? {}), material_fingerprint: fingerprint },
        operationKind as Parameters<typeof parseBookingPaymentOperationMaterial>[1],
      );
      if (!ordinaryMaterial) {
        unresolved += 1;
        continue;
      }
      const claim = parseClaimedBookingPaymentOperation(item, ordinaryMaterial.operationKind);
      if (!claim) {
        unresolved += 1;
        continue;
      }
      const result = await dispatchClaimedBookingPaymentOperation({ db: db as never, claim });
      if (result.ok) succeeded += 1;
      else unresolved += 1;
    }
    processed += cardResult.processed;
    succeeded += cardResult.reconciled;
    unresolved += cardResult.unresolved;
    processed += continuationResult.processed;
    unresolved += continuationResult.errors;
    const reconciliationDetails = {
      ...(cardWorkerEnabled ? { card: cardResult } : {}),
      ...(continuationWorkerEnabled ? { continuation: continuationResult } : {}),
    };
    return NextResponse.json(
      {
        ok: unresolved === 0,
        ...(unresolved === 0 ? {} : { code: "reconciliation_incomplete" }),
        processed,
        succeeded,
        unresolved,
        ...reconciliationDetails,
      },
      { status: unresolved === 0 ? 200 : 503 },
    );
  });
}
