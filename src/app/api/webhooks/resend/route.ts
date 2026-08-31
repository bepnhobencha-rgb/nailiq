/**
 * Signed Resend delivery receipts for every registered NailIQ email.
 *
 * The raw body is bounded and verified before any database access. Only
 * provider/event IDs, timestamps, and irreversible fingerprints cross the
 * persistence boundary; recipient addresses and message content do not.
 */

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  parseResendCustomerDeliveryMaterial,
  parseResendBookingOtpDeliveryMaterial,
  parseResendOwnerDeliveryMaterial,
  parseResendRegisteredEmailDeliveryMaterial,
  readResendWebhookBody,
  resendWebhookPayloadFingerprint,
  resolveResendWebhookSecret,
  verifyResendWebhook,
} from "@/shared/notifications/resendOwnerDeliveryWebhook";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" } as const;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

type RpcResult = { success?: boolean; code?: string };

function classifyRpcResult(value: unknown):
  | { ok: true; code: string }
  | { ok: false; code: string; status: number } {
  if (!value || typeof value !== "object") {
    return { ok: false, code: "webhook_store_unavailable", status: 503 };
  }
  const result = value as RpcResult;
  if (result.success === true && [
    "event_applied", "event_replay", "event_rejected",
  ].includes(result.code ?? "")) {
    return { ok: true, code: result.code as string };
  }
  if (result.success === true && [
    "event_pending_match", "event_replay_pending",
  ].includes(result.code ?? "")) {
    return { ok: false, code: "event_pending_match", status: 503 };
  }
  if (result.code === "event_conflict") {
    return { ok: false, code: "event_conflict", status: 409 };
  }
  return { ok: false, code: result.code ?? "event_rejected", status: 400 };
}

export async function POST(request: Request) {
  const secret = resolveResendWebhookSecret();
  if (!secret) return json({ ok: false, code: "webhook_not_configured" }, 503);

  const body = await readResendWebhookBody(request);
  if (!body.ok) {
    return json(
      { ok: false, code: body.code },
      body.code === "body_too_large" ? 413 : 400,
    );
  }

  const providerEventId = request.headers.get("svix-id")?.trim() ?? "";
  const event = verifyResendWebhook({
    payload: body.text,
    webhookSecret: secret,
    id: providerEventId,
    timestamp: request.headers.get("svix-timestamp"),
    signature: request.headers.get("svix-signature"),
  });
  if (!event) return json({ ok: false, code: "invalid_signature" }, 401);

  const registeredMaterial = parseResendRegisteredEmailDeliveryMaterial(event);
  const ownerMaterial = parseResendOwnerDeliveryMaterial(event);
  const customerMaterial = ownerMaterial === "ignored"
    ? parseResendCustomerDeliveryMaterial(event)
    : "ignored";
  const otpMaterial = ownerMaterial === "ignored" && customerMaterial === "ignored"
    ? parseResendBookingOtpDeliveryMaterial(event)
    : "ignored";
  if (
    ownerMaterial === "ignored" && customerMaterial === "ignored" &&
    otpMaterial === "ignored" && registeredMaterial === "ignored"
  ) {
    return json({ ok: true, code: "event_ignored" });
  }
  if (
    ownerMaterial === null || customerMaterial === null || otpMaterial === null ||
    registeredMaterial === null
  ) {
    return json({ ok: false, code: "invalid_event" }, 400);
  }

  let db: ReturnType<typeof createServiceRoleClient>;
  try {
    db = createServiceRoleClient();
  } catch {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }

  const payloadFingerprint = resendWebhookPayloadFingerprint(body.bytes);
  let registeredCode: string | null = null;
  if (registeredMaterial !== "ignored") {
    const { data, error } = await db.rpc(
      "record_resend_registered_email_delivery_event" as never,
      {
        p_provider_event_id: providerEventId,
        p_provider_message_id: registeredMaterial.providerMessageId,
        p_email_key: registeredMaterial.emailKey,
        p_audience: registeredMaterial.audience,
        p_event_type: registeredMaterial.eventType,
        p_recipient_fingerprint: registeredMaterial.recipientFingerprint,
        p_recipient_count: registeredMaterial.recipientCount,
        p_occurred_at: registeredMaterial.occurredAt,
        p_payload_fingerprint: payloadFingerprint,
      } as never,
    );
    if (error) return json({ ok: false, code: "webhook_store_unavailable" }, 503);
    const classified = classifyRpcResult(data);
    if (!classified.ok) return json({ ok: false, code: classified.code }, classified.status);
    registeredCode = classified.code;
  }

  const material = ownerMaterial !== "ignored"
    ? ownerMaterial
    : customerMaterial !== "ignored"
      ? customerMaterial
      : otpMaterial;
  if (material === "ignored") {
    return json({ ok: true, code: registeredCode ?? "event_ignored" });
  }
  const isOtp = ownerMaterial === "ignored" && customerMaterial === "ignored";
  const rpcName = isOtp
    ? "record_resend_booking_otp_delivery_event"
    : ownerMaterial === "ignored"
      ? "record_resend_customer_delivery_event"
      : "record_resend_owner_delivery_event";
  const params = {
    ...(isOtp && "deliveryAttemptId" in material
      ? { p_delivery_attempt_id: material.deliveryAttemptId }
      : ownerMaterial === "ignored" && "claimKind" in material
      ? { p_claim_kind: material.claimKind }
      : {}),
    ...("claimId" in material ? { p_claim_id: material.claimId } : {}),
    p_provider_event_id: providerEventId,
    p_provider_message_id: material.providerMessageId,
    p_event_type: material.eventType,
    p_recipient_fingerprint: material.recipientFingerprint,
    p_occurred_at: material.occurredAt,
    p_payload_fingerprint: payloadFingerprint,
  };
  const { data, error } = await db.rpc(rpcName as never, params as never);
  if (error) {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  const classified = classifyRpcResult(data);
  return classified.ok
    ? json({ ok: true, code: classified.code })
    : json({ ok: false, code: classified.code }, classified.status);
}
