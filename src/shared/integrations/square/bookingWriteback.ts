import "server-only";
import { createHash } from "node:crypto";
import type { SquareBooking, SquareConfig } from "./client";
import type { LooseDb } from "./looseDb";

export const SQUARE_BOOKING_WRITEBACK_API_VERSION = "2024-12-18";

const HASH_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UNKNOWN_ERROR_CODES = new Set([
  "provider_outcome_unknown",
  "square_writeback_dispatch_failed",
  "square_customer_resolution_unknown",
  "square_customer_receipt_write_failed",
  "square_booking_create_outcome_unknown",
  "square_booking_bind_outcome_unknown",
]);

const str = (value: unknown): string => value == null ? "" : String(value);
const record = (value: unknown): Record<string, unknown> | null => {
  const unwrapped = Array.isArray(value) ? value[0] : value;
  return unwrapped && typeof unwrapped === "object"
    ? unwrapped as Record<string, unknown>
    : null;
};

export function squareBookingContactFingerprint(input: {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}): string {
  const name = (input.name ?? "").trim().toLowerCase().replace(/\s+/gu, " ");
  const phone = (input.phone ?? "").replace(/[^0-9]/g, "");
  const email = (input.email ?? "").trim().toLowerCase();
  return createHash("sha256")
    .update(`${name}\n${phone}\n${email}`, "utf8")
    .digest("hex");
}

export function squareBookingWritebackResultFingerprint(
  value: unknown,
): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

export type SquareBookingWritebackMaterial = {
  contractVersion: 1;
  apiVersion: string;
  salonId: string;
  bookingId: string;
  serviceId: string;
  serviceMappingBasis: string;
  staffId: string;
  bookingStatus: "confirmed" | "pending";
  startTimeUtc: string;
  endTimeUtc: string;
  durationMinutes: number;
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
  environment: "sandbox" | "production";
  applicationId: string;
  merchantId: string;
  locationId: string;
  accountFingerprint: string;
  contactFingerprint: string;
  providerCorrelationKey: string;
  customerIdempotencyKey: string;
  bookingIdempotencyKey: string;
  materialFingerprint: string;
};

export type SquareBookingWritebackClaim = {
  operationId: string;
  attemptToken: string;
  material: SquareBookingWritebackMaterial;
};

export type SquareBookingWritebackDispatch = SquareBookingWritebackClaim & {
  clientName: string;
  clientPhone: string | null;
  clientEmail: string | null;
  sellerNote: string;
  customerReferenceId: string;
};

export type SquareBookingWritebackReconciliation = SquareBookingWritebackClaim & {
  providerCustomerId: string;
  providerBookingId: string | null;
  providerBookingVersion: number | null;
};

