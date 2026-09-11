import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { CardDeliveryError, cardFailure, safeCardFailure } from "@/shared/integrations/payments/cardDeliveryFailure";
import { ensureSquareCustomer, findSquareCustomerByReference, type SquareConfig } from "./client";

export type CardCustomerOperation = { operationId: string; attemptToken: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9:_-]{1,255}$/;
type ClaimedCustomer = {
  claimId: string; leaseToken: string; allowCreate: boolean; referenceId: string; idempotencyKey: string;
  material: { name: string | null; phone: string | null; email: string | null };
};
function row(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await createServiceRoleClient().rpc(name as never, args as never);
  if (error) throw new Error("customer_claim_database_unavailable");
  return row(data);
}

/** One durable identity per tenant/account/contact. The DB owns the canonical
 * contact and initial request material; no caller-supplied contact authorizes
 * access to another booking. All provider I/O happens outside SQL transactions. */
export async function resolveSquareCardCustomer(cfg: SquareConfig, operation: CardCustomerOperation): Promise<string> {
  if (!UUID.test(operation.operationId) || !UUID.test(operation.attemptToken)) {
    throw cardFailure("customer_search", "square_customer_search_failed", "safe_retry");
  }
  const authority = { p_operation_id: operation.operationId, p_attempt_token: operation.attemptToken };
  let value: Record<string, unknown> | null;
  try { value = await rpc("claim_square_card_customer", authority); }
  catch { throw cardFailure("customer_search", "square_customer_search_failed", "safe_retry"); }
  // Waiting followers have made no provider mutation. Their own card operation
  // may close safely while the shared customer claim retains the unresolved truth.
  if (value?.ok !== true) throw cardFailure("customer_search", "square_customer_search_failed", "safe_retry");
  if (value.salon_id !== cfg.salonId || value.merchant_id !== cfg.merchantId || value.environment !== cfg.environment) {
    throw cardFailure("configuration","square_config_unavailable","safe_retry");
  }
  if (value.code === "known" && typeof value.customer_id === "string" && ID.test(value.customer_id)) return value.customer_id;
  const material = row(value.request_material);
  if (value.code !== "claimed" || typeof value.claim_id !== "string" || !UUID.test(value.claim_id) ||
      typeof value.lease_token !== "string" || !UUID.test(value.lease_token) || typeof value.allow_create !== "boolean" ||
      value.salon_id !== cfg.salonId || value.merchant_id !== cfg.merchantId || value.environment !== cfg.environment ||
      typeof value.reference_id !== "string" || !/^(?:nq-customer|booking):[0-9a-f-]{36}$/i.test(value.reference_id) ||
      typeof value.idempotency_key !== "string" || !value.idempotency_key || value.idempotency_key.length > 45 || !material ||
      [material.client_name,material.client_phone,material.client_email].some(field => field != null && typeof field !== "string")) {
    throw cardFailure("customer_search", "square_customer_search_failed", "safe_retry");
  }
  const claim: ClaimedCustomer = { claimId:value.claim_id,leaseToken:value.lease_token,allowCreate:value.allow_create,
    referenceId:value.reference_id,idempotencyKey:value.idempotency_key,
    material:{name:typeof material.client_name === "string" ? material.client_name : null,
      phone:typeof material.client_phone === "string" ? material.client_phone : null,
      email:typeof material.client_email === "string" ? material.client_email : null} };
  const lease = { ...authority,p_claim_id:claim.claimId,p_lease_token:claim.leaseToken };
  const complete = (outcome: string, customerId: string | null = null) => rpc("complete_square_card_customer",
    { ...lease,p_outcome:outcome,p_customer_id:customerId });
  let dispatched = false;
  let customerId: string | null;
  try {
    if (!claim.allowCreate) {
      customerId = await findSquareCustomerByReference(cfg, claim.referenceId);
    } else {
      customerId = await ensureSquareCustomer(cfg, { ...claim.material,referenceId:claim.referenceId,
        idempotencyKey:claim.idempotencyKey,reconcileReference:true,matchEmailFallback:true,beforeCreate:async () => {
          try {
            const prepared = await rpc("prepare_square_card_customer",lease);
            if (prepared?.ok !== true) throw new Error("customer_prepare_not_acknowledged");
          } catch { throw cardFailure("dispatch_preparation","dispatch_binding_uncertain","safe_retry"); }
          dispatched = true;
        } });
    }
  } catch (error) {
    const failure = safeCardFailure(error,"customer_search");
    try { await complete(dispatched ? "unknown" : failure.retryability === "manual_review" ? "invalid" : claim.allowCreate ? "not_dispatched" : "read_failed"); }
    catch { /* No redispatch on lost DB acknowledgment; the durable lease expires. */ }
    throw error instanceof CardDeliveryError ? error
      : cardFailure("customer_search","square_customer_search_failed",dispatched ? "reconcile_first" : "safe_retry");
  }
  let completed: Record<string, unknown> | null;
  try { completed = await complete(customerId ? "found" : "not_found",customerId); }
  catch { throw cardFailure("database_completion","database_completion_uncertain","reconcile_first"); }
  if (!customerId) throw cardFailure("customer_search","square_customer_search_failed","safe_retry");
  if (completed?.ok !== true || completed.code !== "known" || completed.customer_id !== customerId) {
    throw cardFailure("database_completion","database_completion_uncertain","reconcile_first");
  }
  return customerId;
}
