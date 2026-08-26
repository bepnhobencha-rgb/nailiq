import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import {
  parseBookingPaymentOperationMaterial,
  parseClaimedBookingPaymentOperation,
} from "@/shared/payments/bookingPaymentOperations";
import { dispatchClaimedBookingPaymentOperation } from "@/shared/payments/executeBookingPaymentOperation";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

function json(payload: Record<string, unknown>, status: number) {
  return NextResponse.json(payload, { status, headers: PRIVATE_HEADERS });
}

function row(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object"
    ? candidate as Record<string, unknown>
    : null;
}

function string(body: Record<string, unknown>, key: string, max: number) {
  const value = typeof body[key] === "string" ? body[key].trim() : "";
  return value.length > 0 && value.length <= max ? value : null;
}

function nullableString(body: Record<string, unknown>, key: string, max: number) {
  if (body[key] == null || body[key] === "") return null;
  return string(body, key, max);
}

async function rateAllowed(
  db: ReturnType<typeof createServiceRoleClient>,
  key: string,
  limit: number,
  seconds: number,
): Promise<boolean | null> {
  try {
    const { data, error } = await db.rpc("rate_limit_hit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: seconds,
    });
    return error || typeof data !== "boolean" ? null : data;
  } catch {
    return null;
  }
}

