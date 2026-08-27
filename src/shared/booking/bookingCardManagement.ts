import "server-only";

import { createHash } from "node:crypto";

import { resolvePaymentProvider, type PaymentProvider } from "@/shared/integrations/payments";
import { getStripeClient } from "@/shared/lib/stripe";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type CardOperationResult = {
  ok: boolean;
  code: string;
  idempotent?: boolean;
  bookingId?: string;
  salonId?: string;
  finalizeTokenId?: string;
  finalizeExpiresAt?: string;
  providerReference?: string;
};

type ClaimedOperation = {
  operationId: string;
  attemptToken: string;
  providerIdempotencyKey: string;
  attemptReplay: boolean;
  bookingId: string;
  salonId: string;
  provider: "square" | "stripe";
  mode: "save_card" | "setup_intent";
  providerMaterial: {
    clientName: string | null;
    clientPhone: string | null;
    clientEmail: string | null;
    feeCents: number;
    currency: string;
    salonName: string;
    cancellationPolicy: string | null;
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;

function row(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeCode(value: unknown): string {
  const code = cleanString(value);
  return code && /^[a-z0-9_]{1,64}$/.test(code) ? code : "card_management_unavailable";
}

export function cardSourceFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseResult(value: unknown): CardOperationResult {
  const valueRow = row(value);
  if (!valueRow) return { ok: false, code: "invalid_card_operation_response" };
  const code = safeCode(valueRow.code);
  const bookingId = cleanString(valueRow.booking_id) ?? undefined;
  const salonId = cleanString(valueRow.salon_id) ?? undefined;
  const finalizeTokenId = cleanString(valueRow.finalize_token_id) ?? undefined;
  const finalizeExpiresAt = cleanString(valueRow.finalize_expires_at) ?? undefined;
  const providerReference = cleanString(valueRow.provider_reference) ?? undefined;
  if ((bookingId && !UUID_RE.test(bookingId)) || (salonId && !UUID_RE.test(salonId)) ||
      (finalizeTokenId && !UUID_RE.test(finalizeTokenId)) ||
      (finalizeExpiresAt && !Number.isFinite(Date.parse(finalizeExpiresAt))) ||
      typeof valueRow.ok !== "boolean" ||
      (valueRow.idempotent != null && typeof valueRow.idempotent !== "boolean")) {
    return { ok: false, code: "invalid_card_operation_response" };
  }
  return {
    ok: valueRow.ok,
    code,
    idempotent: typeof valueRow.idempotent === "boolean" ? valueRow.idempotent : undefined,
    bookingId,
    salonId,
    finalizeTokenId,
    finalizeExpiresAt,
    providerReference,
  };
}

function parseClaim(value: unknown): ClaimedOperation | CardOperationResult {
  const valueRow = row(value);
  if (!valueRow || valueRow.ok !== true || valueRow.code !== "claimed") return parseResult(value);
  const operationId = cleanString(valueRow.operation_id);
  const attemptToken = cleanString(valueRow.attempt_token);
  const providerIdempotencyKey = cleanString(valueRow.provider_idempotency_key);
  const attemptReplay = valueRow.attempt_replay;
  const bookingId = cleanString(valueRow.booking_id);
  const salonId = cleanString(valueRow.salon_id);
  const provider = valueRow.provider === "square" || valueRow.provider === "stripe"
    ? valueRow.provider
    : null;
  const mode = valueRow.mode === "save_card" || valueRow.mode === "setup_intent"
    ? valueRow.mode
    : null;
  const material = row(valueRow.provider_material);
  const feeCents = material?.fee_cents;
  const currency = cleanString(material?.currency);
  const salonName = cleanString(material?.salon_name);
  if (!operationId || !attemptToken || !providerIdempotencyKey || !bookingId || !salonId ||
      !UUID_RE.test(operationId) || !UUID_RE.test(attemptToken) ||
      !UUID_RE.test(providerIdempotencyKey) || typeof attemptReplay !== "boolean" ||
      !UUID_RE.test(bookingId) || !UUID_RE.test(salonId) || !provider || !mode || !material ||
      typeof feeCents !== "number" || !Number.isSafeInteger(feeCents) || feeCents < 0 ||
      !currency || currency.length > 8 || !salonName || salonName.length > 200) {
    return { ok: false, code: "invalid_card_operation_response" };
  }
  return {
    operationId,
    attemptToken,
    providerIdempotencyKey,
    attemptReplay,
    bookingId,
    salonId,
    provider,
    mode,
    providerMaterial: {
      clientName: cleanString(material.client_name),
      clientPhone: cleanString(material.client_phone),
      clientEmail: cleanString(material.client_email),
      feeCents,
      currency: currency.toUpperCase(),
      salonName,
      cancellationPolicy: cleanString(material.cancellation_policy),
    },
  };
}

async function completeRemoval(input: {
  operationId: string;
  attemptToken: string;
  outcome: "succeeded" | "failed" | "unknown";
  providerReference?: string | null;
  errorCode?: string | null;
}): Promise<CardOperationResult> {
  const { data, error } = await createServiceRoleClient().rpc(
    "complete_booking_card_management_operation" as never,
    {
      p_operation_id: input.operationId,
      p_attempt_token: input.attemptToken,
      p_outcome: input.outcome,
      p_provider_reference: input.providerReference ?? null,
      p_error_code: input.errorCode ?? null,
    } as never,
  );
  return error ? { ok: false, code: "completion_write_uncertain" } : parseResult(data);
}

export async function removeCardWithManagementCapability(input: {
  tokenId: string;
  requestId: string;
  expectedCardFingerprint: string;
}): Promise<CardOperationResult> {
  if (!UUID_RE.test(input.tokenId) || !UUID_RE.test(input.requestId) ||
      !HASH_RE.test(input.expectedCardFingerprint)) {
    return { ok: false, code: "invalid_request" };
  }
  const { data, error } = await createServiceRoleClient().rpc(
    "claim_booking_card_management_operation" as never,
    {
      p_token_id: input.tokenId,
      p_request_id: input.requestId,
      p_expected_card_fingerprint: input.expectedCardFingerprint,
    } as never,
  );
  if (error) return { ok: false, code: "card_management_unavailable" };
  const claim = row(data);
  if (!claim || claim.ok !== true || claim.code !== "claimed") return parseResult(data);
  const operationId = cleanString(claim.operation_id);
  const attemptToken = cleanString(claim.attempt_token);
  const providerIdempotencyKey = cleanString(claim.provider_idempotency_key);
  const salonId = cleanString(claim.salon_id);
  const providerMaterial = row(claim.provider_material);
  const cardId = cleanString(providerMaterial?.card_id);
  const customerId = typeof providerMaterial?.customer_id === "string"
    ? providerMaterial.customer_id.trim()
    : null;
  if (!operationId || !attemptToken || !providerIdempotencyKey || !salonId ||
      !UUID_RE.test(operationId) || !UUID_RE.test(attemptToken) || !cardId || customerId == null) {
    return { ok: false, code: "invalid_card_operation_response" };
  }
  let provider: PaymentProvider | null;
  try {
    provider = await resolvePaymentProvider(salonId, { strict: true });
  } catch {
    // No provider request occurred. Keep the DB operation recoverable so an
    // exact retry/reconciler can resume after the configuration read recovers.
    return { ok: false, code: "card_management_unavailable" };
  }
  if (!provider) {
    return completeRemoval({ operationId, attemptToken, outcome: "failed", errorCode: "provider_configuration_invalid" });
  }
  try {
    const receipt = await provider.removeSavedCard({ cardId, customerId });
    if (!cleanString(receipt.providerReference)) {
      return completeRemoval({ operationId, attemptToken, outcome: "unknown", errorCode: "invalid_provider_receipt" });
    }
    return completeRemoval({
      operationId,
      attemptToken,
      outcome: "succeeded",
      providerReference: receipt.providerReference,
    });
  } catch {
    return completeRemoval({ operationId, attemptToken, outcome: "unknown", errorCode: "provider_exception" });
  }
}

async function completeSave(input: {
  operationId: string;
  attemptToken: string;
  outcome: "succeeded" | "failed" | "unknown";
  providerReference?: string | null;
  cardId?: string | null;
  customerId?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  consentAt?: string | null;
  consentMeta?: Record<string, unknown> | null;
  errorCode?: string | null;
}): Promise<CardOperationResult> {
  const { data, error } = await createServiceRoleClient().rpc(
    "complete_booking_card_save_operation" as never,
    {
      p_operation_id: input.operationId,
      p_attempt_token: input.attemptToken,
      p_outcome: input.outcome,
      p_provider_reference: input.providerReference ?? null,
      p_card_id: input.cardId ?? null,
      p_customer_id: input.customerId ?? null,
      p_card_brand: input.cardBrand ?? null,
      p_card_last4: input.cardLast4 ?? null,
      p_consent_at: input.consentAt ?? null,
      p_consent_meta: input.consentMeta ?? null,
      p_error_code: input.errorCode ?? null,
    } as never,
  );
  return error ? { ok: false, code: "completion_write_uncertain" } : parseResult(data);
}

async function claimSave(input: {
  tokenId: string;
  requestId: string;
  provider: "square" | "stripe";
  mode: "save_card" | "setup_intent";
  sourceFingerprint: string;
}): Promise<ClaimedOperation | CardOperationResult> {
  const { data, error } = await createServiceRoleClient().rpc(
    "claim_booking_card_save_operation" as never,
    {
      p_token_id: input.tokenId,
      p_request_id: input.requestId,
      p_provider: input.provider,
      p_mode: input.mode,
      p_source_fingerprint: input.sourceFingerprint,
    } as never,
  );
  return error ? { ok: false, code: "card_management_unavailable" } : parseClaim(data);
}

function isClaim(value: ClaimedOperation | CardOperationResult): value is ClaimedOperation {
  return "operationId" in value;
}

export async function saveCardWithManagementCapability(input: {
  tokenId: string;
  requestId: string;
  provider: "square" | "stripe";
  sourceToken: string;
  verificationToken?: string;
}): Promise<CardOperationResult> {
  if (!UUID_RE.test(input.tokenId) || !UUID_RE.test(input.requestId) ||
      !input.sourceToken.trim() || input.sourceToken.length > 2048) return { ok: false, code: "invalid_request" };
  const claim = await claimSave({
    tokenId: input.tokenId,
    requestId: input.requestId,
    provider: input.provider,
    mode: "save_card",
    sourceFingerprint: cardSourceFingerprint(input.sourceToken.trim()),
  });
  if (!isClaim(claim)) return claim;
  if (claim.provider !== input.provider || claim.mode !== "save_card") {
    return { ok: false, code: "invalid_card_operation_response" };
  }
  // A replayed `sending` claim means the earlier request may already have
  // reached the provider. The stored source fingerprint is not a receipt and a
  // fresh dispatch would be blind, even with the same idempotency key. Leave it
  // for read/reconciliation or manual recovery instead.
  if (claim.attemptReplay) {
    return {
      ok: false,
      code: "reconciliation_required",
      bookingId: claim.bookingId,
      salonId: claim.salonId,
    };
  }
  let provider: PaymentProvider | null;
  try {
    provider = await resolvePaymentProvider(claim.salonId, { strict: true });
  } catch {
    return { ok: false, code: "card_management_unavailable" };
  }
  if (!provider || provider.kind !== input.provider) {
    return completeSave({
      operationId: claim.operationId, attemptToken: claim.attemptToken,
      outcome: "failed", errorCode: "provider_configuration_invalid",
    });
  }
  const consentAt = new Date().toISOString();
  const consentMeta = {
    v: 1,
    source: "booking_card_manage",
    fee_cents: claim.providerMaterial.feeCents,
    currency: claim.providerMaterial.currency,
    cancellation_policy: claim.providerMaterial.cancellationPolicy,
  };
  try {
    const saved = await provider.saveCardOnFile({
      customer: {
        name: claim.providerMaterial.clientName,
        phone: claim.providerMaterial.clientPhone,
        email: claim.providerMaterial.clientEmail,
        referenceId: `booking:${claim.bookingId}`,
      },
      sourceToken: input.sourceToken.trim(),
      verificationToken: input.verificationToken,
      idempotencyKey: claim.providerIdempotencyKey,
    });
    if (!saved.cardId.trim() || !saved.last4.match(/^\d{4}$/) || !saved.brand.trim()) {
      return completeSave({
        operationId: claim.operationId, attemptToken: claim.attemptToken,
        outcome: "unknown", errorCode: "invalid_provider_receipt",
      });
    }
    return completeSave({
      operationId: claim.operationId,
      attemptToken: claim.attemptToken,
      outcome: "succeeded",
      providerReference: saved.cardId,
      cardId: saved.cardId,
      customerId: saved.customerId,
      cardBrand: saved.brand,
      cardLast4: saved.last4,
      consentAt,
      consentMeta,
    });
  } catch {
    return completeSave({
      operationId: claim.operationId, attemptToken: claim.attemptToken,
      outcome: "unknown", errorCode: "provider_exception",
    });
  }
}

export async function createStripeSetupWithManagementCapability(input: {
  tokenId: string;
  requestId: string;
}): Promise<CardOperationResult & { clientSecret?: string }> {
  const claim = await claimSave({
    tokenId: input.tokenId,
    requestId: input.requestId,
    provider: "stripe",
    mode: "setup_intent",
    sourceFingerprint: cardSourceFingerprint("stripe_setup_intent:v1"),
  });
  if (!isClaim(claim)) {
    if (claim.ok && claim.code === "setup_created" && claim.providerReference) {
      const stripe = getStripeClient();
      if (!stripe) return { ok: false, code: "provider_configuration_invalid" };
      try {
        const existing = await stripe.setupIntents.retrieve(claim.providerReference);
        return { ...claim, clientSecret: existing.client_secret ?? undefined };
      } catch {
        return { ok: false, code: "setup_retrieval_unavailable" };
      }
    }
    return claim;
  }
  if (claim.provider !== "stripe" || claim.mode !== "setup_intent") {
    return { ok: false, code: "invalid_card_operation_response" };
  }
  if (claim.attemptReplay) {
    return {
      ok: false,
      code: "reconciliation_required",
      bookingId: claim.bookingId,
      salonId: claim.salonId,
    };
  }
  let provider: PaymentProvider | null;
  try {
    provider = await resolvePaymentProvider(claim.salonId, { strict: true });
  } catch {
    return { ok: false, code: "card_management_unavailable" };
  }
  const stripe = getStripeClient();
  if (!provider || provider.kind !== "stripe" || !stripe) {
    return completeSave({
      operationId: claim.operationId, attemptToken: claim.attemptToken,
      outcome: "failed", errorCode: "provider_configuration_invalid",
    });
  }
  try {
    const setup = await stripe.setupIntents.create({
      usage: "off_session",
      automatic_payment_methods: { enabled: true },
      metadata: { bookingId: claim.bookingId, purpose: "noshow_card_on_file" },
    }, { idempotencyKey: claim.providerIdempotencyKey });
    if (!setup.id.trim() || !setup.client_secret) {
      return completeSave({
        operationId: claim.operationId, attemptToken: claim.attemptToken,
        outcome: "unknown", errorCode: "invalid_provider_receipt",
      });
    }
    const completed = await completeSave({
      operationId: claim.operationId,
      attemptToken: claim.attemptToken,
      outcome: "succeeded",
      providerReference: setup.id,
    });
    return { ...completed, clientSecret: completed.ok ? setup.client_secret : undefined };
  } catch {
    return completeSave({
      operationId: claim.operationId, attemptToken: claim.attemptToken,
      outcome: "unknown", errorCode: "provider_exception",
    });
  }
}
