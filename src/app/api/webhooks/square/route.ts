/**
 * Square webhook ingress.
 *
 * Verification is bound to one explicit notification URL, Square application,
 * and environment from SQUARE_WEBHOOK_PROFILES_JSON. The exact raw bytes are
 * bounded before parsing and compared with constant-time HMAC verification.
 * Optional Loyalty/Gift Card/Inventory payloads are reduced to a strict,
 * non-PII material projection before entering the durable DB inbox. Financial
 * refund revisions additionally bind to the exact tenant/provider operation.
 */

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { SQUARE_OPTIONAL_API_VERSION } from "@/shared/integrations/square/optionalCapabilities";
import {
  isSquareOptionalWebhookEvent,
  parseSquareEvent,
  readSquareWebhookBody,
  resolveSquareWebhookProfile,
  sanitizeSquareOptionalEvent,
  sanitizeSquarePaymentEvent,
  sanitizeSquareRefundEvent,
  squareWebhookPayloadFingerprint,
  verifySquareWebhookSignature,
} from "@/shared/integrations/square/webhookRuntime";

const DISPUTE_EVENT_TYPES = new Set([
  "dispute.created",
  // Square still exposes the deprecated event for existing subscriptions,
  // while new subscriptions use `dispute.state.updated`.
  "dispute.state.changed",
  "dispute.state.updated",
]);
const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" } as const;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function optionalFeature(eventType: string): "loyalty" | "gift_cards" | "inventory" | null {
  if (eventType.startsWith("loyalty.")) return "loyalty";
  if (eventType.startsWith("gift_card.")) return "gift_cards";
  if (eventType === "inventory.count.updated" || eventType === "catalog.version.updated") {
    return "inventory";
  }
  return null;
}

type IntegrationRow = {
  salon_id: string;
  merchant_id: string;
  location_id: string;
  application_id: string;
  environment: "sandbox" | "production";
};

type FeatureContract = {
  success: boolean;
  code: string;
  api_version?: string;
  salon_id?: string;
  merchant_id?: string;
  location_id?: string;
  application_id?: string;
  environment?: string;
  provider_account_fingerprint?: string;
};

function providerLocationId(value: unknown): string | null {
  return typeof value === "string" && /^[!-~]{1,255}$/.test(value)
    ? value
    : null;
}

/**
 * Return an exact provider location only when the signed event carries one.
 * Merchant-wide events deliberately return null: when a merchant is mapped to
 * multiple NailIQ salons, resolveIntegration then fails closed instead of
 * guessing which tenant owns the event.
 */
function squareWebhookLocationId(
  event: NonNullable<ReturnType<typeof parseSquareEvent>>,
): string | null {
  const refund = sanitizeSquareRefundEvent(event);
  if (refund) return refund.locationId;
  const payment = sanitizeSquarePaymentEvent(event);
  if (payment) return payment.locationId;

  if (isSquareOptionalWebhookEvent(event.eventType)) {
    const sanitized = sanitizeSquareOptionalEvent(event);
    if (!sanitized) return null;
    const material = sanitized.material;
    const locations = new Set<string>();
    const entity = material.entity;
    if (entity && typeof entity === "object" && !Array.isArray(entity)) {
      const locationId = providerLocationId(
        (entity as Record<string, unknown>).location_id,
      );
      if (locationId) locations.add(locationId);
    }
    if (Array.isArray(material.counts)) {
      for (const value of material.counts) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const locationId = providerLocationId(
          (value as Record<string, unknown>).location_id,
        );
        if (locationId) locations.add(locationId);
      }
    }
    return locations.size === 1 ? [...locations][0] : null;
  }

  if (DISPUTE_EVENT_TYPES.has(event.eventType)) {
    const dispute = event.object.dispute;
    if (dispute && typeof dispute === "object" && !Array.isArray(dispute)) {
      return providerLocationId(
        (dispute as Record<string, unknown>).location_id,
      );
    }
  }
  return null;
}

async function resolveIntegration(
  db: ReturnType<typeof createServiceRoleClient>,
  input: {
    merchantId: string;
    applicationId: string;
    environment: string;
    locationId: string | null;
  },
): Promise<IntegrationRow | null | "unavailable"> {
  const query = db
    .from("square_integrations" as never)
    .select("salon_id, merchant_id, location_id, application_id, environment" as never)
    .eq("merchant_id" as never, input.merchantId)
    .eq("application_id" as never, input.applicationId)
    .eq("environment" as never, input.environment)
    .eq("enabled" as never, true);
  const scopedQuery = input.locationId
    ? query.eq("location_id" as never, input.locationId)
    : query;
  const { data, error } = await scopedQuery.limit(2);
  if (error || !Array.isArray(data)) return "unavailable";
  if (data.length !== 1) return null;
  const row = data[0] as unknown as IntegrationRow;
  if (
    !row.salon_id ||
    row.merchant_id !== input.merchantId ||
    row.application_id !== input.applicationId ||
    row.environment !== input.environment ||
    !row.location_id ||
    (input.locationId !== null && row.location_id !== input.locationId)
  ) {
    return null;
  }
  return row;
}

