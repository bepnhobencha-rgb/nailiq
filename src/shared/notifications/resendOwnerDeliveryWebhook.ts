import "server-only";

import { createHash } from "node:crypto";
import { Resend, type WebhookEventPayload } from "resend";

export const MAX_RESEND_WEBHOOK_BYTES = 256 * 1024;

const DELIVERY_EVENTS = new Set<string>([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.failed",
  "email.suppressed",
  "email.bounced",
  "email.complained",
] as const);
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const PROVIDER_ID_RE = /^[!-~]{1,255}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Resend's webhook verifier is local-only but its client constructor requires a
// non-empty API key. Keep verification independent from the outbound send key.
const resendWebhookVerifier = new Resend("re_not_used_for_webhook_verification");

export type ResendOwnerDeliveryMaterial = {
  claimId: string;
  providerMessageId: string;
  eventType:
    | "email.sent"
    | "email.delivered"
    | "email.delivery_delayed"
    | "email.failed"
    | "email.suppressed"
    | "email.bounced"
    | "email.complained";
  recipientFingerprint: string;
  occurredAt: string;
};

export type ResendCustomerDeliveryMaterial = {
  claimKind: "confirmation" | "reminder" | "transition";
  claimId: string;
  providerMessageId: string;
  eventType: ResendOwnerDeliveryMaterial["eventType"];
  recipientFingerprint: string;
  occurredAt: string;
};

export async function readResendWebhookBody(
  request: Request,
): Promise<{ ok: true; bytes: Uint8Array; text: string } | { ok: false; code: string }> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESEND_WEBHOOK_BYTES) {
      return { ok: false, code: "body_too_large" };
    }
  }
  if (!request.body) return { ok: false, code: "invalid_body" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESEND_WEBHOOK_BYTES) {
        await reader.cancel();
        return { ok: false, code: "body_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, code: "invalid_body" };
  }
  if (total === 0) return { ok: false, code: "invalid_body" };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      bytes,
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } catch {
    return { ok: false, code: "invalid_body" };
  }
}

export function resendWebhookPayloadFingerprint(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function resolveResendWebhookSecret(
  value = process.env.RESEND_WEBHOOK_SECRET,
): string | null {
  const secret = value?.trim() ?? "";
  return secret.length >= 16 && secret.length <= 512 && !/[\u0000-\u001f\u007f]/.test(secret)
    ? secret
    : null;
}

export function verifyResendWebhook(input: {
  payload: string;
  webhookSecret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}): WebhookEventPayload | null {
  const id = input.id?.trim() ?? "";
  const timestamp = input.timestamp?.trim() ?? "";
  const signature = input.signature?.trim() ?? "";
  if (!PROVIDER_ID_RE.test(id) || !PROVIDER_ID_RE.test(timestamp) || signature.length < 1 || signature.length > 2_048) {
    return null;
  }
  try {
    return resendWebhookVerifier.webhooks.verify({
      payload: input.payload,
      webhookSecret: input.webhookSecret,
      headers: { id, timestamp, signature },
    });
  } catch {
    return null;
  }
}

export function parseResendOwnerDeliveryMaterial(
  event: WebhookEventPayload,
): ResendOwnerDeliveryMaterial | "ignored" | null {
  if (!DELIVERY_EVENTS.has(event.type)) return "ignored";
  if (!("email_id" in event.data) || !("to" in event.data)) return null;

  const providerMessageId = event.data.email_id;
  const recipients = event.data.to;
  const occurredAt = event.created_at;
  const tags = "tags" in event.data ? event.data.tags : undefined;
  if (tags?.nailiq_flow !== "owner_booking") return "ignored";
  const claimId = tags.nailiq_claim;
  if (
    typeof claimId !== "string" || !UUID_RE.test(claimId) ||
    typeof providerMessageId !== "string" || !PROVIDER_ID_RE.test(providerMessageId) ||
    !Array.isArray(recipients) || recipients.length !== 1 ||
    typeof recipients[0] !== "string" || recipients[0].length > 320 ||
    typeof occurredAt !== "string" || !RFC3339_RE.test(occurredAt) ||
    !Number.isFinite(Date.parse(occurredAt))
  ) {
    return null;
  }

  const recipient = recipients[0].trim().toLowerCase();
  if (!recipient || /[\u0000-\u001f\u007f]/.test(recipient)) return null;
  return {
    claimId: claimId.toLowerCase(),
    providerMessageId,
    eventType: event.type as ResendOwnerDeliveryMaterial["eventType"],
    recipientFingerprint: createHash("sha256").update(recipient, "utf8").digest("hex"),
    occurredAt,
  };
}

export function parseResendCustomerDeliveryMaterial(
  event: WebhookEventPayload,
): ResendCustomerDeliveryMaterial | "ignored" | null {
  if (!DELIVERY_EVENTS.has(event.type)) return "ignored";
  if (!("email_id" in event.data) || !("to" in event.data)) return null;

  const tags = "tags" in event.data ? event.data.tags : undefined;
  if (tags?.nailiq_flow !== "customer_booking") return "ignored";
  const claimId = tags.nailiq_claim;
  const claimKind = tags.nailiq_claim_kind;
  const providerMessageId = event.data.email_id;
  const recipients = event.data.to;
  const occurredAt = event.created_at;
  if (
    (claimKind !== "confirmation" && claimKind !== "reminder" && claimKind !== "transition") ||
    typeof claimId !== "string" || !UUID_RE.test(claimId) ||
    typeof providerMessageId !== "string" || !PROVIDER_ID_RE.test(providerMessageId) ||
    !Array.isArray(recipients) || recipients.length !== 1 ||
    typeof recipients[0] !== "string" || recipients[0].length > 320 ||
    typeof occurredAt !== "string" || !RFC3339_RE.test(occurredAt) ||
    !Number.isFinite(Date.parse(occurredAt))
  ) {
    return null;
  }

  const recipient = recipients[0].trim().toLowerCase();
  if (!recipient || /[\u0000-\u001f\u007f]/.test(recipient)) return null;
  return {
    claimKind,
    claimId: claimId.toLowerCase(),
    providerMessageId,
    eventType: event.type as ResendCustomerDeliveryMaterial["eventType"],
    recipientFingerprint: createHash("sha256").update(recipient, "utf8").digest("hex"),
    occurredAt,
  };
}
