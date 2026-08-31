import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  sendOwnerWaitlistNotification,
  type OwnerNotificationDispatchResult,
} from "@/shared/dashboard/sendOwnerBookingNotification";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RpcClient = Pick<SupabaseClient, "rpc">;

type Lease = {
  outboxId: string;
  attemptToken: string;
  salonId: string;
  waitlistEntryId: string;
};

type WorkerDeps = {
  client: RpcClient;
  send(
    salonId: string,
    waitlistEntryId: string,
    deliveryId: string,
  ): Promise<OwnerNotificationDispatchResult>;
};

export type OwnerWaitlistNotificationWorkerResult = {
  ok: boolean;
  code: "processed" | "lease_unavailable";
  claimed: number;
  sent: number;
  failed: number;
  unknown: number;
  suppressed: number;
  completionUnavailable: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return UUID_RE.test(normalized) ? normalized : null;
}

function parseLease(value: unknown): Lease | null {
  if (!isRecord(value) || value.success !== true || value.code !== "leased") {
    return null;
  }
  const outboxId = parseUuid(value.outbox_id);
  const attemptToken = parseUuid(value.attempt_token);
  const salonId = parseUuid(value.salon_id);
  const waitlistEntryId = parseUuid(value.waitlist_entry_id);
  return outboxId && attemptToken && salonId && waitlistEntryId
    ? { outboxId, attemptToken, salonId, waitlistEntryId }
    : null;
}

function boundedLimit(value: number): number {
  return Number.isSafeInteger(value) ? Math.min(Math.max(value, 1), 25) : 10;
}

function safeReason(value: string): string {
  return (
    value.replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 160) ||
    "delivery_failed"
  );
}

export async function runOwnerWaitlistNotificationWorker(
  requestedLimit = 10,
  overrides?: Partial<WorkerDeps>,
): Promise<OwnerWaitlistNotificationWorkerResult> {
  const deps: WorkerDeps = {
    client: overrides?.client ?? createServiceRoleClient(),
    send: overrides?.send ?? sendOwnerWaitlistNotification,
  };
  const result: OwnerWaitlistNotificationWorkerResult = {
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
    "claim_owner_waitlist_notification_outbox_batch" as never,
    { p_limit: boundedLimit(requestedLimit) } as never,
  );
  if (error || !Array.isArray(data)) return result;

  for (const rawLease of data) {
    const lease = parseLease(rawLease);
    if (!lease) continue;
    result.claimed += 1;

    let dispatch: OwnerNotificationDispatchResult;
    try {
      dispatch = await deps.send(
        lease.salonId,
        lease.waitlistEntryId,
        lease.outboxId,
      );
    } catch {
      dispatch = {
        outcome: "retryable_failure",
        reason: "dispatch_exception",
        sent: 0,
        failed: 1,
      };
    }

    const outcome =
      dispatch.outcome === "retryable_failure"
        ? "failed"
        : dispatch.outcome;
    result[outcome] += 1;

    const { data: completed, error: completionError } = await deps.client.rpc(
      "complete_owner_waitlist_notification_outbox" as never,
      {
        p_outbox_id: lease.outboxId,
        p_attempt_token: lease.attemptToken,
        p_outcome: outcome,
        p_provider_receipt_count: dispatch.sent,
        p_error_code:
          dispatch.outcome === "sent" ? null : safeReason(dispatch.reason),
      } as never,
    );
    if (
      completionError ||
      !isRecord(completed) ||
      completed.success !== true
    ) {
      result.completionUnavailable += 1;
    }
  }

  result.ok = true;
  result.code = "processed";
  return result;
}
