import { createHash } from "node:crypto";

export type BookingPaymentOperationKind =
  | "deposit_charge"
  | "noshow_charge"
  | "late_cancel_charge"
  | "deposit_refund"
  | "noshow_refund"
  | "late_cancel_refund";

export type BookingPaymentProvider = "square" | "stripe";

export type BookingPaymentOperationMaterial = {
  salonId: string;
  bookingId: string | null;
  operationKind: BookingPaymentOperationKind;
  provider: BookingPaymentProvider;
  providerAccountFingerprint: string;
  amountCents: number;
  currency: string;
  parentPaymentId: string | null;
  parentOperationId: string | null;
  operationOccurrenceVersion: number | null;
  capturedCents: number;
  refundedCents: number;
  reservedCents: number;
  remainingRefundableCents: number;
  materialFingerprint: string;
  providerMaterial: {
    providerAccountId: string;
    providerLocationId: string | null;
    providerEnvironment: "sandbox" | "production" | null;
    currency: string;
    savedCardId: string | null;
    customerId: string | null;
    parentPaymentId: string | null;
  };
};

export type ClaimedBookingPaymentOperation = {
  operationId: string;
  attemptToken: string;
  providerIdempotencyKey: string;
  leaseExpiresAt: string;
  attemptCount: number;
  material: BookingPaymentOperationMaterial;
};

export type PublicDepositPaymentMaterial = {
  salonId: string;
  serviceId: string;
  staffId: string;
  startTimeUtc: string;
  endTimeUtc: string;
  bookingIdempotencyKey: string;
  pricingFingerprint: string;
  clientPhoneFingerprint: string;
  provider: BookingPaymentProvider;
  providerAccountFingerprint: string;
  amountCents: number;
  currency: string;
  depositReason: string;
  materialFingerprint: string;
  providerMaterial: {
    providerAccountId: string;
    providerLocationId: string | null;
    providerApplicationId: string | null;
    providerEnvironment: "sandbox" | "production" | null;
    currency: string;
    amountCents: number;
    bookingIntentReference: string;
    pricingFingerprint: string;
  };
};

export type ClaimedPublicDepositPaymentOperation = {
  operationId: string;
  attemptToken: string;
  providerIdempotencyKey: string;
  leaseExpiresAt: string;
  attemptCount: number;
  material: PublicDepositPaymentMaterial;
};

const HASH_RE = /^[0-9a-f]{64}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= max ? cleaned : null;
}

function nullableBoundedString(value: unknown, max: number): string | null | undefined {
  return value == null ? null : boundedString(value, max) ?? undefined;
}

export function isBookingPaymentOperationKind(
  value: unknown,
): value is BookingPaymentOperationKind {
  return value === "deposit_charge" || value === "noshow_charge" ||
    value === "late_cancel_charge" || value === "deposit_refund" ||
    value === "noshow_refund" || value === "late_cancel_refund";
}

/**
 * Strictly parses DB-owned monetary material. It accepts no browser/provider
 * aliases and performs no money coercion. RPC wrapper parsing is added only
 * after the database locks its final result codes and nesting.
 */
