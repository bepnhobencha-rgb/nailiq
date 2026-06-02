/**
 * Real-time Wix webhook handler.
 *
 * Supports two delivery paths:
 *
 * A) Wix Custom App webhooks — sends `x-wix-signature` (RSA-SHA256) + `wix-site-id` header.
 *    Signature verified with WIX_WEBHOOK_PUBLIC_KEY env var.
 *
 * B) Wix Automations "Send HTTP request" — no custom headers allowed by Wix UI.
 *    Caller must include `siteId` in the JSON body instead.
 *    No signature verification (Automations cannot sign requests).
 *
 * The cron /api/cron/wix-sync runs every minute as reliability fallback.
 */
import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import { createVerify } from "crypto";
import { getBooking, type WixBooking } from "@/shared/integrations/wix/client";
import { processWixBookingEvent } from "@/shared/integrations/wix/sync";
import { looseServiceClient } from "@/shared/integrations/wix/looseDb";

export const runtime = "nodejs";
export const maxDuration = 20;

const UPSERT_SLUGS = new Set(["created", "updated", "confirmed"]);
const CANCEL_SLUGS = new Set(["cancelled", "canceled", "declined"]);

/** Verify RSA-SHA256 signature sent by Wix custom app webhooks. */
function verifySignature(publicKeyPem: string, rawBody: Buffer, sig: string | null): boolean {
  if (!sig) return false;
  try {
    const verify = createVerify("RSA-SHA256");
    verify.update(rawBody);
    return verify.verify(publicKeyPem, sig, "base64");
  } catch {
    return false;
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "wix-webhook" });
}

export async function POST(req: NextRequest) {
  const rawBody = Buffer.from(await req.arrayBuffer());

  let body: WixWebhookPayload;
  try {
    body = JSON.parse(rawBody.toString("utf-8")) as WixWebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // --- 1. Auth: RSA signature (Custom App) or body siteId (Automations) ---
  const sig = req.headers.get("x-wix-signature");
  const publicKey = process.env["WIX_WEBHOOK_PUBLIC_KEY"];

  if (sig) {
    // Path A: Custom App — verify RSA signature
    if (publicKey && !verifySignature(publicKey, rawBody, sig)) {
      console.warn("[wix-webhook] RSA signature mismatch — rejected");
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
    console.log("[wix-webhook] path=custom-app");
  } else {
    // Path B: Wix Automations — no signature possible; siteId in body is the identifier
    if (!body.siteId) {
      console.warn("[wix-webhook] no signature and no siteId — rejected");
      return NextResponse.json({ error: "missing_site_id" }, { status: 400 });
    }
    console.log("[wix-webhook] path=automations siteId=%s", body.siteId);
  }

  return handleEvent(req, body);
}

interface WixWebhookPayload {
  entityFqdn?: string;
  slug?: string;
  entityId?: string;
  eventTime?: string;
  data?: string;   // base64-encoded booking JSON (Custom App only)
  siteId?: string; // Wix Automations fallback (no custom headers allowed)
}

async function handleEvent(req: NextRequest, body: WixWebhookPayload): Promise<NextResponse> {
  const { entityFqdn = "", slug = "", entityId = "", data: encodedData, siteId: bodySiteId } = body;

  // --- 2. Only handle booking events ---
  if (!entityFqdn.toLowerCase().includes("booking")) {
    return NextResponse.json({ ok: true, skipped: "non_booking_entity" });
  }
  if (!UPSERT_SLUGS.has(slug) && !CANCEL_SLUGS.has(slug)) {
    return NextResponse.json({ ok: true, skipped: `unhandled_slug:${slug}` });
  }

  // --- 3. Resolve siteId: header (Custom App) → body fallback (Automations) ---
  const siteId = req.headers.get("wix-site-id") ?? bodySiteId ?? null;
  if (!siteId) {
    return NextResponse.json({ error: "missing_site_id" }, { status: 400 });
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