function parseMaterial(
  raw: unknown,
  materialFingerprint: unknown,
): SquareBookingWritebackMaterial | null {
  const value = record(raw);
  const startTimeUtc = str(value?.start_time_utc);
  const endTimeUtc = str(value?.end_time_utc);
  const durationMinutes = Number(value?.duration_minutes);
  const variationVersion = Number(value?.square_service_variation_version);
  const environment = value?.provider_environment;
  const bookingStatus = value?.booking_status;
  const parsedStart = Date.parse(startTimeUtc);
  const parsedEnd = Date.parse(endTimeUtc);
  const fingerprint = str(materialFingerprint);
  const accountFingerprint = createHash("sha256").update(
    [
      str(value?.api_version),
      str(value?.provider_environment),
      str(value?.provider_application_id).trim(),
      str(value?.provider_merchant_id).trim(),
      str(value?.provider_location_id).trim(),
    ].join("\n"),
    "utf8",
  ).digest("hex");
  if (
    value?.contract_version !== 1
    || value.provider !== "square"
    || value.operation_kind !== "create_booking"
    || value.booking_deleted_at !== null
    || value.service_deleted_at !== null
    || value.staff_deleted_at !== null
    || value.staff_status !== "active"
    || (environment !== "sandbox" && environment !== "production")
    || (bookingStatus !== "confirmed" && bookingStatus !== "pending")
    || !UUID_RE.test(str(value.salon_id))
    || !UUID_RE.test(str(value.booking_id))
    || !UUID_RE.test(str(value.booking_service_id))
    || !UUID_RE.test(str(value.booking_staff_id))
    || !str(value.service_mapping_basis)
    || !str(value.api_version)
    || !str(value.square_team_member_id)
    || !str(value.square_service_variation_id)
    || !Number.isSafeInteger(variationVersion)
    || variationVersion < 0
    || !Number.isFinite(parsedStart)
    || !Number.isFinite(parsedEnd)
    || parsedEnd <= parsedStart
    || !Number.isSafeInteger(durationMinutes)
    || durationMinutes < 5
    || Math.round((parsedEnd - parsedStart) / 60_000) !== durationMinutes
    || !str(value.provider_application_id)
    || !str(value.provider_merchant_id)
    || !str(value.provider_location_id)
    || !HASH_RE.test(str(value.provider_account_fingerprint))
    || value.provider_account_fingerprint !== accountFingerprint
    || !HASH_RE.test(str(value.contact_fingerprint))
    || !HASH_RE.test(fingerprint)
  ) return null;

  const bookingId = str(value.booking_id).toLowerCase();
  const customerKey = str(value.customer_idempotency_key);
  const bookingKey = str(value.booking_idempotency_key);
  const correlationKey = str(value.provider_correlation_key);
  if (
    customerKey !== `sqcust:${bookingId}`
    || bookingKey !== `create:${bookingId}`
    || correlationKey !== `NailIQ booking:${bookingId}`
  ) return null;

  return {
    contractVersion: 1,
    apiVersion: str(value.api_version),
    salonId: str(value.salon_id).toLowerCase(),
    bookingId,
    serviceId: str(value.booking_service_id).toLowerCase(),
    serviceMappingBasis: str(value.service_mapping_basis),
    staffId: str(value.booking_staff_id).toLowerCase(),
    bookingStatus,
    startTimeUtc,
    endTimeUtc,
    durationMinutes,
    teamMemberId: str(value.square_team_member_id),
    serviceVariationId: str(value.square_service_variation_id),
    serviceVariationVersion: variationVersion,
    environment,
    applicationId: str(value.provider_application_id),
    merchantId: str(value.provider_merchant_id),
    locationId: str(value.provider_location_id),
    accountFingerprint,
    contactFingerprint: str(value.contact_fingerprint),
    providerCorrelationKey: correlationKey,
    customerIdempotencyKey: customerKey,
    bookingIdempotencyKey: bookingKey,
    materialFingerprint: fingerprint,
  };
}

function assertMaterialContext(
  material: SquareBookingWritebackMaterial,
  cfg: SquareConfig,
  expected: {
    bookingId: string;
    serviceId: string;
    serviceMappingBasis: string;
    staffId: string;
    status: "confirmed" | "pending";
    startTimeUtc: string;
    endTimeUtc: string;
    teamMemberId: string;
    serviceVariationId: string;
    serviceVariationVersion: number;
    contactFingerprint: string;
  },
): void {
  if (
    material.apiVersion !== SQUARE_BOOKING_WRITEBACK_API_VERSION
    || material.salonId !== cfg.salonId.toLowerCase()
    || material.bookingId !== expected.bookingId.toLowerCase()
    || material.serviceId !== expected.serviceId.toLowerCase()
    || material.serviceMappingBasis !== expected.serviceMappingBasis
    || material.staffId !== expected.staffId.toLowerCase()
    || material.bookingStatus !== expected.status
    || Date.parse(material.startTimeUtc) !== Date.parse(expected.startTimeUtc)
    || Date.parse(material.endTimeUtc) !== Date.parse(expected.endTimeUtc)
    || material.teamMemberId !== expected.teamMemberId
    || material.serviceVariationId !== expected.serviceVariationId
    || material.serviceVariationVersion !== expected.serviceVariationVersion
    || material.contactFingerprint !== expected.contactFingerprint
    || material.environment !== cfg.environment
    || material.applicationId !== cfg.applicationId
    || material.merchantId !== cfg.merchantId
    || material.locationId !== cfg.locationId
  ) throw new Error("square_booking_writeback_material_mismatch");
}

