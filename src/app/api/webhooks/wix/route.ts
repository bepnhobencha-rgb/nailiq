/**
 * Real-time Wix webhook handler.
 *
 * Wix POSTs booking events here the moment they happen (<1s), replacing the
 * 2-minute polling cron for time-critical updates. The cron continues running
 * as a reliability fallback in case a webhook delivery fails.
 *
 * Docs: https://dev.wix.com/docs/rest/business-solutions/bookings/bookings/bookings-v2/event-triggered-emails
 * Signature: RSA-SHA256 signed by Wix using the app's private key.
 * Verify with WIX_WEBHOOK_PUBLIC_KEY (PEM format from Wix Dev Console → App → Webhooks).
 * Wix requires a 200 response within a few seconds; it retries on 5xx.
 */
import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import { createVerify } from "crypto";
import { getBooking, type WixBooking } from "@/shared/integrations/wix/client";
import { processWixBookingEvent } from "@/shared/integrations/wix/sync";
import { looseServiceClient } from "@/shared/integrations/wix/looseDb";

export const runtime = "nodejs";
// Webhook must finish quickly; Wix has a short timeout before it marks the delivery failed.
export const maxDuration = 20;

// Wix slugs that require an upsert (created / updated / confirmed).
const UPSERT_SLUGS = new Set(["created", "updated", "confirmed"]);
// Wix slugs that mean the booking is cancelled.
const CANCEL_SLUGS = new Set(["cancelled", "canceled", "declined"]);

/**
 * Verify the RSA-SHA256 signature Wix attaches to every webhook delivery.
 * Wix custom apps sign using their private key; we verify with the public key
 * (PEM format) stored in WIX_WEBHOOK_PUBLIC_KEY.
 */
function verifySignature(publicKeyPem: string, rawBody: Buffer, header: string | null): boolean {
  if (!header) return false;
  try {
    const verify = createVerify("RSA-SHA256");
    verify.update(rawBody);
    return verify.verify(publicKeyPem, header, "base64");
  } catch {
    return false;
  }
}

// Health-check — lets you verify the endpoint is reachable before wiring it in Wix.
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "wix-webhook" });
}

export async function POST(req: NextRequest) {
  // --- 1. Signature verification (skipped when WIX_WEBHOOK_PUBLIC_KEY is not configured) ---
  const publicKey = process.env["WIX_WEBHOOK_PUBLIC_KEY"];
  if (publicKey) {
    const rawBody = Buffer.from(await req.arrayBuffer());
    const sig = req.headers.get("x-wix-signature");
    if (!verifySignature(publicKey, rawBody, sig)) {
      console.warn("[wix-webhook] RSA signature mismatch");
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    // We already read the body as an ArrayBuffer; parse it from the buffer.
    try {
      const body = JSON.parse(rawBody.toString("utf-8")) as WixWebhookPayload;
      return handleEvent(req, body);
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }
  }

  // --- No secret configured: parse body directly ---
  let body: WixWebhookPayload;
  try {
    body = (await req.json()) as WixWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  return handleEvent(req, body);
}

interface WixWebhookPayload {
  entityFqdn?: string;
  slug?: string;
  entityId?: string;
  eventTime?: string;
  data?: string; // base64-encoded booking JSON
}

async function handleEvent(req: NextRequest, body: WixWebhookPayload): Promise<NextResponse> {
  const { entityFqdn = "", slug = "", entityId = "", data: encodedData } = body;

  // --- 2. Only handle booking events ---
  if (!entityFqdn.toLowerCase().includes("booking")) {
    // Acknowledge non-booking events silently (Wix may send other entity types).
    return NextResponse.json({ ok: true, skipped: "non_booking_entity" });
  }
  if (!UPSERT_SLUGS.has(slug) && !CANCEL_SLUGS.has(slug)) {
    return NextResponse.json({ ok: true, skipped: `unhandled_slug:${slug}` });
  }

  // --- 3. Resolve the salon from the wix-site-id header ---
  const siteId = req.headers.get("wix-site-id");
  if (!siteId) {
    // Wix always sends this header; missing = unexpected caller.
    return NextResponse.json({ error: "missing_wix_site_id" }, { status: 400 });
  }

  const db = looseServiceClient();
  const { data: integration } = await db
    .from("wix_integrations")
    .select("salon_id, auto_approve")
    .eq("site_id", siteId)
    .eq("enabled", true)
    .maybeSingle();

  if (!integration) {
    // Not our tenant — acknowledge and move on.
    return NextResponse.json({ ok: true, skipped: "unknown_site" });
  }

  const salonId = integration.salon_id as string;
  const autoApprove = (integration.auto_approve as boolean) ?? true;

  // --- 4. Resolve the Wix booking object ---
  let wixBooking: WixBooking | null = null;

  if (encodedData) {
    // Decode the base64 payload Wix embeds in the event.
    try {
      wixBooking = JSON.parse(Buffer.from(encodedData, "base64").toString("utf-8")) as WixBooking;
    } catch {
      console.warn("[wix-webhook] failed to decode data field; will re-fetch");
    }
  }

  if (!wixBooking && entityId) {
    // Fall back to a live API fetch for the freshest data.
    try {
      wixBooking = await getBooking(siteId, entityId);
    } catch (e) {
      console.error("[wix-webhook] getBooking failed", e);
    }
  }

  if (!wixBooking) {
    // Cannot resolve the booking; return 200 so Wix does not retry endlessly.
    console.error("[wix-webhook] could not resolve booking", { siteId, entityId, slug });
    return NextResponse.json({ ok: false, reason: "booking_not_resolvable" });
  }

  // --- 5. Apply the event ---
  if (CANCEL_SLUGS.has(slug)) {
    // Force the status on the decoded payload so processWixBookingEvent maps it to 'cancelled'.
    wixBooking = { ...wixBooking, status: "CANCELLED" };
  }

  try {
    const result = await processWixBookingEvent(salonId, wixBooking, autoApprove);
    console.log("[wix-webhook]", { slug, entityId, salonId, ...result });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Return 500 so Wix retries — transient DB errors will resolve on retry.
    console.error("[wix-webhook] processWixBookingEvent error", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
