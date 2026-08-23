import "server-only";

import { createHash } from "node:crypto";
import { looseServiceClient, type LooseDb } from "./looseDb";
import {
  SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE,
  type SquareOptionalCapability,
} from "./optionalCapabilities";

type JsonRecord = Record<string, unknown>;
type WorkerDependencies = { db?: LooseDb };

export type SquareOptionalWebhookWorkerResult =
  | { status: "disabled"; capability: SquareOptionalCapability }
  | { status: "applied"; capability: SquareOptionalCapability; inboxId: string; code: string }
  | { status: "failed"; capability: SquareOptionalCapability; inboxId?: string; reason: string }
  | { status: "retry_pending"; capability: SquareOptionalCapability; inboxId?: string; reason: string };

const APPLY_FUNCTION: Record<SquareOptionalCapability, string> = {
  loyalty: "apply_square_loyalty_webhook_event",
  gift_cards: "apply_square_gift_card_webhook_event",
  inventory: "apply_square_inventory_webhook_event",
};
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Adopt signature-verified optional-product webhook rows into their PII-free
 * mirrors. Every application gate remains hard-off; current cron execution
 * returns before DB construction and cannot call a provider.
 */
export async function processSquareOptionalWebhookInbox(
  capability: SquareOptionalCapability,
  input: WorkerDependencies = {},
  limit = 25,
): Promise<SquareOptionalWebhookWorkerResult[]> {
  if (!SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE[capability]) {
    return [{ status: "disabled", capability }];
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return [{ status: "failed", capability, reason: "invalid_worker_input" }];
  }
  const db = input.db ?? looseServiceClient();
  const claimed = await db.rpc("claim_square_webhook_events", {
    p_feature: capability,
    p_limit: limit,
  });
  if (claimed.error) {
    return [{ status: "retry_pending", capability, reason: "inbox_claim_unavailable" }];
  }
  if (!Array.isArray(claimed.data)) return [];

  const results: SquareOptionalWebhookWorkerResult[] = [];
  for (const value of claimed.data) {
    const row = record(value);
    const inboxId = typeof row?.inbox_id === "string" ? row.inbox_id : "";
    const claimToken = typeof row?.claim_token === "string" ? row.claim_token : "";
    if (!UUID_RE.test(inboxId) || !UUID_RE.test(claimToken)) {
      results.push({ status: "failed", capability, reason: "invalid_inbox_claim" });
      continue;
    }
    const applied = await db.rpc(APPLY_FUNCTION[capability], {
      p_inbox_id: inboxId,
      p_claim_token: claimToken,
    });
    if (applied.error) {
      // The five-minute inbox lease and bounded claim attempt count provide the
      // retry. Do not guess whether the atomic application committed.
      results.push({
        status: "retry_pending",
        capability,
        inboxId,
        reason: "inbox_apply_unavailable",
      });
      continue;
    }
    const appliedRow = record(applied.data);
    if (appliedRow?.success === true) {
      results.push({
        status: "applied",
        capability,
        inboxId,
        code: String(appliedRow.code ?? "event_applied"),
      });
      continue;
    }

    const reason = String(appliedRow?.code ?? "event_application_rejected").slice(0, 240);
    const completed = await db.rpc("complete_square_webhook_event", {
      p_inbox_id: inboxId,
      p_claim_token: claimToken,
      p_status: "failed",
      p_result_fingerprint: fingerprint({ capability, inboxId, reason }),
      p_error_code: reason,
    });
    if (completed.error || record(completed.data)?.success !== true) {
      results.push({
        status: "retry_pending",
        capability,
        inboxId,
        reason: "failure_completion_unavailable",
      });
      continue;
    }
    results.push({ status: "failed", capability, inboxId, reason });
  }
  return results;
}
