export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import type Stripe from "stripe";

import {
  allowsSmartCheckoutSandboxWebhookIngestion,
  readSmartCheckoutWebhookBody,
  resolveSmartCheckoutWebhookBinding,
  sanitizeStripeTerminalEvent,
  smartCheckoutProviderAccountFingerprint,
  smartCheckoutWebhookPayloadFingerprint,
} from "@/shared/checkout/smartCheckoutWebhookRuntime";
import { getStripeClient } from "@/shared/lib/stripe";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" } as const;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

async function resolveStripeSalon(
  db: ReturnType<typeof createServiceRoleClient>,
  accountId: string,
): Promise<string | null | "unavailable"> {
  const { data, error } = await db
    .from("salons" as never)
    .select("id, stripe_connect_account_id, payment_provider" as never)
    .eq("stripe_connect_account_id" as never, accountId)
    .eq("payment_provider" as never, "stripe")
    .limit(2);
  if (error || !Array.isArray(data)) return "unavailable";
  if (data.length !== 1) return null;
  const row = data[0] as unknown as {
    id?: unknown;
    stripe_connect_account_id?: unknown;
    payment_provider?: unknown;
  };
  return typeof row.id === "string"
    && row.stripe_connect_account_id === accountId
    && row.payment_provider === "stripe"
    ? row.id
    : null;
}

export async function POST(request: Request) {
  if (!allowsSmartCheckoutSandboxWebhookIngestion()) {
    return json({ ok: false, code: "sandbox_webhook_ingestion_disabled" }, 503);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    !== "application/json") {
    return json({ ok: false, code: "unsupported_media_type" }, 415);
  }
  const signingSecret = process.env.STRIPE_SMART_CHECKOUT_WEBHOOK_SECRET?.trim() ?? "";
  if (signingSecret.length < 16 || signingSecret.length > 512) {
    return json({ ok: false, code: "sandbox_webhook_not_configured" }, 503);
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return json({ ok: false, code: "missing_signature" }, 400);

  const body = await readSmartCheckoutWebhookBody(request);
  if (!body.ok) {
    return json(
      { ok: false, code: body.code },
      body.code === "body_too_large" ? 413 : 400,
    );
  }
  let event: Stripe.Event;
  try {
    const stripe = getStripeClient();
    if (!stripe) return json({ ok: false, code: "sandbox_webhook_not_configured" }, 503);
    event = stripe.webhooks.constructEvent(body.text, signature, signingSecret);
  } catch {
    return json({ ok: false, code: "invalid_signature" }, 401);
  }

  const material = sanitizeStripeTerminalEvent(event);
  if (!material) {
    const ignored = ![
      "payment_intent.processing",
      "payment_intent.amount_capturable_updated",
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "payment_intent.canceled",
      "terminal.reader.action_succeeded",
      "terminal.reader.action_failed",
    ].includes(event.type);
    return ignored
      ? json({ ok: true, code: "event_ignored" })
      : json({ ok: false, code: "invalid_terminal_event" }, 400);
  }
  const accountId = typeof event.account === "string" ? event.account.trim() : "";
  const accountFingerprint = smartCheckoutProviderAccountFingerprint("stripe", accountId);
  if (!accountFingerprint) {
    return json({ ok: false, code: "provider_context_mismatch" }, 409);
  }

  const db = createServiceRoleClient();
  const salonId = await resolveStripeSalon(db, accountId);
  if (salonId === "unavailable") {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  if (!salonId || (material.claimedSalonId !== undefined
    && material.claimedSalonId !== null && material.claimedSalonId !== salonId)) {
    return json({ ok: false, code: "provider_context_mismatch" }, 409);
  }

  const binding = await resolveSmartCheckoutWebhookBinding(db, {
    provider: "stripe",
    salonId,
    providerAccountFingerprint: accountFingerprint,
    material,
  });
  if (binding === "unavailable") {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  if (!binding) return json({ ok: false, code: "provider_context_mismatch" }, 409);

  const { data, error } = await db.rpc("record_smart_checkout_webhook_event" as never, {
    p_provider: "stripe",
    p_salon_id: binding.salonId,
    p_event_id: event.id,
    p_event_type: event.type,
    p_occurred_at: material.occurredAt,
    p_payload_fingerprint: smartCheckoutWebhookPayloadFingerprint(body.bytes),
    p_provider_account_id: accountId,
    p_provider_location_id: binding.providerLocationId,
    p_provider_device_id: binding.providerDeviceId,
    p_provider_checkout_id: binding.providerCheckoutId,
    p_provider_payment_id: binding.providerPaymentId,
    p_provider_status: material.providerStatus,
    p_amount_cents: material.amountCents ?? binding.amountCents,
    p_currency: material.currency ?? binding.currency,
    p_material: {
      session_id: binding.sessionId,
      ...(material.failureCode ? { failure_code: material.failureCode } : {}),
    },
  } as never);
  if (error || !data || typeof data !== "object") {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  const result = data as unknown as { success?: boolean; code?: string; event_id?: string };
  if (result.success === true && result.event_id === event.id
    && ["webhook_event_recorded", "webhook_event_replay"].includes(result.code ?? "")) {
    return json({ ok: true, code: result.code, eventId: event.id });
  }
  if (["webhook_event_conflict", "webhook_binding_mismatch", "session_state_mismatch"].includes(
    result.code ?? "",
  )) return json({ ok: false, code: result.code }, 409);
  return json({ ok: false, code: result.code ?? "webhook_store_unavailable" }, 503);
}