export function parseBookingPaymentOperationMaterial(
  value: unknown,
  operationKind: BookingPaymentOperationKind,
): BookingPaymentOperationMaterial | null {
  const row = record(value);
  if (!row) return null;

  const salonId = boundedString(row.salon_id, 36);
  const bookingId = row.booking_id == null
    ? null
    : boundedString(row.booking_id, 36);
  const parsedKind = isBookingPaymentOperationKind(row.operation_kind)
    ? row.operation_kind
    : null;
  const provider = row.provider === "square" || row.provider === "stripe"
    ? row.provider
    : null;
  const providerAccountFingerprint = boundedString(
    row.provider_account_fingerprint,
    64,
  );
  const amountCents = integer(row.amount_cents);
  const currency = boundedString(row.currency, 3)?.toUpperCase() ?? null;
  const parentPaymentId = row.parent_payment_id == null
    ? null
    : boundedString(row.parent_payment_id, 255);
  const parentOperationId = row.parent_operation_id == null
    ? null
    : boundedString(row.parent_operation_id, 36);
  const operationOccurrenceVersion = row.operation_occurrence_version == null
    ? null
    : integer(row.operation_occurrence_version);
  const capturedCents = integer(row.captured_cents);
  const refundedCents = integer(row.refunded_cents);
  const reservedCents = integer(row.reserved_cents);
  const remainingRefundableCents = integer(row.remaining_refundable_cents);
  const materialFingerprint = boundedString(row.material_fingerprint, 64);
  const providerRow = record(row.provider_material);
  const providerAccountId = boundedString(providerRow?.provider_account_id, 255);
  const providerLocationId = nullableBoundedString(
    providerRow?.provider_location_id,
    255,
  );
  const providerEnvironment = providerRow?.provider_environment == null
    ? null
    : providerRow.provider_environment === "sandbox" ||
        providerRow.provider_environment === "production"
      ? providerRow.provider_environment
      : undefined;
  const providerCurrency = boundedString(providerRow?.currency, 3)?.toUpperCase() ?? null;
  const savedCardId = nullableBoundedString(providerRow?.saved_card_id, 255);
  const customerId = nullableBoundedString(providerRow?.customer_id, 255);
  const providerParentPaymentId = nullableBoundedString(
    providerRow?.parent_payment_id,
    255,
  );

  if (
    !salonId || !UUID_RE.test(salonId) ||
    (bookingId !== null && !UUID_RE.test(bookingId)) ||
    (row.booking_id != null && bookingId === null) ||
    (parentOperationId !== null && !UUID_RE.test(parentOperationId)) ||
    (row.parent_operation_id != null && parentOperationId === null) ||
    parsedKind !== operationKind || !provider || !providerAccountFingerprint ||
    !HASH_RE.test(providerAccountFingerprint) || amountCents === null ||
    amountCents <= 0 || !currency || !CURRENCY_RE.test(currency) ||
    capturedCents === null || refundedCents === null || reservedCents === null ||
    remainingRefundableCents === null ||
    !materialFingerprint || !HASH_RE.test(materialFingerprint) ||
    refundedCents > capturedCents || !providerRow || !providerAccountId ||
    providerLocationId === undefined || providerEnvironment === undefined ||
    !providerCurrency || providerCurrency !== currency ||
    savedCardId === undefined || customerId === undefined ||
    providerParentPaymentId === undefined ||
    (provider === "square" && (!providerLocationId || !providerEnvironment)) ||
    (provider === "stripe" && (providerLocationId !== null || providerEnvironment !== null)) ||
    createHash("sha256").update(
      `${provider}:${providerAccountId}:${providerLocationId ?? ""}:${providerEnvironment ?? ""}`,
      "utf8",
    ).digest("hex") !== providerAccountFingerprint
  ) return null;

  const isRefund = operationKind === "deposit_refund" ||
    operationKind === "noshow_refund" || operationKind === "late_cancel_refund";
  if (isRefund) {
    if (
      !parentPaymentId || providerParentPaymentId !== parentPaymentId ||
      reservedCents > capturedCents - refundedCents ||
      remainingRefundableCents !== capturedCents - refundedCents - reservedCents ||
      amountCents > remainingRefundableCents
    ) return null;
    if (
      operationKind === "deposit_refund"
        ? savedCardId !== null || customerId !== null
        : !savedCardId || !customerId
    ) return null;
  } else if (
    parentPaymentId !== null || providerParentPaymentId !== null ||
    capturedCents !== amountCents ||
    refundedCents !== 0 || reservedCents !== 0 || remainingRefundableCents !== 0
  ) {
    return null;
  }

  // Every ordinary booking operation is tenant-bound to a booking. The sole
  // exception is a DB-created compensation refund for a succeeded public
  // deposit that could not be bound to a booking. That form must carry the
  // immutable parent operation instead of inventing a booking identifier.
  const isUnboundCompensation = operationKind === "deposit_refund" &&
    bookingId === null && parentOperationId !== null;
  if (
    (!bookingId && !isUnboundCompensation) ||
    (isRefund && parentOperationId === null) ||
    (!isRefund && parentOperationId !== null) ||
    ((operationKind === "late_cancel_charge" || operationKind === "late_cancel_refund")
      ? operationOccurrenceVersion === null || operationOccurrenceVersion <= 0
      : operationOccurrenceVersion !== null)
  ) return null;

  if (operationKind === "late_cancel_charge") {
    const preview = record(row.cancel_preview);
    if (
      !preview || preview.will_charge !== true || preview.has_chargeable_card !== true ||
      preview.fee_cents !== amountCents || preview.currency !== currency ||
      row.scope_kind !== "booking_own" || (row.rsvp_semantic != null && row.rsvp_semantic !== "")
    ) return null;
  } else if (row.cancel_preview != null || row.scope_kind != null || row.rsvp_semantic != null) {
    return null;
  }

  if (
    (operationKind === "noshow_charge" || operationKind === "late_cancel_charge") &&
      (!savedCardId || !customerId) ||
    operationKind === "deposit_charge" && (savedCardId !== null || customerId !== null)
  ) return null;

  return {
    salonId,
    bookingId,
    operationKind,
    provider,
    providerAccountFingerprint,
    amountCents,
    currency,
    parentPaymentId,
    parentOperationId,
    operationOccurrenceVersion,
    capturedCents,
    refundedCents,
    reservedCents,
    remainingRefundableCents,
    materialFingerprint,
    providerMaterial: {
      providerAccountId,
      providerLocationId,
      providerEnvironment,
      currency: providerCurrency,
      savedCardId,
      customerId,
      parentPaymentId: providerParentPaymentId,
    },
  };
}

