import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getStripeClient } from "@/shared/lib/stripe";
import { parsePublicDepositPaymentMaterial } from "@/shared/payments/bookingPaymentOperations";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(payload: Record<string, unknown>, status: number) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function row(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : null;
}

async function complete(
  db: ReturnType<typeof createServiceRoleClient>,
  args: {
    operationId: string;
    attemptToken: string;
    outcome: "pending_customer" | "succeeded" | "pending_provider" | "definite_failure" | "unknown";
    providerStatus: string | null;
    paymentId: string | null;
    errorCode: string | null;
  },
) {
  try {
    return await db.rpc("complete_booking_payment_operation", {
      p_operation_id: args.operationId,
      p_attempt_token: args.attemptToken,
      p_outcome: args.outcome,
      p_provider_status: args.providerStatus,
      p_provider_payment_id: args.paymentId,
      p_provider_refund_id: null,
      p_error_code: args.errorCode,
    });
  } catch {
    return { data: null, error: new Error("completion_write_uncertain") };
  }
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return json({ ok: false, code: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const body = await readJsonObjectWithLimit(request, 2_048);
  const operationId = typeof body?.operationId === "string" ? body.operationId.trim() : "";
  const requestId = typeof body?.paymentRequestId === "string"
    ? body.paymentRequestId.trim()
    : "";
  const finalizeToken = typeof body?.finalizeToken === "string"
    ? body.finalizeToken.trim()
    : "";
  if (!UUID_RE.test(operationId) || !UUID_RE.test(requestId) || finalizeToken.length < 20 || finalizeToken.length > 256) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const db = createServiceRoleClient();
  const ip = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() || "unknown";
  try {
    const { data: allowed, error } = await db.rpc("rate_limit_hit", {
      p_key: `public-deposit-finalize:ip:${createHash("sha256").update(ip).digest("hex")}`,
      p_limit: 20,
      p_window_seconds: 300,
    });
    if (error || typeof allowed !== "boolean") {
      return json({ ok: false, code: "deposit_unavailable" }, 503);
    }
    if (!allowed) return json({ ok: false, code: "rate_limited" }, 429);
  } catch {
    return json({ ok: false, code: "deposit_unavailable" }, 503);
  }

  let claimed: { data: unknown; error: unknown };
  try {
    claimed = await db.rpc("claim_public_deposit_finalization", {
      p_operation_id: operationId,
      p_request_id: requestId,
      p_finalize_token: finalizeToken,
    });
  } catch {
    return json({ ok: false, code: "deposit_unavailable" }, 503);
  }
  if (claimed.error) return json({ ok: false, code: "deposit_unavailable" }, 503);
  const claim = row(claimed.data);
  if (
    claim?.success === true && claim.code === "operation_replay" &&
    claim.status === "succeeded"
  ) {
    return json({
      ok: true,
      code: "succeeded",
      operationId,
      materialFingerprint: claim.material_fingerprint,
    }, 200);
  }
  if (
    claim?.success !== true || claim.code !== "finalization_claimed" ||
    claim.status !== "reconciling"
  ) {
    const code = typeof claim?.code === "string" ? claim.code : "deposit_unavailable";
    return json(
      { ok: false, code },
      ["in_flight", "finalize_token_expired", "finalization_not_available"].includes(code)
        ? 409
        : 503,
    );
  }
  const attemptToken = typeof claim.attempt_token === "string" ? claim.attempt_token : "";
  const providerPaymentId = typeof claim.provider_payment_id === "string"
    ? claim.provider_payment_id.trim()
    : "";
  const fingerprint = typeof claim.material_fingerprint === "string"
    ? claim.material_fingerprint
    : "";
  const material = parsePublicDepositPaymentMaterial(claim.material, fingerprint);
  if (!UUID_RE.test(attemptToken) || !providerPaymentId || !material || material.provider !== "stripe") {
    return json({ ok: false, code: "deposit_unavailable" }, 503);
  }

  const stripe = getStripeClient();
  if (!stripe) return json({ ok: false, code: "deposit_unavailable" }, 503);
  let intent: Awaited<ReturnType<typeof stripe.paymentIntents.retrieve>>;
  try {
    intent = await stripe.paymentIntents.retrieve(
      providerPaymentId,
      {},
      { stripeAccount: material.providerMaterial.providerAccountId },
    );
  } catch {
    const completed = await complete(db, {
      operationId,
      attemptToken,
      outcome: "unknown",
      providerStatus: null,
      paymentId: providerPaymentId,
      errorCode: "provider_transport_error",
    });
    return json({
      ok: false,
      code: completed.error ? "completion_write_uncertain" : "provider_outcome_unknown",
    }, 503);
  }

  const status = intent.status;
  const outcome = status === "succeeded"
    ? "succeeded"
    : ["processing", "requires_capture"].includes(status)
      ? "pending_provider"
      : ["requires_payment_method", "requires_action"].includes(status)
        ? "pending_customer"
        : status === "canceled"
        ? "definite_failure"
        : "unknown";
  const errorCode = outcome === "definite_failure"
    ? "provider_rejected"
    : outcome === "unknown" ? "provider_outcome_ambiguous" : null;
  const completed = await complete(db, {
    operationId,
    attemptToken,
    outcome,
    providerStatus: status,
    paymentId: providerPaymentId,
    errorCode,
  });
  const completedRow = row(completed.data);
  if (
    completed.error || outcome !== "succeeded" ||
    completedRow?.success !== true ||
    !["succeeded", "completion_replay"].includes(String(completedRow.code ?? ""))
  ) {
    return json({
      ok: false,
      code: completed.error
        ? "completion_write_uncertain"
        : typeof completedRow?.code === "string"
          ? completedRow.code
          : outcome,
    }, outcome === "definite_failure" ? 402 : outcome === "pending_customer" ? 409 : 503);
  }
  return json({
    ok: true,
    code: "succeeded",
    operationId,
    materialFingerprint: fingerprint,
  }, 200);
}