async function compensateUnboundDeposit(
  db: ReturnType<typeof createServiceRoleClient>,
  operationId: string,
  paymentRequestId: string,
): Promise<"succeeded" | "pending" | "failed"> {
  let loaded: { data: unknown; error: unknown };
  try {
    loaded = await db.rpc("load_unbound_deposit_refund_material", {
      p_parent_operation_id: operationId,
    });
  } catch {
    return "pending";
  }
  if (loaded.error) return "pending";
  const loadedRow = row(loaded.data);
  if (loadedRow?.success === true && loadedRow.code === "compensation_replay") {
    return "succeeded";
  }
  const fingerprint = typeof loadedRow?.material_fingerprint === "string"
    ? loadedRow.material_fingerprint
    : "";
  const material = parseBookingPaymentOperationMaterial(
    {
      ...(loadedRow?.material as Record<string, unknown> | null ?? {}),
      material_fingerprint: fingerprint,
    },
    "deposit_refund",
  );
  if (!material || material.bookingId !== null || material.parentOperationId !== operationId) {
    return loadedRow?.code === "reconciliation_required" ||
        loadedRow?.code === "compensation_in_flight"
      ? "pending"
      : "failed";
  }
  let claimed: { data: unknown; error: unknown };
  try {
    claimed = await db.rpc("claim_unbound_deposit_refund", {
      p_parent_operation_id: operationId,
      // A request UUID is unique per operation kind, so reusing the deposit's
      // stable request identity gives the compensating refund exact replay.
      p_request_id: paymentRequestId,
      p_expected_material_fingerprint: material.materialFingerprint,
    });
  } catch {
    return "pending";
  }
  if (claimed.error) return "pending";
  const claim = parseClaimedBookingPaymentOperation(claimed.data, "deposit_refund");
  if (!claim) {
    const claimRow = row(claimed.data);
    return claimRow?.success === true && claimRow.status === "succeeded"
      ? "succeeded"
      : "pending";
  }
  const outcome = await dispatchClaimedBookingPaymentOperation({
    db: db as never,
    claim,
    reason: "Automatic refund — paid booking could not be created",
  });
  return outcome.ok ? "succeeded" : "pending";
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return json({ success: false, code: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ success: false, code: "invalid_request" }, 400);
  }
  const body = await readJsonObjectWithLimit(request, 12_288);
  if (!body) return json({ success: false, code: "invalid_request" }, 400);

  const salonId = string(body, "salonId", 36);
  const serviceId = string(body, "serviceId", 36);
  const staffId = string(body, "staffId", 36);
  const clientName = string(body, "clientName", 120);
  const clientPhone = string(body, "clientPhone", 32);
  const startTimeUtc = string(body, "startTimeUtc", 64);
  const endTimeUtc = string(body, "endTimeUtc", 64);
  const clientNotes = nullableString(body, "clientNotes", 2_000);
  const clientEmail = nullableString(body, "clientEmail", 254);
  const resourceId = nullableString(body, "resourceId", 36);
  const comboId = nullableString(body, "comboId", 36);
  const voucherId = nullableString(body, "voucherId", 36);
  const idempotencyKey = string(body, "idempotencyKey", 36);
  const pricingFingerprint = string(body, "pricingFingerprint", 64);
  const paymentOperationId = string(body, "paymentOperationId", 36);
  const paymentRequestId = string(body, "paymentRequestId", 36);
  const paymentMaterialFingerprint = string(body, "paymentMaterialFingerprint", 64);
  const addonServiceIds = Array.isArray(body.addonServiceIds) && body.addonServiceIds.length <= 20
    ? body.addonServiceIds
    : null;
  if (
    !salonId || !UUID_RE.test(salonId) || !serviceId || !UUID_RE.test(serviceId) ||
    !staffId || !UUID_RE.test(staffId) || !clientName || !clientPhone ||
    !/^\d{7,15}$/.test(clientPhone) || !startTimeUtc || !endTimeUtc ||
    !Number.isFinite(Date.parse(startTimeUtc)) || !Number.isFinite(Date.parse(endTimeUtc)) ||
    Date.parse(endTimeUtc) <= Date.parse(startTimeUtc) ||
    clientNotes === undefined || clientEmail === undefined || resourceId === undefined ||
    comboId === undefined || voucherId === undefined ||
    (resourceId !== null && !UUID_RE.test(resourceId)) ||
    (comboId !== null && !UUID_RE.test(comboId)) ||
    (voucherId !== null && !UUID_RE.test(voucherId)) ||
    !idempotencyKey || !UUID_RE.test(idempotencyKey) ||
    !pricingFingerprint || !HASH_RE.test(pricingFingerprint) ||
    !paymentOperationId || !UUID_RE.test(paymentOperationId) ||
    !paymentRequestId || !UUID_RE.test(paymentRequestId) ||
    !paymentMaterialFingerprint || !HASH_RE.test(paymentMaterialFingerprint) ||
    addonServiceIds === null || addonServiceIds.some((id) => typeof id !== "string" || !UUID_RE.test(id)) ||
    typeof body.applyEmailDiscount !== "boolean"
  ) return json({ success: false, code: "invalid_request" }, 400);

  const db = createServiceRoleClient();
  const ipKey = createHash("sha256").update(clientIp(request)).digest("hex");
  const intentKey = createHash("sha256")
    .update(`${salonId}:${idempotencyKey}:${paymentOperationId}`)
    .digest("hex");
  const ipAllowed = await rateAllowed(db, `public-deposit-create:ip:${ipKey}`, 20, 300);
  if (ipAllowed == null) return json({ success: false, code: "booking_unavailable" }, 503);
  if (!ipAllowed) return json({ success: false, code: "rate_limited" }, 429);
  const intentAllowed = await rateAllowed(db, `public-deposit-create:intent:${intentKey}`, 8, 3600);
  if (intentAllowed == null) return json({ success: false, code: "booking_unavailable" }, 503);
  if (!intentAllowed) return json({ success: false, code: "rate_limited" }, 429);

  let result: { data: unknown; error: unknown };
  try {
    result = await db.rpc("create_public_booking_with_deposit_payment", {
      p_salon_id: salonId,
      p_service_id: serviceId,
      p_staff_id: staffId,
      p_client_name: clientName,
      p_client_phone: clientPhone,
      p_start_time_utc: startTimeUtc,
      p_end_time_utc: endTimeUtc,
      p_status: "confirmed",
      p_client_notes: clientNotes,
      p_addon_service_ids: addonServiceIds,
      p_client_email: clientEmail,
      p_resource_id: resourceId,
      p_combo_id: comboId,
      p_voucher_id: voucherId,
      p_apply_email_discount: body.applyEmailDiscount,
      p_idempotency_key: idempotencyKey,
      p_expected_pricing_fingerprint: pricingFingerprint,
      p_payment_operation_id: paymentOperationId,
      p_payment_request_id: paymentRequestId,
      p_expected_payment_material_fingerprint: paymentMaterialFingerprint,
    });
  } catch {
    return json({ success: false, code: "booking_unavailable" }, 503);
  }
  if (result.error) return json({ success: false, code: "booking_unavailable" }, 503);
  const resultRow = row(result.data);
  if (!resultRow) return json({ success: false, code: "booking_unavailable" }, 503);

  if (resultRow.success === true) {
    const booking = row(resultRow.booking);
    if (!booking || booking.success !== true || typeof resultRow.booking_id !== "string") {
      return json({ success: false, code: "booking_unavailable" }, 503);
    }
    return json({
      success: true,
      code: resultRow.code,
      idempotent: resultRow.idempotent === true,
      booking_id: resultRow.booking_id,
      booking,
    }, 200);
  }

  const code = typeof resultRow.code === "string" ? resultRow.code : "booking_unavailable";
  const booking = row(resultRow.booking);
  if (code === "booking_create_failed" && booking?.success === false) {
    const compensation = await compensateUnboundDeposit(db, paymentOperationId, paymentRequestId);
    if (compensation !== "succeeded") {
      return json({
        success: false,
        code: "deposit_compensation_pending",
        bookingCommitted: false,
      }, 503);
    }
    return json({
      success: false,
      code,
      booking,
      deposit_compensation_status: "succeeded",
    }, 409);
  }
  return json({ success: false, code }, 409);
}
