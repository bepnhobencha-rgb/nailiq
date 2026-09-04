import "server-only";

import { createHash } from "node:crypto";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { DESK_AFTER_HOURS_APPROVAL_ACTION } from "@/shared/dashboard/deskAfterHoursApprovalContract";

export type DeskAfterHoursBookingInput = {
  requestId: string;
  salonId: string;
  serviceId: string;
  addonServiceIds: string[];
  staffId: string;
  staffRequestedByClient: boolean;
  bookingDateYmd: string;
  timeSlot: string;
  clientName: string;
  clientPhone: string;
  clientEmail: string | null;
  clientNotes: string | null;
  language: "en" | "vi";
  notify: { sms: boolean; email: boolean };
  resourceId: string | null;
  afterHoursOverride: { staffConsentConfirmed: true };
};

type DeskAfterHoursApprovalPayload = {
  version: 1;
  request_fingerprint: string;
  requested_by_user_id: string;
  requested_by_role: string;
  notification_mode: "dashboard_only_no_email";
  execution_mode: "owner_one_tap";
  recipient_selection_required: true;
  booking: DeskAfterHoursBookingInput;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fingerprint(input: DeskAfterHoursBookingInput): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function parseDeskAfterHoursApprovalPayload(
  value: unknown,
): DeskAfterHoursApprovalPayload | null {
  const row = objectValue(value);
  const booking = objectValue(row?.booking);
  const notify = objectValue(booking?.notify);
  const override = objectValue(booking?.afterHoursOverride);
  if (
    row?.version !== 1 ||
    row.notification_mode !== "dashboard_only_no_email" ||
    row.execution_mode !== "owner_one_tap" ||
    row.recipient_selection_required !== true ||
    typeof row.request_fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.request_fingerprint) ||
    typeof row.requested_by_user_id !== "string" ||
    !UUID_RE.test(row.requested_by_user_id) ||
    typeof row.requested_by_role !== "string" ||
    row.requested_by_role.length > 40 ||
    !booking ||
    typeof booking.requestId !== "string" ||
    !UUID_RE.test(booking.requestId) ||
    typeof booking.salonId !== "string" ||
    !UUID_RE.test(booking.salonId) ||
    typeof booking.serviceId !== "string" ||
    !UUID_RE.test(booking.serviceId) ||
    !Array.isArray(booking.addonServiceIds) ||
    !booking.addonServiceIds.every(
      (id) => typeof id === "string" && UUID_RE.test(id),
    ) ||
    typeof booking.staffId !== "string" ||
    !UUID_RE.test(booking.staffId) ||
    typeof booking.staffRequestedByClient !== "boolean" ||
    typeof booking.bookingDateYmd !== "string" ||
    typeof booking.timeSlot !== "string" ||
    typeof booking.clientName !== "string" ||
    !booking.clientName.trim() ||
    booking.clientName.length > 100 ||
    typeof booking.clientPhone !== "string" ||
    !booking.clientPhone.trim() ||
    booking.clientPhone.length > 32 ||
    !(typeof booking.clientEmail === "string" || booking.clientEmail === null) ||
    !(typeof booking.clientNotes === "string" || booking.clientNotes === null) ||
    (booking.language !== "en" && booking.language !== "vi") ||
    !notify ||
    typeof notify.sms !== "boolean" ||
    typeof notify.email !== "boolean" ||
    !(
      (typeof booking.resourceId === "string" &&
        UUID_RE.test(booking.resourceId)) ||
      booking.resourceId === null
    ) ||
    !override ||
    override.staffConsentConfirmed !== true
  ) {
    return null;
  }

  const parsed = booking as unknown as DeskAfterHoursBookingInput;
  if (fingerprint(parsed) !== row.request_fingerprint) return null;
  return row as unknown as DeskAfterHoursApprovalPayload;
}

export function buildDeskAfterHoursApprovalPayload(input: {
  requestedByUserId: string;
  requestedByRole: string;
  booking: DeskAfterHoursBookingInput;
}): DeskAfterHoursApprovalPayload {
  return {
    version: 1,
    request_fingerprint: fingerprint(input.booking),
    requested_by_user_id: input.requestedByUserId,
    requested_by_role: input.requestedByRole,
    notification_mode: "dashboard_only_no_email",
    execution_mode: "owner_one_tap",
    recipient_selection_required: true,
    booking: input.booking,
  };
}

export async function replayDeskAfterHoursApproval(
  salonId: string,
  booking: DeskAfterHoursBookingInput,
): Promise<
  | { ok: true; approvalId: string; status: string }
  | { ok: false; error: "idempotency_conflict" | "server_error" }
  | null
