export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";

import {
  allowsSmartCheckoutSandboxWebhookIngestion,
  readSmartCheckoutWebhookBody,
  resolveSmartCheckoutWebhookBinding,
  sanitizeSquareTerminalCheckoutEvent,
  sanitizeSquareTerminalPaymentEvent,
  smartCheckoutProviderAccountFingerprint,
  smartCheckoutWebhookPayloadFingerprint,
} from "@/shared/checkout/smartCheckoutWebhookRuntime";
import {
  parseSquareEvent,
  resolveSquareWebhookProfile,
  verifySquareWebhookSignature,
} from "@/shared/integrations/square/webhookRuntime";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" } as const;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

type IntegrationRow = {
  salon_id: string;
  merchant_id: string;
  location_id: string;
  application_id: string;
  environment: "sandbox";
};

async function resolveSandboxIntegration(
  db: ReturnType<typeof createServiceRoleClient>,
  input: { merchantId: string; applicationId: string; locationId: string },
): Promise<IntegrationRow | null | "unavailable"> {
  const { data, error } = await db
    .from("square_integrations" as never)
    .select("salon_id, merchant_id, location_id, application_id, environment" as never)
    .eq("merchant_id" as never, input.merchantId)
    .eq("application_id" as never, input.applicationId)
    .eq("location_id" as never, input.locationId)
    .eq("environment" as never, "sandbox")
    .eq("enabled" as never, true)
    .limit(2);
  if (error || !Array.isArray(data)) return "unavailable";
  if (data.length !== 1) return null;
  const row = data[0] as unknown as IntegrationRow;
  return row.merchant_id === input.merchantId
    && row.application_id === input.applicationId
    && row.location_id === input.locationId
    && row.environment === "sandbox"
    && typeof row.salon_id === "string"
    ? row
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

  const profile = resolveSquareWebhookProfile(request.url);
  if (!profile || profile.environment !== "sandbox") {
    return json({ ok: false, code: "sandbox_webhook_not_configured" }, 503);
  }
  const body = await readSmartCheckoutWebhookBody(request);
  if (!body.ok) {
    return json(
      { ok: false, code: body.code },
      body.code === "body_too_large" ? 413 : 400,
    );
  }
  if (!verifySquareWebhookSignature({
    profile,
    body: body.bytes,
    signatureHeader: request.headers.get("x-square-hmacsha256-signature"),
  })) {
    return json({ ok: false, code: "invalid_signature" }, 401);
  }

  const event = parseSquareEvent(body.text);
  if (!event) return json({ ok: false, code: "invalid_event" }, 400);
  const material = event.eventType.startsWith("terminal.checkout.")
    ? sanitizeSquareTerminalCheckoutEvent(event)
    : sanitizeSquareTerminalPaymentEvent(event);
  if (!material) {
    const ignored = ![
      "terminal.checkout.created",
      "terminal.checkout.updated",
      "payment.created",
      "payment.updated",
    ].includes(event.eventType);
    return ignored
      ? json({ ok: true, code: "event_ignored" })
      : json({ ok: false, code: "invalid_terminal_event" }, 400);
  }
  if (material.providerApplicationId !== undefined
    && material.providerApplicationId !== profile.applicationId) {
    return json({ ok: false, code: "provider_context_mismatch" }, 409);
  }
  if (!material.providerLocationId) {
    return json({ ok: false, code: "provider_context_mismatch" }, 409);
  }

  const accountFingerprint = smartCheckoutProviderAccountFingerprint("square", event.merchantId);
  if (!accountFingerprint) return json({ ok: false, code: "invalid_provider_account" }, 400);

  const db = createServiceRoleClient();
  const integration = await resolveSandboxIntegration(db, {
    merchantId: event.merchantId,
    applicationId: profile.applicationId,
    locationId: material.providerLocationId,
  });
  if (integration === "unavailable") {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  if (!integration) return json({ ok: false, code: "provider_context_mismatch" }, 409);

  const binding = await resolveSmartCheckoutWebhookBinding(db, {
    provider: "square",
    salonId: integration.salon_id,
    providerAccountFingerprint: accountFingerprint,
    material,
  });
  if (binding === "unavailable") {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  if (!binding) return json({ ok: false, code: "provider_context_mismatch" }, 409);

  const { data, error } = await db.rpc("record_smart_checkout_webhook_event" as never, {
    p_provider: "square",
    p_salon_id: binding.salonId,
    p_event_id: event.eventId,
    p_event_type: event.eventType,
    p_occurred_at: material.occurredAt,
    p_payload_fingerprint: smartCheckoutWebhookPayloadFingerprint(body.bytes),
    p_provider_account_id: event.merchantId,
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
  if (result.success === true && result.event_id === event.eventId
    && ["webhook_event_recorded", "webhook_event_replay"].includes(result.code ?? "")) {
    return json({ ok: true, code: result.code, eventId: event.eventId });
  }
  if (["webhook_event_conflict", "webhook_binding_mismatch", "session_state_mismatch"].includes(
    result.code ?? "",
  )) return json({ ok: false, code: result.code }, 409);
  return json({ ok: false, code: result.code ?? "webhook_store_unavailable" }, 503);
}
