import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { promoteAndDeliverWaitlistForBooking } from "@/shared/noshow/promoteAndDeliverWaitlistOffer";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RpcClient = Pick<SupabaseClient, "rpc">;

type FinalizeReceipt = {
  ok: boolean;
  code: string;
  decisionId: string | null;
  bookingId: string | null;
  salonId: string | null;
};

type EffectsLease = {
  decisionId: string;
  bookingId: string;
  salonId: string;
  leaseToken: string;
  occurrenceKey: string;
  needsWaitlist: boolean;
  needsOwnerNotification: boolean;
};

export type NoShowEffectsRunResult = {
  available: boolean;
  claimed: number;
  completed: number;
  failed: number;
  unknown: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rpcRows(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function safeCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_:-]{1,120}$/.test(value)
    ? value
    : fallback;
}

function parseFinalizeReceipt(value: unknown): FinalizeReceipt | null {
  const row = record(value);
  if (!row) return null;
  const decisionId = typeof row.decision_id === "string" && UUID_RE.test(row.decision_id)
    ? row.decision_id
    : null;
  const bookingId = typeof row.booking_id === "string" && UUID_RE.test(row.booking_id)
    ? row.booking_id
    : null;
  const salonId = typeof row.salon_id === "string" && UUID_RE.test(row.salon_id)
    ? row.salon_id
    : null;
  return {
    ok: row.success === true,
    code: safeCode(row.code, "invalid_finalize_response"),
    decisionId,
    bookingId,
    salonId,
  };
}

function parseEffectsLease(value: unknown): EffectsLease | null {
  const row = record(value);
  if (!row || row.success !== true || row.code !== "effects_leased") return null;
  const decisionId = typeof row.decision_id === "string" ? row.decision_id : "";
  const bookingId = typeof row.booking_id === "string" ? row.booking_id : "";
  const salonId = typeof row.salon_id === "string" ? row.salon_id : "";
  const leaseToken = typeof row.lease_token === "string" ? row.lease_token : "";
  const occurrenceKey = typeof row.occurrence_key === "string"
    ? row.occurrence_key
    : "";
  if (
    !UUID_RE.test(decisionId) ||
    !UUID_RE.test(bookingId) ||
    !UUID_RE.test(salonId) ||
    !UUID_RE.test(leaseToken) ||
    occurrenceKey !== decisionId ||
    typeof row.needs_waitlist !== "boolean" ||
    typeof row.needs_owner_notification !== "boolean"
  ) {
    return null;
  }
  return {
    decisionId,
    bookingId,
    salonId,
    leaseToken,
    occurrenceKey,
    needsWaitlist: row.needs_waitlist,
    needsOwnerNotification: row.needs_owner_notification,
  };
}

export async function finalizeDueNoShowDecisions(input?: {
  decisionId?: string | null;
  salonId?: string | null;
  limit?: number;
  client?: RpcClient;
}): Promise<FinalizeReceipt[]> {
  const decisionId = input?.decisionId?.trim() || null;
  const salonId = input?.salonId?.trim() || null;
  const limit = Number.isSafeInteger(input?.limit)
    ? Math.min(Math.max(input?.limit ?? 25, 1), 100)
    : 25;
  if ((decisionId && !UUID_RE.test(decisionId)) || (salonId && !UUID_RE.test(salonId))) {
    return [{
      ok: false,
      code: "invalid_decision",
      decisionId: null,
      bookingId: null,
      salonId: null,
    }];
  }
  const client = input?.client ?? createServiceRoleClient();
  const { data, error } = await client.rpc(
    "finalize_due_booking_no_shows_v1" as never,
    { p_decision_id: decisionId, p_limit: limit, p_salon_id: salonId } as never,
  );
  if (error) {
    return [{
      ok: false,
      code: "finalize_unavailable",
      decisionId,
      bookingId: null,
      salonId: null,
    }];
  }
  const receipts = rpcRows(data)
    .map(parseFinalizeReceipt)
    .filter((row): row is FinalizeReceipt => row !== null);
  await Promise.all(receipts.map(async (receipt) => {
    if (
      !receipt.ok ||
      !receipt.decisionId ||
      !receipt.salonId ||
      (receipt.code !== "decision_committed" && receipt.code !== "commit_replay")
    ) return;
    // Best effort only: attendance truth is already committed and must never
    // be rolled back because a fee review is ineligible or unavailable.
    try {
      await client.rpc("ensure_booking_no_show_fee_review" as never, {
        p_decision_id: receipt.decisionId,
        p_salon_id: receipt.salonId,
      } as never);
    } catch {
      // The owner queue can reconcile/create the review later.
    }
  }));
  return receipts;
}