export function parseClaimedBookingPaymentOperation(
  value: unknown,
  operationKind: BookingPaymentOperationKind,
): ClaimedBookingPaymentOperation | null {
  const row = record(value);
  if (
    !row || row.success !== true ||
    !["claimed", "attempt_replay", "reconcile_claimed", "provider_reconciliation_claimed"].includes(String(row.code ?? "")) ||
    !["sending", "reconciling"].includes(String(row.status ?? ""))
  ) {
    return null;
  }
  const operationId = boundedString(row.operation_id, 36);
  const attemptToken = boundedString(row.attempt_token, 36);
  const providerIdempotencyKey = boundedString(row.provider_idempotency_key, 128);
  const leaseExpiresAt = boundedString(row.lease_expires_at, 64);
  const attemptCount = integer(row.attempt_count);
  const materialFingerprint = boundedString(row.material_fingerprint, 64);
  const materialRow = record(row.material);
  if (
    !operationId || !UUID_RE.test(operationId) || !attemptToken ||
    !UUID_RE.test(attemptToken) || !providerIdempotencyKey ||
    providerIdempotencyKey !== `nq:${operationId}` ||
    !leaseExpiresAt || !Number.isFinite(Date.parse(leaseExpiresAt)) ||
    attemptCount === null || attemptCount < 1 || attemptCount > 3 ||
    !materialFingerprint || !HASH_RE.test(materialFingerprint) || !materialRow
  ) return null;
  const material = parseBookingPaymentOperationMaterial(
    { ...materialRow, material_fingerprint: materialFingerprint },
    operationKind,
  );
  return material
    ? {
        operationId,
        attemptToken,
        providerIdempotencyKey,
        leaseExpiresAt,
        attemptCount,
        material,
      }
    : null;
}

