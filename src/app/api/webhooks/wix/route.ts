/**
 * Real-time Wix webhook handler.
 *
 * Supports two delivery shapes:
 *
 * A) Wix Automations "Send HTTP request" — wraps the custom JSON body inside a
 *    top-level `data` object and CANNOT send custom headers or a signature:
 *      { "data": { "entityFqdn": "...", "slug": "created", "entityId": "...", "siteId": "..." } }
 *    Identified/authorised by the `siteId` field inside the envelope.
 *
 * B) Wix Custom App webhook (future) — sends top-level fields, a base64 booking
 *    payload in `data` (a STRING), an `x-wix-signature` (RSA-SHA256) header, and
 *    a `wix-site-id` header. Verified with WIX_WEBHOOK_PUBLIC_KEY.
 *
 * The /api/cron/wix-sync cron runs every minute as a reliability fallback.
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

/** Shape of a Wix booking event after the envelope is normalised. */
interface NormalisedEvent {
  entityFqdn: string;
  slug: string;
  entityId: string;
  siteId: string | null;
  encodedData?: string; // base64 booking JSON (Custom App only)
}

interface RawPayload {
  entityFqdn?: string;
  slug?: string;
  entityId?: string;
  siteId?: string;
  // `data` is an OBJECT for Automations (the wrapped body) or a base64 STRING for Custom App.
  data?: { entityFqdn?: string; slug?: string; entityId?: string; siteId?: string } | string;
}

/**
 * Flatten either delivery shape into a single NormalisedEvent.
 * - Automations: fields live under `data` (object).
 * - Custom App: fields live at the top level; `data` is a base64 string.
 */
function normalise(body: RawPayload, headerSiteId: string | null): NormalisedEvent {
  const envelope = body.data && typeof body.data === "object" ? body.data : body;
  return {
    entityFqdn: envelope.entityFqdn ?? body.entityFqdn ?? "",
    slug: envelope.slug ?? body.slug ?? "",
    entityId: envelope.entityId ?? body.entityId ?? "",
    siteId: envelope.siteId ?? body.siteId ?? headerSiteId ?? null,
    encodedData: typeof body.data === "string" ? body.data : undefined,
  };
}

export async function POST(req: NextRequest) {
  const rawBody = Buffer.from(await req.arrayBuffer());

  let body: RawPayload;
  try {
    body = JSON.parse(rawBody.toString("utf-8")) as RawPayload;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Signature is verified inside handleEvent once we know the salon (the public
  // key is per-salon). The Automations path sends no signature and skips verify.
  const sig = req.headers.get("x-wix-signature");
  const evt = normalise(body, req.headers.get("wix-site-id"));
  return handleEvent(evt, rawBody, sig);
}

async function handleEvent(evt: NormalisedEvent, rawBody: Buffer, sig: string | null): Promise<NextResponse> {
  const { entityFqdn, slug, entityId, siteId, encodedData } = evt;

  // --- 2. Only handle booking events ---
  if (!entityFqdn.toLowerCase().includes("booking")) {
    return NextResponse.json({ ok: true, skipped: "non_booking_entity" });
  }
  if (!UPSERT_SLUGS.has(slug) && !CANCEL_SLUGS.has(slug)) {
    return NextResponse.json({ ok: true, skipped: `unhandled_slug:${slug}` });
  }
  if (!siteId) {
    return NextResponse.json({ error: "missing_site_id" }, { status: 400 });
  }

  // --- 3. Resolve the salon ---
  const db = looseServiceClient();
  const { data: integration } = await db
    .from("wix_integrations")
    .select("salon_id, auto_approve, wix_webhook_public_key")
    .eq("site_id", siteId)
    .eq("enabled", true)
    .maybeSingle();

  if (!integration) {
    return NextResponse.json({ ok: true, skipped: "unknown_site" });
  }

  // --- Custom App path: verify the RSA signature with the per-salon public key
  // (fall back to the env key for the original single-tenant setup). The
  // Automations path sends no signature, so this is skipped there. ---
  if (sig) {
    const publicKey = String((integration.wix_webhook_public_key as string) ?? "") || process.env["WIX_WEBHOOK_PUBLIC_KEY"] || "";
    if (publicKey && !verifySignature(publicKey, rawBody, sig)) {
      console.warn("[wix-webhook] RSA signature mismatch — rejected");
      return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
    }
  }

  const salonId = integration.salon_id as string;
  const autoApprove = (integration.auto_approve as boolean) ?? true;

  // --- 4. Resolve the Wix booking object ---
  let wixBooking: WixBooking | null = null;

  // Custom App path may embed the booking as base64; Automations only sends the id.
  if (encodedData) {
    try {
      wixBooking = JSON.parse(Buffer.from(encodedData, "base64").toString("utf-8")) as WixBooking;
    } catch {
      console.warn("[wix-webhook] failed to decode base64 data; will re-fetch by id");
    }
  }

  // Always fetch fresh by id when we only have the id (Automations) or decode failed.
  if (!wixBooking && entityId) {
    try {
      wixBooking = await getBooking(siteId, entityId);
    } catch (e) {
      console.error("[wix-webhook] getBooking failed", e);
    }
  }

  if (!wixBooking) {
    console.error("[wix-webhook] could not resolve booking", { siteId, entityId, slug });
    return NextResponse.json({ ok: false, reason: "booking_not_resolvable" });
  }

  // --- 5. Apply the event ---
  if (CANCEL_SLUGS.has(slug)) {
    // Force the status so processWixBookingEvent maps it to 'cancelled'.
    wixBooking = { ...wixBooking, status: "CANCELLED" };
  }

  try {
    const result = await processWixBookingEvent(salonId, wixBooking, autoApprove);
    // Record real-time delivery so we can monitor webhook health vs polling fallback.
    await db
      .from("wix_integrations")
      .update({ webhook_last_received_at: new Date().toISOString() })
      .eq("site_id", siteId);
    console.log("[wix-webhook]", { slug, entityId, salonId, ...result });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Return 500 so Wix (or the Automation) retries — transient DB errors resolve on retry.
    console.error("[wix-webhook] processWixBookingEvent error", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
