import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BookingSequenceReadiness = {
  contractVersion: 1;
  scheduleModel: "segments_v1";
  platformEnabled: boolean;
  salonEnabled: boolean;
  qaAllowlisted: boolean;
  catalogReady: boolean;
  capacityContractReady: boolean;
  paymentPolicyReady: boolean;
  ready: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseBookingSequenceReadiness(
  value: unknown,
): BookingSequenceReadiness | null {
  const raw = Array.isArray(value) && value.length === 1 ? value[0] : value;
  if (!record(raw)) return null;
  const allowed = new Set([
    "success",
    "code",
    "contract_version",
    "schedule_model",
    "platform_enabled",
    "salon_enabled",
    "qa_allowlisted",
    "catalog_ready",
    "capacity_contract_ready",
    "payment_policy_ready",
    "ready",
  ]);
  if (
    Object.keys(raw).some((key) => !allowed.has(key)) ||
    raw.success !== true ||
    raw.code !== "loaded" ||
    raw.contract_version !== 1 ||
    raw.schedule_model !== "segments_v1" ||
    typeof raw.platform_enabled !== "boolean" ||
    typeof raw.salon_enabled !== "boolean" ||
    typeof raw.qa_allowlisted !== "boolean" ||
    typeof raw.catalog_ready !== "boolean" ||
    typeof raw.capacity_contract_ready !== "boolean" ||
    (raw.payment_policy_ready !== undefined &&
      typeof raw.payment_policy_ready !== "boolean") ||
    typeof raw.ready !== "boolean"
  ) {
    return null;
  }
  // Additive compatibility lets the app ship before the database migration.
  // Once the field is present it becomes part of the fail-closed proof.
  const paymentPolicyReady = raw.payment_policy_ready ?? true;
  const derivedReady =
    raw.platform_enabled &&
    raw.salon_enabled &&
    raw.qa_allowlisted &&
    raw.catalog_ready &&
    raw.capacity_contract_ready &&
    paymentPolicyReady;
  if (raw.ready !== derivedReady) return null;
  return {
    contractVersion: 1,
    scheduleModel: "segments_v1",
    platformEnabled: raw.platform_enabled,
    salonEnabled: raw.salon_enabled,
    qaAllowlisted: raw.qa_allowlisted,
    catalogReady: raw.catalog_ready,
    capacityContractReady: raw.capacity_contract_ready,
    paymentPolicyReady,
    ready: raw.ready,
  };
}

export type LoadBookingSequenceReadinessResult =
  | { ok: true; readiness: BookingSequenceReadiness }
  | {
      ok: false;
      code: "invalid_request" | "unavailable" | "not_ready";
      readiness?: BookingSequenceReadiness;
    };

/**
 * One proof-grade app seam for editor, public page, quote, and create gates.
 * Any query failure, malformed result, missing allowlist, or inconsistent
 * derived readiness fails closed.
 */
export async function loadPublicBookingSequenceReadiness(
  salonId: string,
): Promise<LoadBookingSequenceReadinessResult> {
  const normalizedSalonId = salonId.trim().toLowerCase();
  if (!UUID_RE.test(normalizedSalonId)) {
    return { ok: false, code: "invalid_request" };
  }
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "load_public_booking_sequence_readiness" as never,
      { p_salon_id: normalizedSalonId } as never,
    );
    if (error || data == null) return { ok: false, code: "unavailable" };
    const readiness = parseBookingSequenceReadiness(data);
    if (!readiness) return { ok: false, code: "unavailable" };
    return readiness.ready
      ? { ok: true, readiness }
      : { ok: false, code: "not_ready", readiness };
  } catch {
    return { ok: false, code: "unavailable" };
  }
}