async function recordOptionalEvent(input: {
  db: ReturnType<typeof createServiceRoleClient>;
  integration: IntegrationRow;
  profile: { applicationId: string; environment: "sandbox" | "production" };
  event: NonNullable<ReturnType<typeof parseSquareEvent>>;
  payloadFingerprint: string;
}) {
  const feature = optionalFeature(input.event.eventType);
  const sanitized = sanitizeSquareOptionalEvent(input.event);
  if (!feature || !sanitized) return json({ ok: false, code: "invalid_event" }, 400);

  const { data: rawContract, error: contractError } = await input.db.rpc(
    "square_feature_contract" as never,
    { p_salon_id: input.integration.salon_id, p_feature: feature } as never,
  );
  if (contractError || !rawContract || typeof rawContract !== "object") {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  const contract = rawContract as unknown as FeatureContract;
  if (
    contract.success !== true ||
    contract.salon_id !== input.integration.salon_id ||
    contract.merchant_id !== input.event.merchantId ||
    contract.location_id !== input.integration.location_id ||
    contract.application_id !== input.profile.applicationId ||
    contract.environment !== input.profile.environment ||
    contract.api_version !== SQUARE_OPTIONAL_API_VERSION ||
    typeof contract.provider_account_fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(contract.provider_account_fingerprint)
  ) {
    return json({ ok: false, code: "provider_context_mismatch" }, 409);
  }

  const material = {
    ...sanitized.material,
    merchant_id: contract.merchant_id,
    application_id: contract.application_id,
    environment: contract.environment,
    api_version: SQUARE_OPTIONAL_API_VERSION,
    provider_account_fingerprint: contract.provider_account_fingerprint,
  };
  const { data: rawRecorded, error: recordError } = await input.db.rpc(
    "record_square_webhook_event" as never,
    {
      p_salon_id: input.integration.salon_id,
      p_event_id: input.event.eventId,
      p_event_type: input.event.eventType,
      p_occurred_at: input.event.occurredAt,
      p_entity_id: sanitized.entityId,
      p_material: material,
      p_payload_fingerprint: input.payloadFingerprint,
    } as never,
  );
  if (recordError || !rawRecorded || typeof rawRecorded !== "object") {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  const recorded = rawRecorded as unknown as { success?: boolean; code?: string; event_id?: string };
  if (
    recorded.success === true &&
    (recorded.code === "event_recorded" || recorded.code === "event_replay") &&
    recorded.event_id === input.event.eventId
  ) {
    return json({ ok: true, code: recorded.code, eventId: input.event.eventId });
  }
  if (recorded.code === "event_conflict") {
    return json({ ok: false, code: "event_conflict" }, 409);
  }
  // Default-off or missing optional capability is an intentional suppression,
  // not permission to call Square or mutate local product state.
  if (["not_ready", "integration_not_found", "invalid_integration"].includes(recorded.code ?? "")) {
    return json({ ok: true, code: "feature_not_ready" });
  }
  return json({ ok: false, code: recorded.code ?? "event_rejected" }, 400);
}

async function recordRefundEvent(input: {
  db: ReturnType<typeof createServiceRoleClient>;
  integration: IntegrationRow;
  profile: { applicationId: string; environment: "sandbox" | "production" };
  event: NonNullable<ReturnType<typeof parseSquareEvent>>;
  payloadFingerprint: string;
}) {
  const refund = sanitizeSquareRefundEvent(input.event);
  if (!refund) return json({ ok: false, code: "invalid_refund_event" }, 400);
  if (refund.locationId !== input.integration.location_id) {
    return json({ ok: false, code: "provider_context_mismatch" }, 409);
  }

  const { data: rawRecorded, error } = await input.db.rpc(
    "record_square_refund_webhook_event" as never,
    {
      p_salon_id: input.integration.salon_id,
      p_event_id: input.event.eventId,
      p_occurred_at: input.event.occurredAt,
      p_payload_fingerprint: input.payloadFingerprint,
      p_provider_refund_id: refund.refundId,
      p_parent_payment_id: refund.paymentId,
      p_location_id: refund.locationId,
      p_provider_status: refund.status,
      p_amount_cents: refund.amountCents,
      p_currency: refund.currency,
      p_refund_updated_at: refund.updatedAt,
      p_merchant_id: input.event.merchantId,
      p_application_id: input.profile.applicationId,
      p_environment: input.profile.environment,
    } as never,
  );
  if (error || !rawRecorded || typeof rawRecorded !== "object") {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  const recorded = rawRecorded as unknown as {
    success?: boolean;
    code?: string;
    event_id?: string;
    result_code?: string;
  };
  const acceptedCodes = new Set([
    "refund_pending",
    "refund_applied",
    "refund_failed",
    "refund_terminal_noop",
    "stale_event_ignored",
    "duplicate_revision_ignored",
    "event_replay",
  ]);
  if (
    recorded.success === true
    && recorded.event_id === input.event.eventId
    && acceptedCodes.has(recorded.code ?? "")
  ) {
    return json({
      ok: true,
      code: recorded.code,
      eventId: input.event.eventId,
      ...(recorded.result_code ? { resultCode: recorded.result_code } : {}),
    });
  }
  if (recorded.code === "operation_not_found") {
    // The exact normalized event remains durable and can be retried after a
    // narrowly timed provider-response/write race creates the operation.
    return json({ ok: false, code: "operation_not_found" }, 503);
  }
  if ([
    "event_conflict",
    "event_replay_rejected",
    "provider_context_mismatch",
    "provider_binding_mismatch",
    "terminal_state_conflict",
    "revision_conflict",
    "operation_state_mismatch",
    "completion_rejected",
  ].includes(recorded.code ?? "")) {
    return json({ ok: false, code: recorded.code ?? "refund_event_rejected" }, 409);
  }
  if (recorded.code === "invalid_refund_event") {
    return json({ ok: false, code: "invalid_refund_event" }, 400);
  }
  return json({ ok: false, code: "webhook_store_unavailable" }, 503);
}

async function recordPaymentEvent(input: {
  db: ReturnType<typeof createServiceRoleClient>;
  integration: IntegrationRow;
  profile: { applicationId: string; environment: "sandbox" | "production" };
  event: NonNullable<ReturnType<typeof parseSquareEvent>>;
  payloadFingerprint: string;
}) {
  const payment = sanitizeSquarePaymentEvent(input.event);
  if (!payment) return json({ ok: false, code: "invalid_payment_event" }, 400);
  if (payment.locationId !== input.integration.location_id) {
    return json({ ok: false, code: "provider_context_mismatch" }, 409);
  }
  const { data, error } = await input.db.rpc(
    "record_square_payment_webhook_event" as never,
    {
      p_salon_id: input.integration.salon_id,
      p_event_id: input.event.eventId,
      p_event_type: input.event.eventType,
      p_occurred_at: input.event.occurredAt,
      p_payload_fingerprint: input.payloadFingerprint,
      p_provider_payment_id: payment.paymentId,
      p_location_id: payment.locationId,
      p_provider_status: payment.status,
      p_amount_cents: payment.amountCents,
      p_currency: payment.currency,
      p_payment_updated_at: payment.updatedAt,
      p_reference_id: payment.referenceId,
      p_merchant_id: input.event.merchantId,
      p_application_id: input.profile.applicationId,
      p_environment: input.profile.environment,
    } as never,
  );
  if (error || !data || typeof data !== "object") {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  const recorded = data as unknown as { success?: boolean; code?: string; event_id?: string };
  if (recorded.success === true && recorded.event_id === input.event.eventId && [
    "payment_applied", "payment_pending", "payment_failed",
    "stale_event_ignored", "event_replay",
  ].includes(recorded.code ?? "")) {
    return json({ ok: true, code: recorded.code, eventId: input.event.eventId });
  }
  if (recorded.code === "operation_not_found") {
    return json({ ok: false, code: "operation_not_found" }, 503);
  }
  if ([
    "event_conflict", "provider_context_mismatch", "provider_binding_mismatch",
    "terminal_state_conflict", "revision_conflict",
  ].includes(recorded.code ?? "")) {
    return json({ ok: false, code: recorded.code ?? "payment_event_rejected" }, 409);
  }
  if (recorded.code === "invalid_payment_event") {
    return json({ ok: false, code: "invalid_payment_event" }, 400);
  }
  return json({ ok: false, code: "webhook_store_unavailable" }, 503);
}

async function recordDispute(input: {
  db: ReturnType<typeof createServiceRoleClient>;
  integration: IntegrationRow;
  event: NonNullable<ReturnType<typeof parseSquareEvent>>;
}) {
  const dispute = input.event.object.dispute as Record<string, unknown> | undefined;
  const disputeId = typeof dispute?.dispute_id === "string"
    ? dispute.dispute_id
    : typeof dispute?.id === "string" ? dispute.id : null;
  if (!dispute || !disputeId) return json({ ok: false, code: "invalid_dispute" }, 400);

  const disputedPayment = dispute.disputed_payment as { payment_id?: unknown } | undefined;
  const paymentId = typeof disputedPayment?.payment_id === "string"
    ? disputedPayment.payment_id
    : null;
  type BookingLookup = { id: string; salon_id: string; client_phone: string | null } | null;
  let bookingRow: BookingLookup = null;
  if (paymentId) {
    const { data, error } = await input.db
      .from("bookings" as never)
      .select("id, salon_id, client_phone")
      .eq("salon_id" as never, input.integration.salon_id)
      .eq("noshow_payment_id" as never, paymentId)
      .maybeSingle();
    if (error) return json({ ok: false, code: "webhook_store_unavailable" }, 503);
    bookingRow = data as BookingLookup;
  }

  const amountMoney = dispute.amount_money as { amount?: unknown; currency?: unknown } | undefined;
  const amountCents = Number.isSafeInteger(amountMoney?.amount) ? amountMoney?.amount as number : null;
  const currency = typeof amountMoney?.currency === "string" ? amountMoney.currency : null;
  const { error: upsertError } = await input.db
    .from("payment_disputes" as never)
    .upsert(
      {
        provider: "square",
        provider_dispute_id: disputeId,
        payment_ref: paymentId,
        booking_id: bookingRow?.id ?? null,
        salon_id: input.integration.salon_id,
        client_phone: bookingRow?.client_phone ?? null,
        amount_cents: amountCents,
        currency,
        reason: typeof dispute.reason === "string" ? dispute.reason : null,
        status: typeof dispute.state === "string" ? dispute.state : null,
        evidence_due_at: typeof dispute.due_at === "string" ? dispute.due_at : null,
        raw: dispute,
        updated_at: new Date().toISOString(),
      } as never,
      { onConflict: "provider_dispute_id" },
    );
  if (upsertError) return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  return json({ ok: true, code: "dispute_recorded" });
}

export async function POST(request: Request) {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "unsupported_media_type" }, 415);
  }
  const profile = resolveSquareWebhookProfile(request.url);
  if (!profile) return json({ ok: false, code: "webhook_not_configured" }, 503);

  const body = await readSquareWebhookBody(request);
  if (!body.ok) return json({ ok: false, code: body.code }, body.code === "body_too_large" ? 413 : 400);
  if (!verifySquareWebhookSignature({
    profile,
    body: body.bytes,
    signatureHeader: request.headers.get("x-square-hmacsha256-signature"),
  })) {
    return json({ ok: false, code: "invalid_signature" }, 401);
  }

  const event = parseSquareEvent(body.text);
  if (!event) return json({ ok: false, code: "invalid_event" }, 400);
  if (
    event.eventType !== "refund.updated"
    && event.eventType !== "payment.created"
    && event.eventType !== "payment.updated"
    && !isSquareOptionalWebhookEvent(event.eventType)
    && !DISPUTE_EVENT_TYPES.has(event.eventType)
  ) {
    return json({ ok: true, code: "event_ignored" });
  }

  // The service-role boundary is intentionally constructed only after a valid
  // constant-time signature check and strict event-envelope parse.
  const db = createServiceRoleClient();
  const integration = await resolveIntegration(db, {
    merchantId: event.merchantId,
    applicationId: profile.applicationId,
    environment: profile.environment,
    locationId: squareWebhookLocationId(event),
  });
  if (integration === "unavailable") {
    return json({ ok: false, code: "webhook_store_unavailable" }, 503);
  }
  if (!integration) return json({ ok: false, code: "provider_context_mismatch" }, 401);

  if (isSquareOptionalWebhookEvent(event.eventType)) {
    return recordOptionalEvent({
      db,
      integration,
      profile,
      event,
      payloadFingerprint: squareWebhookPayloadFingerprint(body.bytes),
    });
  }
  if (event.eventType === "refund.updated") {
    return recordRefundEvent({
      db,
      integration,
      profile,
      event,
      payloadFingerprint: squareWebhookPayloadFingerprint(body.bytes),
    });
  }
  if (event.eventType === "payment.created" || event.eventType === "payment.updated") {
    return recordPaymentEvent({
      db,
      integration,
      profile,
      event,
      payloadFingerprint: squareWebhookPayloadFingerprint(body.bytes),
    });
  }
  return recordDispute({ db, integration, event });
}
