import "server-only";

import { safeCardFailure } from "@/shared/integrations/payments/cardDeliveryFailure";

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
  expectedCustomerId: string | null;
  expectedMerchantId: string | null;
  expectedEnvironment: string | null;
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
  return { operationId, attemptToken, salonId, provider, providerReferenceKey,
    expectedCustomerId: typeof item?.expected_customer_id === "string" ? item.expected_customer_id : null,
    expectedMerchantId: typeof item?.expected_merchant_id === "string" ? item.expected_merchant_id : null,
    expectedEnvironment: typeof item?.expected_environment === "string" ? item.expected_environment : null };
}

async function complete(input: DueOperation & {
  outcome: "found" | "not_found" | "manual_review" | "multiple_matches" | "invalid_card" | "disabled_card" | "read_failed" | "config_unavailable";
  cardId?: string;
  customerId?: string;
  brand?: string;
  last4?: string;
}): Promise<boolean> {
  try {
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
    if (!error) return result?.ok === true && (input.outcome !== "found" || result.code === "reconciled_saved");
  } catch { /* Database response loss is not a provider read failure. */ }
  try {
    await createServiceRoleClient().rpc("record_booking_card_delivery_failure" as never, {
      p_operation_id: input.operationId, p_attempt_token: input.attemptToken,
      p_stage: "database_completion", p_code: "database_completion_uncertain", p_http_status: null,
      p_square_codes: [], p_square_categories: [], p_retryability: "reconcile_first",
    } as never);
  } catch { /* Durable lease remains the retry boundary when DB is unavailable. */ }
  return false;
}

/**
 * Reconcile ambiguous card saves with provider reads only. There is no source
 * token in this worker and no path to CreateCard, so response loss cannot
 * produce a duplicate card or booking.
 */
export async function reconcileBookingCardSaveOperations(limit = 10, operationId?: string): Promise<{
  ok: boolean;
  processed: number;
  reconciled: number;
  unresolved: number;
}> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    (operationId ? "claim_booking_card_save_reconciliation" : "reconcile_stale_booking_card_save_operations") as never,
    (operationId ? { p_operation_id: operationId } : { p_limit: Math.min(Math.max(limit, 0), 10) }) as never,
  );
  const rows = operationId ? [data] : data;
  if (error || !Array.isArray(rows)) {
    return { ok: false, processed: 0, reconciled: 0, unresolved: 1 };
  }

  let processed = 0;
  let reconciled = 0;
  let unresolved = 0;
  for (const raw of rows) {
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

    let cfg: Awaited<ReturnType<typeof getSquareConfig>>;
    try {
      cfg = await getSquareConfig(looseServiceClient(), item.salonId);
      if ((item.expectedMerchantId && cfg.merchantId !== item.expectedMerchantId) ||
          (item.expectedEnvironment && cfg.environment !== item.expectedEnvironment)) throw new Error("binding_changed");
    } catch {
      await complete({ ...item, outcome: "config_unavailable" });
      unresolved += 1;
      continue;
    }
    try {
      const cards = await listCardsByReferenceId(cfg, item.providerReferenceKey);
      if (cards.some((card) => card.referenceId !== item.providerReferenceKey)) {
        await complete({ ...item, outcome: "invalid_card" });
      } else if (cards.length === 0) {
        await complete({ ...item, outcome: "not_found" });
      } else if (cards.length > 1) {
        await complete({ ...item, outcome: "multiple_matches" });
      } else {
        const card = cards[0];
        if (!card.cardId || !card.customerId || !card.brand || !/^\d{4}$/.test(card.last4) ||
            (item.expectedCustomerId && card.customerId !== item.expectedCustomerId)) {
          await complete({ ...item, outcome: "invalid_card" });
        } else if (!card.enabled) {
          // An exact, fully bound disabled receipt closes this attempted card
          // lifecycle. Legacy/unbound or malformed reads never unlock re-entry.
          const bound = item.expectedCustomerId === card.customerId &&
            !!item.expectedMerchantId && item.expectedMerchantId === cfg.merchantId &&
            card.merchantId === item.expectedMerchantId &&
            !!item.expectedEnvironment && item.expectedEnvironment === cfg.environment;
          await complete({ ...item, outcome: bound ? "disabled_card" : "invalid_card",
            cardId: card.cardId, customerId: card.customerId, brand: card.brand, last4: card.last4 });
        } else if (await complete({ ...item, outcome: "found", cardId: card.cardId,
          customerId: card.customerId, brand: card.brand, last4: card.last4 })) {
          reconciled += 1;
          continue;
        }
      }
      unresolved += 1;
    } catch (error) {
      const failure = safeCardFailure(error, "reconciliation");
      // Separate failed provider reads from complete negative searches. Preserve
      // the safe transport detail before releasing the lease, with no raw logs.
      try {
        await db.rpc("record_booking_card_delivery_failure" as never, {
          p_operation_id: item.operationId, p_attempt_token: item.attemptToken,
          p_stage: failure.stage, p_code: failure.code, p_http_status: failure.httpStatus,
          p_square_codes: failure.squareCodes, p_square_categories: failure.squareCategories,
          p_retryability: failure.retryability,
        } as never);
        await complete({ ...item, outcome: failure.code === "reconciliation_invalid_card" ? "invalid_card" : "read_failed" });
      } catch { /* A lost completion acknowledgment leaves the lease to expire. */ }
      unresolved += 1;
    }
  }
  return { ok: unresolved === 0, processed, reconciled, unresolved };
}
