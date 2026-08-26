/**
 * Signed Wix Custom App booking webhook.
 *
 * Unsigned Wix Automations delivery is intentionally retired. The one-minute
 * polling cron remains an independent fallback. A durable PII-free event inbox
 * records, claims and completes each signature-verified event before any
 * provider fetch or booking mutation. Raw bytes are capped and verified with
 * the enabled integration's own RSA public key and are never stored.
 */
import "server-only";

import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getBooking, type WixBooking } from "@/shared/integrations/wix/client";
import { processWixBookingEvent } from "@/shared/integrations/wix/sync";
import { looseServiceClient } from "@/shared/integrations/wix/looseDb";
import {
  parseWixWebhookEvent,
  readWixWebhookBody,
  verifyWixWebhookSignature,
} from "@/shared/integrations/wix/webhookRuntime";

export const runtime = "nodejs";
export const maxDuration = 20;

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" } as const;

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

const hash = (value: unknown) =>
  createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

export async function GET() {
  return json({ ok: true, endpoint: "wix-webhook", signedOnly: true }, 200);
}

export async function POST(req: NextRequest) {
  const body = await readWixWebhookBody(req);
  if (!body.ok) {
    return json({ error: body.code }, body.code === "body_too_large" ? 413 : 400);
  }

  const signature = req.headers.get("x-wix-signature");
  if (!signature) return json({ error: "signature_required" }, 401);

  const event = parseWixWebhookEvent(body.text, req.headers.get("wix-site-id"));
  if (!event) return json({ error: "invalid_event" }, 400);

  const db = looseServiceClient();
  const { data: integration, error: integrationError } = await db
    .from("wix_integrations")
    .select("salon_id, auto_approve, wix_webhook_public_key")
    .eq("site_id", event.siteId)
    .eq("enabled", true)
    .maybeSingle();
  if (integrationError) return json({ error: "integration_unavailable" }, 503);
  if (!integration?.salon_id) return json({ error: "invalid_signature" }, 401);

  const publicKey =
    typeof integration.wix_webhook_public_key === "string"
      ? integration.wix_webhook_public_key.trim()
      : "";
  if (!publicKey) return json({ error: "webhook_key_unavailable" }, 503);
  if (
    !verifyWixWebhookSignature({
      publicKeyPem: publicKey,
      bytes: body.bytes,
      signatureHeader: signature,
    })
  ) {
    return json({ error: "invalid_signature" }, 401);
  }

  const payloadFingerprint = hash(body.text);
  const salonId = String(integration.salon_id);
  const recorded = await db.rpc("record_wix_webhook_event", {
    p_salon_id: salonId,
    p_site_id: event.siteId,
    p_event_id: event.eventId,
    p_entity_id: event.entityId,
    p_event_slug: event.slug,
    p_occurred_at: event.eventTime,
    p_payload_fingerprint: payloadFingerprint,
  });
  if (recorded.error) return json({ error: "event_ledger_unavailable" }, 503);
  const recordedRow = record(recorded.data);
  if (recordedRow.success !== true || typeof recordedRow.inbox_id !== "string") {
    return json({ error: String(recordedRow.code ?? "event_rejected") }, 409);
  }
  const claimed = await db.rpc("claim_wix_webhook_event", {
    p_inbox_id: recordedRow.inbox_id,
  });
  if (claimed.error) return json({ error: "event_claim_unavailable" }, 503);
  const claim = record(claimed.data);
  if (claim.code === "event_processed") return json({ ok: true, replay: true }, 200);
  if (claim.code === "event_in_flight" || claim.code === "reconciliation_not_due") {
    return json({ ok: true, pending: true }, 202);
  }
  if (
    claim.success !== true ||
    claim.code !== "event_claimed" ||
    typeof claim.inbox_id !== "string" ||
    typeof claim.claim_token !== "string"
  ) return json({ error: String(claim.code ?? "event_claim_rejected") }, 409);

  const complete = async (
    status: "processed" | "failed" | "unknown",
    result: unknown,
    errorCode: string | null,
  ) => db.rpc("complete_wix_webhook_event", {
    p_inbox_id: claim.inbox_id,
    p_claim_token: claim.claim_token,
    p_status: status,
    p_result_fingerprint: hash({ status, result, errorCode }),
    p_error_code: errorCode,
  });

  let fetchedBooking: WixBooking | null;
  try {
    fetchedBooking = await getBooking(event.siteId, event.entityId);
  } catch {
    await complete("unknown", null, "booking_unavailable");
    return json({ error: "booking_unavailable" }, 503);
  }
  if (!fetchedBooking || fetchedBooking.id !== event.entityId) {
    await complete("failed", null, "booking_mismatch");
    return json({ error: "booking_mismatch" }, 409);
  }
  let wixBooking = fetchedBooking;
  if (
    event.slug === "cancelled" ||
    event.slug === "canceled" ||
    event.slug === "declined"
  ) {
    wixBooking = { ...wixBooking, status: "CANCELLED" };
  }

  try {
    const result = await processWixBookingEvent(
      salonId,
      wixBooking,
      integration.auto_approve === true,
    );
    const { error: receiptError } = await db
      .from("wix_integrations")
      .update({ webhook_last_received_at: new Date().toISOString() })
      .eq("site_id", event.siteId)
      .eq("salon_id", salonId);
    if (receiptError) {
      await complete("unknown", result, "receipt_unavailable");
      return json({ error: "receipt_unavailable" }, 503);
    }
    const completion = await complete("processed", result, null);
    if (completion.error || record(completion.data).success !== true) {
      return json({ error: "event_completion_unavailable" }, 503);
    }
    return json({ ok: true, ...result }, 200);
  } catch {
    await complete("unknown", null, "sync_unavailable");
    return json({ error: "sync_unavailable" }, 503);
  }
}
