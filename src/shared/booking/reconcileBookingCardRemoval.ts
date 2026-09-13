import "server-only";
import { randomUUID } from "node:crypto";
import { removalRecoveryDiagnostic, removalReadFailureCode, type RemovalRecoveryOutcomeCode } from "./removalRecoveryOutcome";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { looseServiceClient } from "@/shared/integrations/square/looseDb";
import { getSquareConfig, readSquareCardStateById } from "@/shared/integrations/square/client";

type Result = { ok: boolean; code: string; idempotent?: boolean };
const unknown = (): Result => ({ ok: false, code: "remove_unknown" });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const providerId = /^[A-Za-z0-9:_-]{1,255}$/;
function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function removed(value: Record<string, unknown> | null): Result | null {
  return value?.ok === true && value.code === "removed" && typeof value.idempotent === "boolean"
    ? { ok: true, code: "removed", idempotent: value.idempotent } : null;
}

type CustomerInput = { tokenId: string; requestId: string; expectedCardFingerprint: string };
type OwnerInput = { salonId: string; operationId: string; actorId: string };
/** Positive read-only recovery; no path to disable/create/attach/charge. */
export async function reconcileBookingCardRemoval(input: CustomerInput): Promise<Result> {
  return reconcile(input);
}
/** Trusted server caller only; RPCs independently verify the current Owner/Admin. */
export async function reconcileOwnerBookingCardRemoval(input: OwnerInput): Promise<Result> {
  return reconcile(input);
}
async function reconcile(input: CustomerInput | OwnerInput): Promise<Result> {
  const owner = "actorId" in input;
  if (owner ? [input.actorId, input.salonId, input.operationId].some(v => !uuid.test(v))
    : !uuid.test(input.tokenId) || !uuid.test(input.requestId) || !/^[0-9a-f]{64}$/.test(input.expectedCardFingerprint)) {
    return { ok: false, code: "invalid_request" };
  }
  const args = owner
    ? { p_salon_id: input.salonId, p_operation_id: input.operationId, p_actor_id: input.actorId }
    : { p_token_id: input.tokenId, p_request_id: input.requestId, p_card_fingerprint: input.expectedCardFingerprint };
  const db = createServiceRoleClient();
  const eventId = randomUUID();
  async function observe(code: RemovalRecoveryOutcomeCode, provider: "square" | null = null, error?: unknown) {
    try {
      await db.rpc((owner ? "record_owner_booking_card_removal_recovery_outcome" : "record_booking_card_removal_recovery_outcome") as never, {
        ...args, p_event_id: eventId, ...removalRecoveryDiagnostic(code, provider, error),
      } as never);
    } catch { /* Best effort only; failed diagnostics never authorize provider work. */ }
  }
  let context: Record<string, unknown> | null;
  try {
    const result = await db.rpc((owner ? "prepare_owner_booking_card_removal_recovery" : "get_booking_card_removal_recovery_context") as never, args as never);
    if (result.error) { await observe("recovery_context_unavailable"); return unknown(); }
    context = row(result.data);
  } catch { await observe("recovery_context_unavailable"); return unknown(); }
  if (owner && context?.ok === false && context.code === "in_flight") return { ok: false, code: "in_flight" };
  const replay = removed(context);
  if (replay) return replay;
  if (context?.ok !== true || context.code !== "recovery_read_required") {
    const code = context?.code;
    await observe(code === "expired_or_revoked" ? "recovery_authority_expired_or_revoked"
      : code === "booking_state_changed" ? "recovery_state_changed"
        : code === "removal_manual_review" ? "recovery_identity_unavailable" : "recovery_context_invalid");
    return unknown();
  }
  const { operation_id: operationId, source_save_operation_id: sourceId, salon_id: salonId,
    source_removal_binding_id: bindingId,
    card_id: cardId, customer_id: customerId, merchant_id: merchantId, environment } = context;
  const historicSource = typeof sourceId === "string" && uuid.test(sourceId) && bindingId == null;
  const dispatchSource = sourceId == null && typeof bindingId === "string" && bindingId === operationId;
  if ((owner && (operationId !== input.operationId || salonId !== input.salonId))
    || (!historicSource && !dispatchSource)
    || [operationId, salonId].some(v => typeof v !== "string" || !uuid.test(v))
    || [cardId, customerId, merchantId].some(v => typeof v !== "string" || !providerId.test(v))
    || (environment !== "sandbox" && environment !== "production")) {
    await observe("recovery_context_invalid"); return unknown();
  }
  let cfg: Awaited<ReturnType<typeof getSquareConfig>>;
  try {
    cfg = await getSquareConfig(looseServiceClient(), salonId as string);
    if (cfg.salonId !== salonId || cfg.merchantId !== merchantId || cfg.environment !== environment) {
      await observe("removal_provider_mismatch", "square"); return unknown();
    }
  } catch { await observe("square_config_unavailable", "square"); return unknown(); }
  let card: Awaited<ReturnType<typeof readSquareCardStateById>>;
  try {
    card = await readSquareCardStateById(cfg, cardId as string, customerId as string);
    if (!card || typeof card.enabled !== "boolean" || card.cardId !== cardId || card.customerId !== customerId
      || card.merchantId !== merchantId || !/^\d{4}$/.test(card.last4) || !card.brand) {
      await observe("reconciliation_invalid_card", "square"); return unknown();
    }
    if (card.enabled) { await observe("reconciliation_card_active", "square"); return unknown(); }
  } catch (error) { await observe(removalReadFailureCode(error), "square", error); return unknown(); }
  try {
    const result = await db.rpc((owner ? "complete_owner_booking_card_removal_recovery" : "complete_booking_card_removal_recovery") as never, {
      ...args, p_receipt: { operation_id: operationId, source_save_operation_id: sourceId ?? null,
        ...(dispatchSource ? { source_removal_binding_id: bindingId } : {}),
        card_id: card.cardId, customer_id: card.customerId, merchant_id: card.merchantId,
        environment, enabled: false, brand: card.brand, last4: card.last4 },
    } as never);
    if (!result.error) {
      const completed = removed(row(result.data));
      if (completed) return completed;
      await observe("recovery_completion_rejected", "square"); return unknown();
    }
  } catch { /* A lost DB receipt never authorizes another provider mutation. */ }
  await observe("database_completion_uncertain", "square");
  return { ok: false, code: "completion_write_uncertain" };
}