export function parsePublicDepositPaymentMaterial(
  value: unknown,
  materialFingerprint?: string,
): PublicDepositPaymentMaterial | null {
  const row = record(value);
  if (!row) return null;
  const salonId = boundedString(row.salon_id, 36);
  const serviceId = boundedString(row.service_id, 36);
  const staffId = boundedString(row.staff_id, 36);
  const startTimeUtc = boundedString(row.start_time_utc, 64);
  const endTimeUtc = boundedString(row.end_time_utc, 64);
  const bookingIdempotencyKey = boundedString(row.booking_idempotency_key, 36);
  const pricingFingerprint = boundedString(row.pricing_fingerprint, 64);
  const clientPhoneFingerprint = boundedString(row.client_phone_fingerprint, 64);
  const provider = row.provider === "square" || row.provider === "stripe"
    ? row.provider
    : null;
  const providerAccountFingerprint = boundedString(
    row.provider_account_fingerprint,
    64,
  );
  const amountCents = integer(row.amount_cents);
  const currency = boundedString(row.currency, 3)?.toUpperCase() ?? null;
  const depositReason = boundedString(row.deposit_reason, 64);
  const fingerprint = materialFingerprint ?? boundedString(row.material_fingerprint, 64);
  const providerRow = record(row.provider_material);
  const providerAccountId = boundedString(providerRow?.provider_account_id, 255);
  const providerLocationId = nullableBoundedString(
    providerRow?.provider_location_id,
    255,
  );
  const providerApplicationId = nullableBoundedString(
    providerRow?.provider_application_id,
    255,
  );
  const providerEnvironment = providerRow?.provider_environment == null
    ? null
    : providerRow.provider_environment === "sandbox" ||
        providerRow.provider_environment === "production"
      ? providerRow.provider_environment
      : undefined;
  const providerCurrency = boundedString(providerRow?.currency, 3)?.toUpperCase() ?? null;
  const providerAmountCents = integer(providerRow?.amount_cents);
  const providerBookingIntent = boundedString(
    providerRow?.booking_intent_reference,
    36,
  );
  const providerPricingFingerprint = boundedString(
    providerRow?.pricing_fingerprint,
    64,
  );
  if (
    !salonId || !UUID_RE.test(salonId) || !serviceId || !UUID_RE.test(serviceId) ||
    !staffId || !UUID_RE.test(staffId) || !startTimeUtc || !endTimeUtc ||
    !Number.isFinite(Date.parse(startTimeUtc)) || !Number.isFinite(Date.parse(endTimeUtc)) ||
    Date.parse(endTimeUtc) <= Date.parse(startTimeUtc) ||
    !bookingIdempotencyKey || !UUID_RE.test(bookingIdempotencyKey) ||
    !pricingFingerprint || !HASH_RE.test(pricingFingerprint) ||
    !clientPhoneFingerprint || !HASH_RE.test(clientPhoneFingerprint) ||
    !provider || !providerAccountFingerprint || !HASH_RE.test(providerAccountFingerprint) ||
    amountCents === null || amountCents <= 0 || !currency || !CURRENCY_RE.test(currency) ||
    !depositReason || !fingerprint || !HASH_RE.test(fingerprint) ||
    !providerRow || !providerAccountId || providerLocationId === undefined ||
    providerApplicationId === undefined || providerEnvironment === undefined ||
    !providerCurrency || providerCurrency !== currency ||
    providerAmountCents !== amountCents || providerBookingIntent !== bookingIdempotencyKey ||
    providerPricingFingerprint !== pricingFingerprint ||
    (provider === "square" && (!providerLocationId || !providerApplicationId || !providerEnvironment)) ||
    (provider === "stripe" && (
      providerLocationId !== null || providerApplicationId !== null || providerEnvironment !== null
    )) ||
    createHash("sha256").update(
      `${provider}:${providerAccountId}:${providerLocationId ?? ""}:${providerEnvironment ?? ""}`,
      "utf8",
    ).digest("hex") !== providerAccountFingerprint
  ) return null;
  return {
    salonId,
    serviceId,
    staffId,
    startTimeUtc,
    endTimeUtc,
    bookingIdempotencyKey,
    pricingFingerprint,
    clientPhoneFingerprint,
    provider,
    providerAccountFingerprint,
    amountCents,
    currency,
    depositReason,
    materialFingerprint: fingerprint,
    providerMaterial: {
      providerAccountId,
      providerLocationId,
      providerApplicationId,
      providerEnvironment,
      currency: providerCurrency,
      amountCents: providerAmountCents,
      bookingIntentReference: providerBookingIntent,
      pricingFingerprint: providerPricingFingerprint,
    },
  };
}

export function parseClaimedPublicDepositPaymentOperation(
  value: unknown,
): ClaimedPublicDepositPaymentOperation | null {
  const row = record(value);
  if (
    !row || row.success !== true ||
    !["claimed", "attempt_replay", "reconcile_claimed", "provider_reconciliation_claimed"].includes(String(row.code ?? "")) ||
    !["sending", "reconciling"].includes(String(row.status ?? ""))
  ) {
    return null;
  }
  const operationId = boundedString(row.operation_id, 36);
  const attemptToken = boundedString(row.attempt_token, 36);
  const providerIdempotencyKey = boundedString(row.provider_idempotency_key, 128);
  const leaseExpiresAt = boundedString(row.lease_expires_at, 64);
  const attemptCount = integer(row.attempt_count);
  const materialFingerprint = boundedString(row.material_fingerprint, 64);
  if (
    !operationId || !UUID_RE.test(operationId) || !attemptToken || !UUID_RE.test(attemptToken) ||
    providerIdempotencyKey !== `nq:${operationId}` ||
    !leaseExpiresAt || !Number.isFinite(Date.parse(leaseExpiresAt)) ||
    attemptCount === null || attemptCount < 1 || attemptCount > 3 ||
    !materialFingerprint || !HASH_RE.test(materialFingerprint)
  ) return null;
  const material = parsePublicDepositPaymentMaterial(row.material, materialFingerprint);
  return material
    ? {
        operationId,
        attemptToken,
        providerIdempotencyKey,
        leaseExpiresAt,
        attemptCount,
        material,
      }
    : null;
}
