import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  sendOwnerBookingNotification,
  type OwnerNotificationDispatchResult,
  type OwnerNotifyInput,
} from "@/shared/dashboard/sendOwnerBookingNotification";
import type {
  OwnerNotificationActor,
  OwnerNotificationChangeField,
} from "@/shared/dashboard/ownerBookingNotificationCopy";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64_RE = /^[0-9a-f]{64}$/;
const ACTORS = new Set<OwnerNotificationActor>([
  "customer", "public_guest", "owner", "admin", "manager", "senior",
  "receptionist", "nail_tech", "trainee", "viewer", "accounting",
  "voice_ai", "demo_cookie", "system",
]);
const CHANGE_FIELDS = new Set<OwnerNotificationChangeField>([
  "time", "staff", "service", "addon",
]);

type RpcClient = Pick<SupabaseClient, "rpc">;

type OwnerOutboxLease = {
  outboxId: string;
  attemptToken: string;
  input: OwnerNotifyInput;
};

export type OwnerBookingNotificationWorkerResult = {
  ok: boolean;
  code: "processed" | "lease_unavailable";
  claimed: number;
  sent: number;
  failed: number;
  unknown: number;
  suppressed: number;
  completionUnavailable: number;
};

type WorkerDeps = {
  client: RpcClient;
  send(input: OwnerNotifyInput): Promise<OwnerNotificationDispatchResult>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized)
    ? normalized
    : null;
}

function parseLease(value: unknown): OwnerOutboxLease | null {
  if (!record(value) || value.success !== true || value.code !== "leased") return null;
  const outboxId = text(value.outbox_id, 80);
  const attemptToken = text(value.attempt_token, 80);
  const salonId = text(value.salon_id, 80);
  const bookingId = text(value.booking_id, 80);
  const occurrenceKey = text(value.occurrence_key, 64);
  const event = value.event_type === "new"
    ? "new"
    : value.event_type === "reschedule"
      ? "reschedule"
      : value.event_type === "cancel"
        ? "cancel"
        : null;
  if (
    !outboxId || !UUID_RE.test(outboxId) ||
    !attemptToken || !UUID_RE.test(attemptToken) ||
    !salonId || !UUID_RE.test(salonId) ||
    !bookingId || !UUID_RE.test(bookingId) ||
    !occurrenceKey || !HEX_64_RE.test(occurrenceKey) ||
    !event
  ) return null;

  const previousStart = value.previous_start_time_utc === null
    ? null
    : text(value.previous_start_time_utc, 80);
  if (previousStart && !Number.isFinite(Date.parse(previousStart))) return null;
  const groupSize = typeof value.group_size === "number" &&
      Number.isSafeInteger(value.group_size) && value.group_size >= 2 && value.group_size <= 50
    ? value.group_size
    : null;
  const changedBy = typeof value.changed_by === "string" &&
      ACTORS.has(value.changed_by as OwnerNotificationActor)
    ? value.changed_by as OwnerNotificationActor
    : null;
  const changedFields = Array.isArray(value.changed_fields) &&
      value.changed_fields.every((field) =>
        typeof field === "string" && CHANGE_FIELDS.has(field as OwnerNotificationChangeField))
    ? Array.from(new Set(value.changed_fields)) as OwnerNotificationChangeField[]
    : [];

  return {
    outboxId,
    attemptToken,
    input: {
      salonId,
      bookingId,
      event,
      eventOccurrenceKey: occurrenceKey,
      previousStartUtc: previousStart,
      groupSize,
      changedBy,
      changedFields,
    },
  };
}

function boundedLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 25) : 10;
}

function safeReason(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 160) || "delivery_failed";
}

export async function runOwnerBookingNotificationWorker(
  requestedLimit = 10,
  overrides?: Partial<WorkerDeps>,
): Promise<OwnerBookingNotificationWorkerResult> {
  const deps: WorkerDeps = {
    client: overrides?.client ?? createServiceRoleClient(),
    send: overrides?.send ?? sendOwnerBookingNotification,
  };
  const result: OwnerBookingNotificationWorkerResult = {
    ok: false,
    code: "lease_unavailable",
    claimed: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
    suppressed: 0,
    completionUnavailable: 0,
  };

  const { data, error } = await deps.client.rpc(
    "claim_owner_booking_notification_outbox_batch" as never,
    { p_limit: boundedLimit(requestedLimit) } as never,
  );
  if (error || !Array.isArray(data)) return result;

  for (const rawLease of data) {
    const lease = parseLease(rawLease);
    if (!lease) continue;
    result.claimed += 1;
    let dispatch: OwnerNotificationDispatchResult;
    try {
      dispatch = await deps.send(lease.input);
    } catch {
      dispatch = {
        outcome: "retryable_failure",
        reason: "dispatch_exception",
        sent: 0,
        failed: 1,
      };
    }

    const outcome = dispatch.outcome === "retryable_failure"
      ? "failed"
      : dispatch.outcome;
    result[outcome] += 1;
    const { data: completed, error: completionError } = await deps.client.rpc(
      "complete_owner_booking_notification_outbox" as never,
      {
        p_outbox_id: lease.outboxId,
        p_attempt_token: lease.attemptToken,
        p_outcome: outcome,
        p_error_code: dispatch.outcome === "sent" ? null : safeReason(dispatch.reason),
      } as never,
    );
    if (
      completionError || !record(completed) || completed.success !== true
    ) result.completionUnavailable += 1;
  }

  result.ok = true;
  result.code = "processed";
  return result;
}