export async function runNoShowDecisionEffects(input?: {
  decisionId?: string | null;
  salonId?: string | null;
  limit?: number;
  client?: RpcClient;
}): Promise<NoShowEffectsRunResult> {
  const result: NoShowEffectsRunResult = {
    available: true,
    claimed: 0,
    completed: 0,
    failed: 0,
    unknown: 0,
  };
  const decisionId = input?.decisionId?.trim() || null;
  const salonId = input?.salonId?.trim() || null;
  if ((decisionId && !UUID_RE.test(decisionId)) || (salonId && !UUID_RE.test(salonId))) {
    return result;
  }
  const limit = Number.isSafeInteger(input?.limit)
    ? Math.min(Math.max(input?.limit ?? 10, 1), 25)
    : 10;
  const client = input?.client ?? createServiceRoleClient();
  const { data, error } = await client.rpc(
    "claim_booking_no_show_effects_v1" as never,
    { p_decision_id: decisionId, p_limit: limit, p_salon_id: salonId } as never,
  );
  if (error) return { ...result, available: false };

  const rows = rpcRows(data);
  const leases = rows
    .map(parseEffectsLease)
    .filter((row): row is EffectsLease => row !== null);
  if (rows.length > 0 && leases.length === 0) {
    return { ...result, available: false };
  }
  for (const lease of leases) {
    result.claimed += 1;
    let waitlistOutcome: "completed" | "failed" | "unknown" | null = null;
    let ownerOutcome: "completed" | "failed" | "unknown" | null = null;
    const errors: string[] = [];

    if (lease.needsWaitlist) {
      try {
        const promoted = await promoteAndDeliverWaitlistForBooking(lease.bookingId);
        waitlistOutcome = promoted.ok ? "completed" : "failed";
        if (!promoted.ok) errors.push(`waitlist:${safeCode(promoted.code, "failed")}`);
      } catch {
        waitlistOutcome = "unknown";
        errors.push("waitlist:outcome_unknown");
      }
    }

    if (lease.needsOwnerNotification) {
      try {
        const owner = await sendOwnerBookingNotification({
          salonId: lease.salonId,
          bookingId: lease.bookingId,
          event: "no_show",
          eventOccurrenceKey: lease.occurrenceKey,
        });
        ownerOutcome = owner.outcome === "sent" || owner.outcome === "suppressed"
          ? "completed"
          : owner.outcome === "unknown"
            ? "unknown"
            : "failed";
        if (ownerOutcome !== "completed") {
          errors.push(`owner:${safeCode(owner.reason, "failed")}`);
        }
      } catch {
        ownerOutcome = "unknown";
        errors.push("owner:outcome_unknown");
      }
    }

    const errorCode = errors.length > 0
      ? safeCode(errors.join(":"), "effects_failed")
      : null;
    const { data: completed, error: completionError } = await client.rpc(
      "complete_booking_no_show_effects_v1" as never,
      {
        p_decision_id: lease.decisionId,
        p_lease_token: lease.leaseToken,
        p_waitlist_outcome: waitlistOutcome,
        p_owner_outcome: ownerOutcome,
        p_error_code: errorCode,
      } as never,
    );
    const completion = record(Array.isArray(completed) ? completed[0] : completed);
    if (completionError || completion?.success !== true) {
      result.unknown += 1;
      continue;
    }
    if (completion.effects_state === "completed") result.completed += 1;
    else if (completion.effects_state === "failed") result.failed += 1;
    else result.unknown += 1;
  }
  return result;
}

export async function finalizeAndProcessNoShowDecision(
  decisionId: string,
  salonId: string,
): Promise<FinalizeReceipt> {
  const [receipt] = await finalizeDueNoShowDecisions({
    decisionId,
    salonId,
    limit: 1,
  });
  const fallback: FinalizeReceipt = {
    ok: false,
    code: "finalize_unavailable",
    decisionId,
    bookingId: null,
    salonId: null,
  };
  if (!receipt) return fallback;
  if (
    receipt.ok &&
    (receipt.code === "decision_committed" || receipt.code === "commit_replay")
  ) {
    await runNoShowDecisionEffects({ decisionId, salonId, limit: 1 });
  }
  return receipt;
}
