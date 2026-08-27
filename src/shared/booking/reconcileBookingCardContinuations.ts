import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type ContinuationStatus =
  | "pending"
  | "awaiting_customer"
  | "provider_reconciliation"
  | "resolved"
  | "manual_review";

const STATUSES = new Set<ContinuationStatus>([
  "pending",
  "awaiting_customer",
  "provider_reconciliation",
  "resolved",
  "manual_review",
]);

/**
 * Reconcile only NailIQ-owned state. This module intentionally has no payment
 * provider import, fetch, source token, or booking-create path.
 */
export async function reconcileBookingCardContinuations(limit = 10): Promise<{
  ok: boolean;
  processed: number;
  awaitingCustomer: number;
  pendingProvider: number;
  resolved: number;
  manualReview: number;
  errors: number;
}> {
  const { data, error } = await createServiceRoleClient().rpc(
    "reconcile_due_booking_card_management_continuations" as never,
    { p_limit: Math.min(Math.max(limit, 0), 10) } as never,
  );
  if (error || !Array.isArray(data)) {
    return {
      ok: false, processed: 0, awaitingCustomer: 0, pendingProvider: 0,
      resolved: 0, manualReview: 0, errors: 1,
    };
  }

  let processed = 0;
  let awaitingCustomer = 0;
  let pendingProvider = 0;
  let resolved = 0;
  let manualReview = 0;
  let errors = 0;
  for (const raw of data) {
    const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    const status = typeof row?.status === "string" && STATUSES.has(row.status as ContinuationStatus)
      ? row.status as ContinuationStatus
      : null;
    if (row?.ok !== true || !status) {
      errors += 1;
      continue;
    }
    processed += 1;
    if (status === "awaiting_customer") awaitingCustomer += 1;
    else if (status === "provider_reconciliation") pendingProvider += 1;
    else if (status === "resolved") resolved += 1;
    else if (status === "manual_review") manualReview += 1;
  }
  return {
    ok: errors === 0,
    processed,
    awaitingCustomer,
    pendingProvider,
    resolved,
    manualReview,
    errors,
  };
}
