/**
 * Signed Wix Custom App booking webhook.
 *
 * Unsigned Wix Automations delivery is intentionally retired. The one-minute
 * polling cron remains the fallback until a durable per-event sync ledger is
 * designed. Raw bytes are capped and verified with the enabled integration's
 * own RSA public key before any provider fetch or booking mutation.
 */
import "server-only";

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

  let fetchedBooking: WixBooking | null;
  try {
    fetchedBooking = await getBooking(event.siteId, event.entityId);
  } catch {
    return json({ error: "booking_unavailable" }, 503);
  }
  if (!fetchedBooking || fetchedBooking.id !== event.entityId) {
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
    const salonId = String(integration.salon_id);
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
    if (receiptError) return json({ error: "receipt_unavailable" }, 503);
    return json({ ok: true, ...result }, 200);
  } catch {
    return json({ error: "sync_unavailable" }, 503);
  }
}