async function rpcRecord(
  db: LooseDb,
  fn: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}_unavailable`);
  const row = record(data);
  if (!row) throw new Error(`${fn}_response_invalid`);
  return row;
}

function parseClaim(
  row: Record<string, unknown>,
  expectedCode: string,
): SquareBookingWritebackClaim | null {
  if (row.success !== true || row.code !== expectedCode) return null;
  const operationId = str(row.operation_id);
  const attemptToken = str(row.attempt_token);
  const materialFingerprint = str(row.material_fingerprint);
  const material = parseMaterial(row.material, materialFingerprint);
  if (
    !UUID_RE.test(operationId)
    || !UUID_RE.test(attemptToken)
    || !material
    || row.contact_fingerprint !== undefined
      && row.contact_fingerprint !== material.contactFingerprint
    || row.provider_account_fingerprint !== undefined
      && row.provider_account_fingerprint !== material.accountFingerprint
    || row.customer_idempotency_key !== undefined
      && row.customer_idempotency_key !== material.customerIdempotencyKey
    || row.booking_idempotency_key !== undefined
      && row.booking_idempotency_key !== material.bookingIdempotencyKey
    || row.provider_correlation_key !== undefined
      && row.provider_correlation_key !== material.providerCorrelationKey
  ) return null;
  return { operationId, attemptToken, material };
}

export async function claimSquareBookingWriteback(
  db: LooseDb,
  cfg: SquareConfig,
  input: {
    bookingId: string;
    serviceId: string;
    serviceMappingBasis: string;
    staffId: string;
    status: "confirmed" | "pending";
    startTimeUtc: string;
    endTimeUtc: string;
    teamMemberId: string;
    serviceVariationId: string;
    serviceVariationVersion: number;
    clientName: string | null;
    clientPhone: string | null;
    clientEmail: string | null;
  },
): Promise<SquareBookingWritebackClaim> {
  const contactFingerprint = squareBookingContactFingerprint({
    name: input.clientName,
    phone: input.clientPhone,
    email: input.clientEmail,
  });
  const row = await rpcRecord(db, "claim_square_booking_writeback", {
    p_salon_id: cfg.salonId,
    p_booking_id: input.bookingId,
    p_square_team_member_id: input.teamMemberId,
    p_square_service_variation_id: input.serviceVariationId,
    p_square_service_variation_version: input.serviceVariationVersion,
    p_expected_contact_fingerprint: contactFingerprint,
    p_api_version: SQUARE_BOOKING_WRITEBACK_API_VERSION,
  });
  const claim = parseClaim(row, "operation_claimed");
  if (!claim) throw new Error(`square_booking_writeback_claim_${str(row.code) || "invalid"}`);
  assertMaterialContext(claim.material, cfg, { ...input, contactFingerprint });
  return claim;
}

export async function beginSquareBookingWritebackDispatch(
  db: LooseDb,
  cfg: SquareConfig,
  claim: SquareBookingWritebackClaim,
): Promise<SquareBookingWritebackDispatch> {
  const row = await rpcRecord(db, "begin_square_booking_writeback_dispatch", {
    p_operation_id: claim.operationId,
    p_attempt_token: claim.attemptToken,
    p_expected_material_fingerprint: claim.material.materialFingerprint,
  });
  const provider = record(row.provider_material);
  const clientName = provider?.client_name;
  const clientPhone = provider?.client_phone;
  const clientEmail = provider?.client_email;
  if (
    row.success !== true
    || row.code !== "dispatch_authorized"
    || row.operation_id !== claim.operationId
    || row.attempt_token !== claim.attemptToken
    || row.material_fingerprint !== claim.material.materialFingerprint
    || !provider
    || typeof clientName !== "string"
    || (clientPhone !== null && typeof clientPhone !== "string")
    || (clientEmail !== null && typeof clientEmail !== "string")
    || provider.contract_version !== 1
    || provider.provider !== "square"
    || provider.operation_kind !== "create_booking"
    || provider.api_version !== claim.material.apiVersion
    || provider.salon_id !== claim.material.salonId
    || provider.booking_id !== claim.material.bookingId
    || provider.provider_environment !== cfg.environment
    || provider.provider_application_id !== cfg.applicationId
    || provider.provider_merchant_id !== cfg.merchantId
    || provider.provider_location_id !== cfg.locationId
    || provider.provider_account_fingerprint !== claim.material.accountFingerprint
    || provider.contact_fingerprint !== claim.material.contactFingerprint
    || squareBookingContactFingerprint({
      name: clientName,
      phone: clientPhone,
      email: clientEmail,
    }) !== claim.material.contactFingerprint
    || Date.parse(str(provider.start_time_utc)) !== Date.parse(claim.material.startTimeUtc)
    || Date.parse(str(provider.end_time_utc)) !== Date.parse(claim.material.endTimeUtc)
    || provider.duration_minutes !== claim.material.durationMinutes
    || provider.square_team_member_id !== claim.material.teamMemberId
    || provider.square_service_variation_id !== claim.material.serviceVariationId
    || provider.square_service_variation_version !== claim.material.serviceVariationVersion
    || provider.seller_note !== claim.material.providerCorrelationKey
    || provider.customer_reference_id !== `booking:${claim.material.bookingId}`
    || provider.customer_idempotency_key !== claim.material.customerIdempotencyKey
    || provider.booking_idempotency_key !== claim.material.bookingIdempotencyKey
  ) throw new Error("square_booking_writeback_dispatch_invalid");
  return {
    ...claim,
    clientName,
    clientPhone,
    clientEmail,
    sellerNote: str(provider.seller_note),
    customerReferenceId: str(provider.customer_reference_id),
  };
}

export async function recordSquareBookingWritebackCustomer(
  db: LooseDb,
  dispatch: SquareBookingWritebackDispatch,
  providerCustomerId: string,
): Promise<void> {
  const resultFingerprint = squareBookingWritebackResultFingerprint({
    stage: "customer_recorded",
    providerCustomerId,
  });
  const row = await rpcRecord(db, "record_square_booking_writeback_customer", {
    p_operation_id: dispatch.operationId,
    p_attempt_token: dispatch.attemptToken,
    p_provider_customer_id: providerCustomerId,
    p_result_fingerprint: resultFingerprint,
  });
  if (
    row.success !== true
    || row.code !== "customer_recorded"
    || row.operation_id !== dispatch.operationId
    || row.provider_customer_id !== providerCustomerId
  ) throw new Error(`square_booking_writeback_customer_${str(row.code) || "invalid"}`);
}

export async function markSquareBookingWritebackUnknown(
  db: LooseDb,
  claim: SquareBookingWritebackClaim,
  errorCode: string,
  receipt?: {
    providerBookingId?: string | null;
    providerCustomerId?: string | null;
    providerBookingVersion?: number | null;
  },
): Promise<void> {
  // Never derive a durable value from an arbitrary provider/transport message:
  // Square error details can echo customer contact fields. Callers pass a
  // fixed category; anything else collapses to a PII-free generic code.
  const safeError = UNKNOWN_ERROR_CODES.has(errorCode)
    ? errorCode
    : "provider_outcome_unknown";
  const resultFingerprint = squareBookingWritebackResultFingerprint({
    stage: "unknown",
    errorCode: safeError,
    providerBookingId: receipt?.providerBookingId ?? null,
    providerCustomerId: receipt?.providerCustomerId ?? null,
    providerBookingVersion: receipt?.providerBookingVersion ?? null,
  });
  const row = await rpcRecord(db, "mark_square_booking_writeback_unknown", {
    p_operation_id: claim.operationId,
    p_attempt_token: claim.attemptToken,
    p_error_code: safeError,
    p_result_fingerprint: resultFingerprint,
    p_provider_booking_id: receipt?.providerBookingId ?? null,
    p_provider_customer_id: receipt?.providerCustomerId ?? null,
    p_provider_booking_version: receipt?.providerBookingVersion ?? null,
  });
  if (
    row.success !== true
    || !["operation_unknown", "operation_succeeded", "completion_replay"].includes(str(row.code))
  ) throw new Error(`square_booking_writeback_unknown_${str(row.code) || "invalid"}`);
}

export async function claimSquareBookingWritebackReconciliation(
  db: LooseDb,
  cfg: SquareConfig,
  bookingId: string,
): Promise<SquareBookingWritebackReconciliation> {
  const row = await rpcRecord(db, "claim_square_booking_writeback_reconciliation", {
    p_salon_id: cfg.salonId,
    p_booking_id: bookingId,
  });
  const claim = parseClaim(row, "reconciliation_claimed");
  const providerCustomerId = str(row.provider_customer_id);
  const providerBookingId = row.provider_booking_id == null
    ? null
    : str(row.provider_booking_id);
  const providerBookingVersion = row.provider_booking_version == null
    ? null
    : Number(row.provider_booking_version);
  if (
    !claim
    || !providerCustomerId
    || providerBookingId === ""
    || (providerBookingVersion !== null
      && (!Number.isSafeInteger(providerBookingVersion) || providerBookingVersion < 0))
    || claim.material.salonId !== cfg.salonId.toLowerCase()
    || claim.material.bookingId !== bookingId.toLowerCase()
    || claim.material.apiVersion !== SQUARE_BOOKING_WRITEBACK_API_VERSION
    || claim.material.environment !== cfg.environment
    || claim.material.applicationId !== cfg.applicationId
    || claim.material.merchantId !== cfg.merchantId
    || claim.material.locationId !== cfg.locationId
  ) throw new Error(`square_booking_writeback_reconciliation_${str(row.code) || "invalid"}`);
  return { ...claim, providerCustomerId, providerBookingId, providerBookingVersion };
}

export function assertExactSquareBookingWritebackReceipt(
  providerBooking: SquareBooking,
  claim: SquareBookingWritebackReconciliation,
  options?: { requireSellerNote?: boolean },
): void {
  const material = claim.material;
  const segment = providerBooking.appointment_segments?.[0];
  if (
    !providerBooking.id
    || (claim.providerBookingId !== null && claim.providerBookingId !== providerBooking.id)
    || providerBooking.customer_id !== claim.providerCustomerId
    || (options?.requireSellerNote !== false
      && providerBooking.seller_note !== material.providerCorrelationKey)
    || providerBooking.location_id !== material.locationId
    || !["ACCEPTED", "PENDING"].includes(providerBooking.status)
    || Date.parse(str(providerBooking.start_at)) !== Date.parse(material.startTimeUtc)
    || providerBooking.appointment_segments?.length !== 1
    || !segment
    || segment.duration_minutes !== material.durationMinutes
    || segment.team_member_id !== material.teamMemberId
    || segment.service_variation_id !== material.serviceVariationId
    || segment.service_variation_version !== material.serviceVariationVersion
    || !Number.isSafeInteger(providerBooking.version)
    || Number(providerBooking.version) < 0
  ) throw new Error("square_booking_writeback_provider_receipt_mismatch");
}

export function assertSquareBookingWritebackInventoryContext(
  rows: Record<string, unknown>[],
  cfg: SquareConfig,
): void {
  for (const row of rows) {
    const material = parseMaterial(row.material, row.material_fingerprint);
    if (
      !["sending", "unknown", "reconciling"].includes(str(row.status))
      || !material
      || str(row.booking_id).toLowerCase() !== material.bookingId
      || row.provider_account_fingerprint !== material.accountFingerprint
      || material.salonId !== cfg.salonId.toLowerCase()
    ) {
      throw new Error("square_booking_writeback_reconciliation_inventory_invalid");
    }
    if (
      material.apiVersion !== SQUARE_BOOKING_WRITEBACK_API_VERSION
      || material.environment !== cfg.environment
      || material.applicationId !== cfg.applicationId
      || material.merchantId !== cfg.merchantId
      || material.locationId !== cfg.locationId
    ) {
      // A dispatched/unknown mutation belongs to the old provider identity.
      // Do not import from or create into a newly configured account while it
      // is unresolved; that would make the same local intent exist twice.
      throw new Error("square_booking_writeback_provider_context_changed");
    }
  }
}

/**
 * Recover provider response loss even if a seller later edits `seller_note`.
 * A stored provider ID is definitive inside the pinned account. Without one,
 * every non-mutable receipt field (customer, location, time and sole segment)
 * must match exactly; ambiguous matches fail closed before forward import.
 */
export function findSquareBookingWritebackCorrelation(
  rows: Record<string, unknown>[],
  providerBooking: SquareBooking,
  cfg: SquareConfig,
): string | null {
  const matches = new Set<string>();
  const possibleChangedReceipts = new Set<string>();
  for (const row of rows) {
    if (!["sending", "unknown", "reconciling"].includes(str(row.status))) continue;
    const material = parseMaterial(row.material, row.material_fingerprint);
    if (
      !material
      || material.salonId !== cfg.salonId.toLowerCase()
      || material.apiVersion !== SQUARE_BOOKING_WRITEBACK_API_VERSION
      || material.environment !== cfg.environment
      || material.applicationId !== cfg.applicationId
      || material.merchantId !== cfg.merchantId
      || material.locationId !== cfg.locationId
      || row.provider_account_fingerprint !== material.accountFingerprint
    ) continue;

    const recordedBookingId = row.provider_booking_id == null
      ? null
      : str(row.provider_booking_id);
    if (recordedBookingId !== null) {
      if (recordedBookingId === providerBooking.id) matches.add(material.bookingId);
      continue;
    }

    const providerCustomerId = str(row.provider_customer_id);
    const segment = providerBooking.appointment_segments?.[0];
    const samePinnedCustomer = providerCustomerId
      && providerBooking.customer_id === providerCustomerId
      && providerBooking.location_id === material.locationId;
    if (
      !samePinnedCustomer
      || !["ACCEPTED", "PENDING"].includes(providerBooking.status)
      || Date.parse(str(providerBooking.start_at)) !== Date.parse(material.startTimeUtc)
      || providerBooking.appointment_segments?.length !== 1
      || !segment
      || segment.duration_minutes !== material.durationMinutes
      || segment.team_member_id !== material.teamMemberId
      || segment.service_variation_id !== material.serviceVariationId
      || segment.service_variation_version !== material.serviceVariationVersion
    ) {
      // Once customer creation has a durable receipt, a booking for that exact
      // customer/account may be the lost create after a seller-side edit. It is
      // unsafe to import it as a new local row merely because mutable time,
      // status, segment, or note no longer matches. Stop for reconciliation.
      if (samePinnedCustomer) possibleChangedReceipts.add(material.bookingId);
      continue;
    }
    matches.add(material.bookingId);
  }
  if (matches.size > 1) {
    throw new Error("square_booking_writeback_correlation_ambiguous");
  }
  const match = matches.values().next().value ?? null;
  if (match) return match;
  if (possibleChangedReceipts.size > 0) {
    throw new Error("square_booking_writeback_correlation_material_changed");
  }
  return null;
}

export async function completeSquareBookingWritebackSuccess(
  db: LooseDb,
  claim: SquareBookingWritebackClaim,
  receipt: {
    providerBookingId: string;
    providerCustomerId: string;
    providerBookingVersion: number;
  },
): Promise<void> {
  const resultFingerprint = squareBookingWritebackResultFingerprint({
    stage: "booking_succeeded",
    ...receipt,
  });
  const row = await rpcRecord(db, "complete_square_booking_writeback_success", {
    p_operation_id: claim.operationId,
    p_attempt_token: claim.attemptToken,
    p_provider_booking_id: receipt.providerBookingId,
    p_provider_customer_id: receipt.providerCustomerId,
    p_provider_booking_version: receipt.providerBookingVersion,
    p_result_fingerprint: resultFingerprint,
  });
  if (
    row.success !== true
    || !["operation_completed", "completion_replay"].includes(str(row.code))
    || row.operation_id !== claim.operationId
    || row.provider_booking_id !== receipt.providerBookingId
    || row.provider_customer_id !== receipt.providerCustomerId
  ) throw new Error(`square_booking_writeback_completion_${str(row.code) || "invalid"}`);
}
