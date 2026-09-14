import "server-only";
import { CardDeliveryError, SQUARE_SAFE_ERROR_CODES, SQUARE_SAFE_ERROR_CATEGORIES } from "@/shared/integrations/payments/cardDeliveryFailure";

/** Internal diagnostics only. These codes never authorize another mutation. */
export const REMOVAL_RECOVERY_OUTCOMES = {
  recovery_context_unavailable: ["context", "reconcile_first", "not_requested"],
  recovery_context_invalid: ["context", "manual_review", "not_requested"],
  recovery_authority_expired_or_revoked: ["authority", "manual_review", "not_requested"],
  recovery_state_changed: ["authority", "manual_review", "not_requested"],
  recovery_identity_unavailable: ["authority", "manual_review", "not_requested"],
  square_config_unavailable: ["configuration", "reconcile_first", "not_requested"],
  removal_provider_mismatch: ["configuration", "manual_review", "not_requested"],
  reconciliation_read_failed: ["provider_read", "reconcile_first", "failed"],
  reconciliation_not_found: ["provider_read", "manual_review", "failed"],
  reconciliation_invalid_card: ["provider_read", "manual_review", "invalid_receipt"],
  reconciliation_card_active: ["provider_read", "manual_review", "completed"],
  database_completion_uncertain: ["database_completion", "reconcile_first", "completed"],
  recovery_completion_rejected: ["database_completion", "manual_review", "completed"],
} as const;
export type RemovalRecoveryOutcomeCode = keyof typeof REMOVAL_RECOVERY_OUTCOMES;

/** Re-sanitize even typed errors; never forward error.message/cause/raw objects. */
export function removalRecoveryDiagnostic(code: RemovalRecoveryOutcomeCode, provider: "square" | null, error?: unknown) {
  const [stage, retryability, readStatus] = REMOVAL_RECOVERY_OUTCOMES[code];
  const failure = error instanceof CardDeliveryError ? error.failure : null;
  const allow = (values: unknown, list: readonly string[]) => Array.isArray(values)
    ? [...new Set(values.filter((v): v is string => typeof v === "string" && list.includes(v)))].slice(0, 8) : [];
  const http = failure?.httpStatus;
  return { p_stage: stage, p_code: code, p_retryability: retryability, p_read_status: readStatus, p_provider: provider,
    p_http_status: stage === "provider_read" && typeof http === "number" && Number.isInteger(http) && http >= 100 && http <= 599 ? http : null,
    p_square_codes: stage === "provider_read" ? allow(failure?.squareCodes, SQUARE_SAFE_ERROR_CODES) : [],
    p_square_categories: stage === "provider_read" ? allow(failure?.squareCategories, SQUARE_SAFE_ERROR_CATEGORIES) : [] };
}

export function removalReadFailureCode(error: unknown): RemovalRecoveryOutcomeCode {
  if (error instanceof CardDeliveryError) {
    if (error.failure.code === "reconciliation_invalid_card") return "reconciliation_invalid_card";
    if (error.failure.httpStatus === 404 && Array.isArray(error.failure.squareCodes)
      && error.failure.squareCodes.includes("NOT_FOUND")) return "reconciliation_not_found";
  }
  return "reconciliation_read_failed";
}
