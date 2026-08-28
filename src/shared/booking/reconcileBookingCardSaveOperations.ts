import "server-only";

import {
  getSquareConfig,
  listCardsByReferenceId,
} from "@/shared/integrations/square/client";
import { looseServiceClient } from "@/shared/integrations/square/looseDb";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type DueOperation = {
  operationId: string;
  attemptToken: string;
  salonId: string;
  provider: "square" | "stripe";
  providerReferenceKey: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function parseDue(value: unknown): DueOperation | null {
  const item = record(value);
  const operationId = typeof item?.operation_id === "string" ? item.operation_id : "";
  const attemptToken = typeof item?.attempt_token === "string" ? item.attempt_token : "";
  const salonId = typeof item?.salon_id === "string" ? item.salon_id : "";
  const providerReferenceKey = typeof item?.provider_reference_key === "string"
    ? item.provider_reference_key
    : "";
  const provider = item?.provider === "square" || item?.provider === "stripe"
    ? item.provider
    : null;
  if (!UUID_RE.test(operationId) || !UUID_RE.test(attemptToken) ||
      !UUID_RE.test(salonId) || !provider ||
      providerReferenceKey !== `nq-card:${operationId}`) return null;
  return { operationId, attemptToken, salonId, provider, providerReferenceKey };
}

async function complete(input: DueOperation & {
  outcome: "found" | "not_found" | "manual_review";
  cardId?: string;
  customerId?: string;
  brand?: string;
  last4?: string;
}): Promise<boolean> {
  const { data, error } = await createServiceRoleClient().rpc(
    "complete_booking_card_save_reconciliation" as never,
    {
      p_operation_id: input.operationId,
      p_attempt_token: input.attemptToken,
      p_outcome: input.outcome,
      p_card_id: input.cardId ?? null,
      p_customer_id: input.customerId ?? null,
      p_card_brand: input.brand ?? null,
      p_card_last4: input.last4 ?? null,
    } as never,
  );
  const result = record(Array.isArray(data) ? data[0] : data);
  return !error && result?.ok === true;
}

/**
 * Reconcile ambiguous card saves with provider reads only. There is no source
 * token in this worker and no path to CreateCard, so response loss cannot
 * produce a duplicate card or booking.
 */
export async function reconcileBookingCardSaveOperations(limit = 10): Promise<{
  ok: boolean;
  processed: number;
  reconciled: number;
  unresolved: number;
}> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "reconcile_stale_booking_card_save_operations" as never,
    { p_limit: Math.min(Math.max(limit, 0), 10) } as never,
  );
  if (error || !Array.isArray(data)) {
    return { ok: false, processed: 0, reconciled: 0, unresolved: 1 };
  }

  let processed = 0;
  let reconciled = 0;
  let unresolved = 0;
  for (const raw of data) {
    const item = parseDue(raw);
    if (!item) {
      unresolved += 1;
      continue;
    }
    processed += 1;
    if (item.provider !== "square") {
      if (await complete({ ...item, outcome: "manual_review" })) unresolved += 1;
      else unresolved += 1;
      continue;
    }

    try {
      const cfg = await getSquareConfig(looseServiceClient(), item.salonId);
      const cards = (await listCardsByReferenceId(cfg, item.providerReferenceKey))
        .filter((card) => card.referenceId === item.providerReferenceKey);
      if (cards.length === 0) {
        if (await complete({ ...item, outcome: "not_found" })) unresolved += 1;
        else unresolved += 1;
        continue;
      }
      const card = cards.length === 1 ? cards[0] : null;
      if (!card || !card.enabled || !card.cardId || !card.customerId ||
          !card.brand || !/^\d{4}$/.test(card.last4)) {
        await complete({ ...item, outcome: "manual_review" });
        unresolved += 1;
        continue;
      }
      const saved = await complete({
        ...item,
        outcome: "found",
        cardId: card.cardId,
        customerId: card.customerId,
        brand: card.brand,
        last4: card.last4,
      });
      if (saved) reconciled += 1;
      else unresolved += 1;
    } catch {
      // Provider/config read failed. Do not advance the durable attempt or
      // mutate at the provider; a later cron invocation may safely read again.
      unresolved += 1;
    }
  }
  return { ok: unresolved === 0, processed, reconciled, unresolved };
}