> {
  const db = createServiceRoleClient();
  const { data: source, error: sourceError } = await db
    .from("ai_actions_log")
    .select("id,salon_id,agent,action_type,payload")
    .eq("id", booking.requestId)
    .maybeSingle();
  if (sourceError) return { ok: false, error: "server_error" };
  if (!source?.id) return null;
  const sourcePayload = objectValue(source.payload);
  const requestFingerprint = fingerprint(booking);
  if (
    source.salon_id !== salonId ||
    source.agent !== "receptionist" ||
    source.action_type !== "desk_after_hours_booking_requested" ||
    sourcePayload?.request_fingerprint !== requestFingerprint
  ) {
    return { ok: false, error: "idempotency_conflict" };
  }

  const { data: approval, error: approvalError } = await db
    .from("approval_requests" as never)
    .select("id,status,payload")
    .eq("source_action_id" as never, booking.requestId)
    .maybeSingle();
  if (approvalError) {
    return { ok: false, error: "server_error" };
  }
  // A process can stop after the immutable source receipt commits but before
  // the approval row is written. Let the normal creator repair that partial
  // state on retry; it revalidates the source fingerprint before inserting.
  if (!approval) return null;
  const row = approval as { id: string; status: string; payload: unknown };
  const payload = parseDeskAfterHoursApprovalPayload(row.payload);
  if (!payload || payload.request_fingerprint !== requestFingerprint) {
    return { ok: false, error: "idempotency_conflict" };
  }
  return { ok: true, approvalId: row.id, status: row.status };
}

export async function createDeskAfterHoursApproval(input: {
  salonId: string;
  requestedByUserId: string;
  requestedByRole: string;
  serviceName: string;
  staffName: string;
  afterHoursMinutes: number;
  booking: DeskAfterHoursBookingInput;
}): Promise<
  | { ok: true; approvalId: string }
  | { ok: false; error: "idempotency_conflict" | "server_error" }
> {
  const db = createServiceRoleClient();
  const requestFingerprint = fingerprint(input.booking);
  const sourcePayload = {
    request_fingerprint: requestFingerprint,
    requested_by_user_id: input.requestedByUserId,
    requested_by_role: input.requestedByRole,
    after_hours_minutes: input.afterHoursMinutes,
  };
  const { error: sourceError } = await db.from("ai_actions_log").insert({
    id: input.booking.requestId,
    salon_id: input.salonId,
    agent: "receptionist",
    action_type: "desk_after_hours_booking_requested",
    payload: sourcePayload,
  } as never);

  if (sourceError && sourceError.code !== "23505") {
    console.error("[createDeskAfterHoursApproval] source", sourceError);
    return { ok: false, error: "server_error" };
  }

  const { data: source, error: sourceReadError } = await db
    .from("ai_actions_log")
    .select("id,salon_id,agent,action_type,payload")
    .eq("id", input.booking.requestId)
    .maybeSingle();
  const existingSourcePayload = objectValue(source?.payload);
  if (sourceReadError || !source?.id) {
    return { ok: false, error: "server_error" };
  }
  if (
    source.salon_id !== input.salonId ||
    source.agent !== "receptionist" ||
    source.action_type !== "desk_after_hours_booking_requested" ||
    existingSourcePayload?.request_fingerprint !== requestFingerprint
  ) {
    return { ok: false, error: "idempotency_conflict" };
  }

  const payload = buildDeskAfterHoursApprovalPayload({
    requestedByUserId: input.requestedByUserId,
    requestedByRole: input.requestedByRole,
    booking: input.booking,
  });
  const summary = [
    `Duyệt lịch ngoài giờ cho ${input.booking.clientName}`,
    `${input.serviceName} · ${input.booking.bookingDateYmd} ${input.booking.timeSlot}`,
    `${input.staffName} · ${input.afterHoursMinutes} phút sau đóng cửa`,
  ].join(" — ").slice(0, 1_000);
  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString();
  const { data: approval, error: approvalError } = await db
    .from("approval_requests" as never)
    .insert({
      salon_id: input.salonId,
      action_type: DESK_AFTER_HOURS_APPROVAL_ACTION,
      summary,
      payload,
      urgency: "normal",
      expires_at: expiresAt,
      source_action_id: input.booking.requestId,
    } as never)
    .select("id")
    .maybeSingle();

  if (!approvalError && approval) {
    return { ok: true, approvalId: String((approval as { id: string }).id) };
  }
  if (approvalError?.code !== "23505") {
    console.error("[createDeskAfterHoursApproval] approval", approvalError);
    return { ok: false, error: "server_error" };
  }

  const { data: existing, error: existingError } = await db
    .from("approval_requests" as never)
    .select("id,payload")
    .eq("source_action_id" as never, input.booking.requestId)
    .maybeSingle();
  if (existingError || !existing) {
    return { ok: false, error: "server_error" };
  }
  const existingPayload = parseDeskAfterHoursApprovalPayload(
    (existing as { payload: unknown }).payload,
  );
  return existingPayload?.request_fingerprint === requestFingerprint
    ? { ok: true, approvalId: String((existing as { id: string }).id) }
    : { ok: false, error: "idempotency_conflict" };
}
