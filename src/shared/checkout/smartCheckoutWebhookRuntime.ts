import "server-only";

import { createHash } from "node:crypto";
import type Stripe from "stripe";

import type { ParsedSquareEvent } from "@/shared/integrations/square/webhookRuntime";
import type { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export const MAX_SMART_CHECKOUT_WEBHOOK_BYTES = 256 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROVIDER_ID_RE = /^[!-~]{1,255}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type SmartCheckoutWebhookMaterial = {
  sessionId: string | null;
  providerLocationId: string | null;
  providerDeviceId: string | null;
  providerCheckoutId: string | null;
  providerPaymentId: string | null;
  providerStatus: string;
  amountCents: number | null;
  currency: string | null;
  occurredAt: string;
  failureCode: string | null;
  providerApplicationId?: string | null;
  claimedSalonId?: string | null;
};

export type SmartCheckoutWebhookBinding = {
  sessionId: string;
  salonId: string;
  deviceId: string;
  providerLocationId: string;
  providerDeviceId: string;
  providerCheckoutId: string | null;
  providerPaymentId: string | null;
  amountCents: number;
  currency: string;
};

type ServiceDb = ReturnType<typeof createServiceRoleClient>;

type SessionRow = {
  id: string;
  salon_id: string;
  provider: "square" | "stripe";
  provider_account_fingerprint: string;
  provider_location_id: string | null;
  device_id: string | null;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  amount_due_cents: number;
  currency: string;
};

type DeviceRow = {
  id: string;
  salon_id: string;
  provider: "square" | "stripe";
  provider_account_fingerprint: string;
  provider_device_id: string;
  provider_location_id: string | null;
  disabled_at: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerId(value: unknown): string | null {
  return typeof value === "string" && PROVIDER_ID_RE.test(value) ? value : null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value.toLowerCase() : null;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && RFC3339_RE.test(value)
    && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function money(value: unknown): { amount: number; currency: string } | null {
  const row = record(value);
  const amount = row?.amount;
  const currency = row?.currency;
  return Number.isSafeInteger(amount) && (amount as number) > 0
    && (amount as number) <= 2_147_483_647
    && typeof currency === "string" && /^[A-Z]{3}$/.test(currency)
    ? { amount: amount as number, currency }
    : null;
}

export function allowsSmartCheckoutSandboxWebhookIngestion(): boolean {
  return process.env.SMART_CHECKOUT_SANDBOX_WEBHOOK_INGESTION_ENABLED === "1"
    && process.env.SMART_CHECKOUT_PROVIDER_ENVIRONMENT === "sandbox";
}

export async function readSmartCheckoutWebhookBody(
  request: Request,
): Promise<{ ok: true; bytes: Uint8Array; text: string } | { ok: false; code: string }> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SMART_CHECKOUT_WEBHOOK_BYTES) {
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
      if (total > MAX_SMART_CHECKOUT_WEBHOOK_BYTES) {
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

export function smartCheckoutWebhookPayloadFingerprint(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

export function smartCheckoutProviderAccountFingerprint(
  provider: "square" | "stripe",
  providerAccountId: string,
): string | null {
  const accountId = providerAccountId.trim();
  if (!providerId(accountId)) return null;
  return createHash("sha256").update(`${provider}:${accountId}`, "utf8").digest("hex");
}

/**
 * Binds a verified, normalized provider event to one existing session and one
 * registered device. No raw body, provider account ID, card data, or customer
 * identity enters this boundary.
 */
export async function resolveSmartCheckoutWebhookBinding(
  db: ServiceDb,
  input: {
    provider: "square" | "stripe";
    salonId: string;
    providerAccountFingerprint: string;
    material: SmartCheckoutWebhookMaterial;
  },
): Promise<SmartCheckoutWebhookBinding | null | "unavailable"> {
  const sessionQuery = db
    .from("smart_checkout_sessions" as never)
    .select(
      "id, salon_id, provider, provider_account_fingerprint, provider_location_id, device_id, provider_checkout_id, provider_payment_id, amount_due_cents, currency" as never,
    )
    .eq("provider" as never, input.provider)
    .eq("provider_account_fingerprint" as never, input.providerAccountFingerprint);
  if (input.material.sessionId) {
    sessionQuery.eq("id" as never, input.material.sessionId);
  } else if (input.material.providerCheckoutId) {
    sessionQuery.eq("provider_checkout_id" as never, input.material.providerCheckoutId);
  } else if (input.material.providerPaymentId) {
    sessionQuery.eq("provider_payment_id" as never, input.material.providerPaymentId);
  } else {
    return null;
  }
  const { data: sessionData, error: sessionError } = await sessionQuery.limit(2);
  if (sessionError || !Array.isArray(sessionData)) return "unavailable";
  if (sessionData.length !== 1) return null;
  const session = sessionData[0] as unknown as SessionRow;
  if (
    session.id !== (input.material.sessionId ?? session.id)
    || session.salon_id !== input.salonId
    || session.provider !== input.provider
    || session.provider_account_fingerprint !== input.providerAccountFingerprint
    || !session.device_id
    || !Number.isSafeInteger(session.amount_due_cents) || session.amount_due_cents < 0
    || !/^[A-Z]{3}$/.test(session.currency)
    || (input.material.providerLocationId !== null
      && session.provider_location_id !== input.material.providerLocationId)
    || (session.provider_checkout_id !== null && input.material.providerCheckoutId !== null
      && session.provider_checkout_id !== input.material.providerCheckoutId)
    || (session.provider_payment_id !== null && input.material.providerPaymentId !== null
      && session.provider_payment_id !== input.material.providerPaymentId)
    || (input.material.amountCents !== null
      && session.amount_due_cents !== input.material.amountCents)
    || (input.material.currency !== null && session.currency !== input.material.currency)
  ) return null;

  const { data: deviceData, error: deviceError } = await db
    .from("smart_checkout_devices" as never)
    .select(
      "id, salon_id, provider, provider_account_fingerprint, provider_device_id, provider_location_id, disabled_at" as never,
    )
    .eq("id" as never, session.device_id)
    .eq("salon_id" as never, input.salonId)
    .eq("provider" as never, input.provider)
    .limit(2);
  if (deviceError || !Array.isArray(deviceData)) return "unavailable";
  if (deviceData.length !== 1) return null;
  const device = deviceData[0] as unknown as DeviceRow;
  if (
    device.id !== session.device_id || device.salon_id !== input.salonId
    || device.provider !== input.provider || device.disabled_at !== null
    || device.provider_account_fingerprint !== input.providerAccountFingerprint
    || !device.provider_location_id
    || session.provider_location_id !== device.provider_location_id
    || (input.material.providerLocationId !== null
      && input.material.providerLocationId !== device.provider_location_id)
    || (input.material.providerDeviceId !== null
      && input.material.providerDeviceId !== device.provider_device_id)
  ) return null;

  return {
    sessionId: session.id,
    salonId: session.salon_id,
    deviceId: session.device_id,
    providerLocationId: device.provider_location_id,
    providerDeviceId: device.provider_device_id,
    providerCheckoutId: input.material.providerCheckoutId ?? session.provider_checkout_id,
    providerPaymentId: input.material.providerPaymentId ?? session.provider_payment_id,
    amountCents: session.amount_due_cents,
    currency: session.currency,
  };
}

export function sanitizeSquareTerminalCheckoutEvent(
  event: ParsedSquareEvent,
): SmartCheckoutWebhookMaterial | null {
  if (event.eventType !== "terminal.checkout.created"
    && event.eventType !== "terminal.checkout.updated") return null;
  const checkout = record(event.object.checkout);
  const checkoutId = providerId(checkout?.id);
  const appId = providerId(checkout?.app_id);
  const locationId = providerId(checkout?.location_id);
  const deviceId = providerId(record(checkout?.device_options)?.device_id);
  const referenceId = uuid(checkout?.reference_id);
  const status = checkout?.status;
  const amount = money(checkout?.amount_money);
  const updatedAt = timestamp(checkout?.updated_at);
  const paymentIds = checkout?.payment_ids == null ? [] : checkout.payment_ids;
  if (
    !checkout || !checkoutId || event.dataId !== checkoutId || !appId || !locationId
    || !deviceId || !referenceId || !amount || !updatedAt
    || !["PENDING", "IN_PROGRESS", "CANCEL_REQUESTED", "CANCELED", "COMPLETED"].includes(
      typeof status === "string" ? status : "",
    )
    || !Array.isArray(paymentIds) || paymentIds.length > 1
  ) return null;
  const paymentId = paymentIds.length === 1 ? providerId(paymentIds[0]) : null;
  if ((paymentIds.length === 1 && !paymentId) || (status === "COMPLETED" && !paymentId)) {
    return null;
  }
  const cancelReason = checkout.cancel_reason == null
    ? null
    : typeof checkout.cancel_reason === "string"
      && /^[A-Z0-9_]{1,64}$/.test(checkout.cancel_reason)
      ? checkout.cancel_reason.toLowerCase()
      : null;
  if (checkout.cancel_reason != null && !cancelReason) return null;

  return {
    sessionId: referenceId,
    providerLocationId: locationId,
    providerDeviceId: deviceId,
    providerCheckoutId: checkoutId,
    providerPaymentId: paymentId,
    providerStatus: status as string,
    amountCents: amount.amount,
    currency: amount.currency,
    occurredAt: updatedAt,
    failureCode: status === "CANCELED" ? cancelReason ?? "terminal_cancelled" : null,
    providerApplicationId: appId,
  };
}

export function sanitizeSquareTerminalPaymentEvent(
  event: ParsedSquareEvent,
): SmartCheckoutWebhookMaterial | null {
  if (event.eventType !== "payment.created" && event.eventType !== "payment.updated") {
    return null;
  }
  const payment = record(event.object.payment);
  const paymentId = providerId(payment?.id);
  const locationId = providerId(payment?.location_id);
  const referenceId = uuid(payment?.reference_id);
  const status = payment?.status;
  const amount = money(payment?.amount_money);
  const updatedAt = timestamp(payment?.updated_at);
  if (
    !payment || !paymentId || event.dataId !== paymentId || !locationId
    || !referenceId || !amount || !updatedAt
    || !["APPROVED", "PENDING", "COMPLETED", "CANCELED", "FAILED"].includes(
      typeof status === "string" ? status : "",
    )
  ) return null;
  return {
    sessionId: referenceId,
    providerLocationId: locationId,
    providerDeviceId: null,
    providerCheckoutId: null,
    providerPaymentId: paymentId,
    providerStatus: status as string,
    amountCents: amount.amount,
    currency: amount.currency,
    occurredAt: updatedAt,
    failureCode: status === "FAILED" || status === "CANCELED"
      ? `payment_${String(status).toLowerCase()}`
      : null,
  };
}

function stripeProviderId(value: unknown): string | null {
  if (typeof value === "string") return providerId(value);
  const row = record(value);
  return providerId(row?.id);
}

function stripeOccurredAt(event: Stripe.Event): string | null {
  return Number.isSafeInteger(event.created) && event.created > 0
    ? new Date(event.created * 1000).toISOString()
    : null;
}

export function sanitizeStripeTerminalEvent(
  event: Stripe.Event,
): SmartCheckoutWebhookMaterial | null {
  const occurredAt = stripeOccurredAt(event);
  if (!occurredAt || event.livemode !== false) return null;

  if ([
    "payment_intent.processing",
    "payment_intent.amount_capturable_updated",
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "payment_intent.canceled",
  ].includes(event.type)) {
    const intent = event.data.object as Stripe.PaymentIntent;
    const intentId = providerId(intent.id);
    const sessionId = uuid(intent.metadata?.nailiq_operation_id);
    const salonId = uuid(intent.metadata?.nailiq_salon_id);
    const paymentMethodTypes = intent.payment_method_types;
    const latestCharge = stripeProviderId(intent.latest_charge);
    if (
      intent.object !== "payment_intent" || intent.livemode !== false
      || !intentId || !sessionId || !salonId
      || !Number.isSafeInteger(intent.amount) || intent.amount <= 0
      || intent.amount > 2_147_483_647 || !/^[a-z]{3}$/.test(intent.currency)
      || !Array.isArray(paymentMethodTypes)
      || paymentMethodTypes.length !== 1 || paymentMethodTypes[0] !== "card_present"
    ) return null;
    return {
      sessionId,
      providerLocationId: null,
      providerDeviceId: null,
      providerCheckoutId: intentId,
      providerPaymentId: latestCharge,
      providerStatus: intent.status,
      amountCents: intent.amount,
      currency: intent.currency.toUpperCase(),
      occurredAt,
      failureCode: event.type === "payment_intent.payment_failed"
        ? providerId(intent.last_payment_error?.code)?.toLowerCase() ?? "payment_failed"
        : event.type === "payment_intent.canceled"
          ? providerId(intent.cancellation_reason)?.toLowerCase() ?? "payment_cancelled"
          : null,
      claimedSalonId: salonId,
    };
  }

  if (event.type !== "terminal.reader.action_succeeded"
    && event.type !== "terminal.reader.action_failed") return null;
  const reader = event.data.object as Stripe.Terminal.Reader;
  const action = reader.action;
  if (
    reader.object !== "terminal.reader" || reader.livemode !== false || !action
    || (action.type !== "process_payment_intent" && action.type !== "confirm_payment_intent")
  ) return null;
  const detail = action.type === "process_payment_intent"
    ? action.process_payment_intent
    : action.confirm_payment_intent;
  const paymentIntentId = stripeProviderId(detail?.payment_intent);
  const readerId = providerId(reader.id);
  const locationId = stripeProviderId(reader.location);
  if (!paymentIntentId || !readerId || !locationId) return null;
  return {
    sessionId: null,
    providerLocationId: locationId,
    providerDeviceId: readerId,
    providerCheckoutId: paymentIntentId,
    providerPaymentId: null,
    providerStatus: action.status,
    amountCents: null,
    currency: null,
    occurredAt,
    failureCode: event.type === "terminal.reader.action_failed"
      ? providerId(action.failure_code)?.toLowerCase() ?? "reader_action_failed"
      : null,
  };
}
