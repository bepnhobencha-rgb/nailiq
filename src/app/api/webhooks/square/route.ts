/**
 * Square webhook handler — dispute events only.
 *
 * Handles:
 *   - dispute.created          → new dispute opened
 *   - dispute.state.changed    → dispute state updated (UNDER_REVIEW, etc.)
 *
 * Signature verification:
 *   Base64( HMAC-SHA256( key=SQUARE_WEBHOOK_SIGNATURE_KEY, message=notificationUrl+rawBody ) )
 *   compared against the x-square-hmacsha256-signature header.
 *
 * If SQUARE_WEBHOOK_SIGNATURE_KEY is unset the handler is dormant — returns
 * 200 immediately without processing. This keeps the endpoint safe to deploy
 * before Square credentials are configured.
 *
 * Never throws after signature verification — catch + log + 200 so Square
 * does not retry indefinitely on DB errors.
 */

export const runtime = "nodejs";

import { createHmac } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const DISPUTE_EVENT_TYPES = new Set(["dispute.created", "dispute.state.changed"]);

/** Verify Square's HMAC-SHA256 webhook signature. */
function verifySquareSignature(
  key: string,
  notificationUrl: string,
  rawBody: string,
  header: string | null,
): boolean {
  if (!header) return false;
  try {
    const expected = createHmac("sha256", key)
      .update(notificationUrl + rawBody)
      .digest("base64");
    return expected === header;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  // ── 1. Guard: key not yet configured → dormant (no crash) ─────────────────
  const sigKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  if (!sigKey) {
    console.log("[square webhook] not configured — SQUARE_WEBHOOK_SIGNATURE_KEY missing");
    return NextResponse.json({ ok: true, dormant: true });
  }

  // ── 2. Read raw body (required for HMAC calculation) ──────────────────────
  const rawBody = await req.text();

  // ── 3. Verify signature ───────────────────────────────────────────────────
  // notificationUrl must be the full request URL (including https://) so it
  // matches exactly what Square signed. Next.js surfaces this via req.url on
  // the nodejs runtime.
  const notificationUrl = req.url;
  const sigHeader = req.headers.get("x-square-hmacsha256-signature");

  if (!verifySquareSignature(sigKey, notificationUrl, rawBody, sigHeader)) {
    console.error("[square webhook] signature mismatch");
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  // ── 4. Parse body ─────────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    console.error("[square webhook] JSON parse failed");
    return NextResponse.json({ ok: true, _error: "parse_failed" });
  }

  const eventType = typeof body.type === "string" ? body.type : "";

  // ── 5. Unknown event types → ack silently ─────────────────────────────────
  if (!DISPUTE_EVENT_TYPES.has(eventType)) {
    return NextResponse.json({ ok: true, ignored: eventType });
  }

  // ── 6. Process dispute event ──────────────────────────────────────────────
  try {
    // Square envelope: body.data.object.dispute
    const dataObj = body.data as Record<string, unknown> | undefined;
    const objectObj = dataObj?.object as Record<string, unknown> | undefined;
    const dispute = objectObj?.dispute as Record<string, unknown> | undefined;

    if (!dispute) {
      console.error("[square webhook] dispute object not found in payload", body);
      return NextResponse.json({ ok: true, _error: "no_dispute_object" });
    }

    // Square dispute fields
    const disputeId = (dispute.dispute_id ?? dispute.id) as string | undefined;
    if (!disputeId) {
      console.error("[square webhook] no dispute_id in payload", dispute);
      return NextResponse.json({ ok: true, _error: "no_dispute_id" });
    }

    const amountMoney = dispute.amount_money as
      | { amount?: number | null; currency?: string | null }
      | undefined;
    const amountCents =
      typeof amountMoney?.amount === "number" ? amountMoney.amount : null;
    const currency =
      typeof amountMoney?.currency === "string" ? amountMoney.currency : null;
    const reason = typeof dispute.reason === "string" ? dispute.reason : null;
    const state = typeof dispute.state === "string" ? dispute.state : null;
    const dueAt = typeof dispute.due_at === "string" ? dispute.due_at : null;
    const locationId =
      typeof dispute.location_id === "string" ? dispute.location_id : null;

    const disputedPayment = dispute.disputed_payment as
      | { payment_id?: string | null }
      | undefined;
    const paymentId = disputedPayment?.payment_id ?? null;

    const db = createServiceRoleClient();

    // ── Resolve booking + salon ────────────────────────────────────────────
    type BookingLookup = {
      id: string;
      salon_id: string;
      client_phone: string | null;
    } | null;

    let bookingRow: BookingLookup = null;
    if (paymentId) {
      const { data } = await db
        .from("bookings" as never)
        .select("id, salon_id, client_phone")
        .eq("noshow_payment_id" as never, paymentId)
        .maybeSingle();
      bookingRow = data as BookingLookup;
    }

    let salonId: string | null = bookingRow?.salon_id ?? null;
    const bookingId: string | null = bookingRow?.id ?? null;
    const clientPhone: string | null = bookingRow?.client_phone ?? null;

    // Fallback: look up salon via square_integrations.location_id
    if (!salonId && locationId) {
      const { data: siRow } = await db
        .from("square_integrations" as never)
        .select("salon_id")
        .eq("location_id" as never, locationId)
        .maybeSingle();
      salonId = (siRow as { salon_id?: string } | null)?.salon_id ?? null;
    }

    // ── Upsert into payment_disputes ──────────────────────────────────────
    await db
      .from("payment_disputes" as never)
      .upsert(
        {
          provider: "square",
          provider_dispute_id: disputeId,
          payment_ref: paymentId,
          booking_id: bookingId,
          salon_id: salonId,
          client_phone: clientPhone,
          amount_cents: amountCents,
          currency,
          reason,
          status: state,
          evidence_due_at: dueAt,
          raw: dispute as unknown as Record<string, unknown>,
          updated_at: new Date().toISOString(),
        } as never,
        { onConflict: "provider_dispute_id" },
      );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[square webhook] dispute upsert error", err);
    // Never 5xx after signature passes — Square would retry indefinitely.
    return NextResponse.json({ ok: true, _error: "dispute_write_failed" });
  }
}
