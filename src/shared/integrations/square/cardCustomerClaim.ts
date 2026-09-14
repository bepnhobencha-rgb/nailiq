import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { CardDeliveryError, cardFailure, safeCardFailure } from "@/shared/integrations/payments/cardDeliveryFailure";
import {
  ensureSquareCustomer, findSquareCustomerByReference, verifySquareCardCustomerIdentity,
  type SquareConfig,
} from "./client";

export type CardCustomerOperation = { operationId: string; attemptToken: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9:_-]{1,255}$/;
const REFERENCE = /^(?:nq-customer|booking):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOOKUP_MODES = ["verified_phone", "booking_reference", "legacy_reference", "legacy_phone"] as const;
type LookupMode = typeof LOOKUP_MODES[number];
type ClaimedCustomer = {
  claimId: string; leaseToken: string; allowCreate: boolean; referenceId: string; idempotencyKey: string;
  lookupMode: LookupMode; previouslyDispatched: boolean; expectedCustomerId: string | null;
  referenceAuthorized: boolean;
  verifyKnown: boolean;
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

/** SQL binds each customer claim to a booking or a proved phone. Contact typed
 * into a booking never authorizes reuse of another customer's Square profile.
 * Unknown provider requests retain their exact reference, key and body. */
export async function resolveSquareCardCustomer(cfg: SquareConfig, operation: CardCustomerOperation): Promise<string> {
  if (!UUID.test(operation.operationId) || !UUID.test(operation.attemptToken)) {
    throw cardFailure("customer_search", "square_customer_search_failed", "safe_retry");
  }
  const authority = { p_operation_id: operation.operationId, p_attempt_token: operation.attemptToken };
  let value: Record<string, unknown> | null;
  try { value = await rpc("claim_square_card_customer", authority); }
  catch { throw cardFailure("customer_search", "square_customer_search_failed", "safe_retry"); }
  if (value?.ok !== true) {
    throw cardFailure("customer_search", "square_customer_search_failed",
      value?.code === "identity_review_required" || value?.code === "legacy_customer_review_required" ? "manual_review" : "safe_retry");
  }
  if (value.salon_id !== cfg.salonId || value.merchant_id !== cfg.merchantId || value.environment !== cfg.environment) {
    throw cardFailure("configuration", "square_config_unavailable", "safe_retry");
  }
  if (value.identity_version !== 2 || value.operation_id !== operation.operationId.toLowerCase()
    || typeof value.booking_id !== "string" || !UUID.test(value.booking_id)
    || !LOOKUP_MODES.includes(value.lookup_mode as LookupMode)
    || typeof value.previously_dispatched !== "boolean" || typeof value.reference_authorized !== "boolean") {
    throw cardFailure("customer_search", "square_customer_search_failed", "safe_retry");
  }
  const lookupMode = value.lookup_mode as LookupMode;
  // Only a v2 claim already validated under this booking's current authority
  // can use a cached ID. Old known-contact claims always require a provider read.
  if (value.code === "known" && (lookupMode === "verified_phone" || lookupMode === "booking_reference")
    && typeof value.customer_id === "string" && ID.test(value.customer_id)
    && value.expected_customer_id === value.customer_id && value.reference_authorized) return value.customer_id;
  const material = row(value.request_material);
  const verifyKnown = value.code === "verify_known";
  if ((value.code !== "claimed_v2" && !verifyKnown)
    || typeof value.claim_id !== "string" || !UUID.test(value.claim_id)
    || typeof value.lease_token !== "string" || !UUID.test(value.lease_token)
    || typeof value.allow_create !== "boolean"
    || typeof value.reference_id !== "string" || !REFERENCE.test(value.reference_id)
    || typeof value.idempotency_key !== "string" || !value.idempotency_key || value.idempotency_key.length > 45
    || !material || [material.client_name, material.client_phone, material.client_email].some(field => field != null && typeof field !== "string")
    || (value.expected_customer_id !== null && (typeof value.expected_customer_id !== "string" || !ID.test(value.expected_customer_id)))
    || (verifyKnown && (value.allow_create || typeof value.expected_customer_id !== "string"
      || (lookupMode !== "legacy_reference" && lookupMode !== "legacy_phone")))
    || ((lookupMode === "verified_phone" || lookupMode === "legacy_phone") && typeof material.client_phone !== "string")
    || (!value.reference_authorized && (lookupMode !== "legacy_reference" || value.allow_create))
    || ((lookupMode === "legacy_reference" || lookupMode === "legacy_phone") && value.allow_create && !value.previously_dispatched)) {
    throw cardFailure("customer_search", "square_customer_search_failed", "safe_retry");
  }
  const claim: ClaimedCustomer = {
    claimId: value.claim_id, leaseToken: value.lease_token, allowCreate: value.allow_create,
    referenceId: value.reference_id, idempotencyKey: value.idempotency_key, lookupMode,
    previouslyDispatched: value.previously_dispatched, expectedCustomerId: value.expected_customer_id as string | null,
    referenceAuthorized: value.reference_authorized,
    verifyKnown, material: {
      name: typeof material.client_name === "string" ? material.client_name : null,
      phone: typeof material.client_phone === "string" ? material.client_phone : null,
      email: typeof material.client_email === "string" ? material.client_email : null,
    },
  };
  const lease = { ...authority, p_claim_id: claim.claimId, p_lease_token: claim.leaseToken };
  const complete = (outcome: string, customerId: string | null = null) => rpc("complete_square_card_customer",
    { ...lease, p_outcome: outcome, p_customer_id: customerId });
  let dispatched = false;
  let customerId: string | null;
  let identityRejected = false;
  try {
    if (claim.verifyKnown) {
      customerId = claim.expectedCustomerId;
      const matches = await verifySquareCardCustomerIdentity(cfg, claim.lookupMode === "legacy_phone"
        ? { customerId: customerId!, verifiedPhone: claim.material.phone! }
        : { customerId: customerId!, referenceId: claim.referenceId });
      identityRejected = !matches || !claim.referenceAuthorized;
    } else if (!claim.allowCreate) {
      customerId = await findSquareCustomerByReference(cfg, claim.referenceId);
      if (customerId && !claim.referenceAuthorized) identityRejected = true;
      if (customerId && claim.lookupMode === "legacy_phone") {
        identityRejected = !await verifySquareCardCustomerIdentity(cfg,
          { customerId, verifiedPhone: claim.material.phone! });
      }
    } else {
      customerId = await ensureSquareCustomer(cfg, {
        ...claim.material, referenceId: claim.referenceId, idempotencyKey: claim.idempotencyKey,
        lookupPolicy: claim.lookupMode === "verified_phone" ? "verified_phone" : "reference_only",
        previouslyDispatched: claim.previouslyDispatched,
        beforeCreate: async () => {
          try {
            const prepared = await rpc("prepare_square_card_customer", lease);
            if (prepared?.ok !== true) throw new Error("customer_prepare_not_acknowledged");
          } catch { throw cardFailure("dispatch_preparation", "dispatch_binding_uncertain", "safe_retry"); }
          dispatched = true;
        },
      });
      if (claim.lookupMode === "legacy_phone") {
        identityRejected = !await verifySquareCardCustomerIdentity(cfg,
          { customerId, verifiedPhone: claim.material.phone! });
      }
    }
  } catch (error) {
    const failure = safeCardFailure(error, "customer_search");
    try {
      await complete(dispatched ? "unknown" : failure.retryability === "manual_review" ? "invalid"
        : claim.allowCreate ? "not_dispatched" : "read_failed");
    } catch { /* An unacknowledged lease cannot authorize another dispatch. */ }
    // A successful creation followed by a failed identity read is still an
    // uncertain delivered request. Preserve the stage/status without letting
    // a read's safe_retry classification erase the preceding mutation.
    if (dispatched && failure.retryability !== "manual_review") {
      throw new CardDeliveryError({ ...failure, retryability: "reconcile_first" });
    }
    throw error instanceof CardDeliveryError ? error
      : cardFailure("customer_search", "square_customer_search_failed", "safe_retry");
  }
  let completed: Record<string, unknown> | null;
  try { completed = await complete(identityRejected ? "identity_not_authorized" : customerId ? "found" : "not_found",
    identityRejected ? null : customerId); }
  catch { throw cardFailure("database_completion", "database_completion_uncertain", "reconcile_first"); }
  if (identityRejected) {
    throw cardFailure("customer_search", "square_customer_identity_unverified",
      completed?.ok === true && completed.code === "identity_retry_required" ? "safe_retry" : "manual_review");
  }
  if (!customerId && completed?.ok === true && completed.code === "identity_review_required") {
    throw cardFailure("customer_search", "square_customer_identity_unverified", "manual_review");
  }
  if (!customerId) throw cardFailure("customer_search", "square_customer_search_failed", "safe_retry");
  if (completed?.ok !== true || completed.code !== "known" || completed.customer_id !== customerId) {
    throw cardFailure("database_completion", "database_completion_uncertain", "reconcile_first");
  }
  return customerId;
}
