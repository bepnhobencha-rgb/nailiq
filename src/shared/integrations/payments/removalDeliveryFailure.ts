import { CardDeliveryError, SQUARE_SAFE_ERROR_CODES, SQUARE_SAFE_ERROR_CATEGORIES } from "./cardDeliveryFailure";

/** Facts about this invocation, never permission to repeat a provider mutation. */
export const REMOVAL_DELIVERY_FAILURES = {
  removal_configuration_unavailable: ["configuration", "not_requested"],
  removal_configuration_invalid: ["configuration", "not_requested"],
  removal_dispatch_unavailable: ["dispatch_preparation", "not_requested"],
  removal_preflight_failed: ["provider_preflight", "not_requested"],
  removal_preflight_invalid: ["provider_preflight", "not_requested"],
  removal_provider_write_failed: ["provider_mutation", "possibly_dispatched"],
  removal_invalid_provider_receipt: ["receipt_validation", "possibly_dispatched"],
  removal_provider_unclassified: ["provider_unknown", "possibly_dispatched"],
  removal_completion_uncertain: ["database_completion", "not_proven"],
  removal_completion_rejected: ["database_completion", "not_proven"],
} as const;
export type RemovalFailureCode = keyof typeof REMOVAL_DELIVERY_FAILURES;
export type RemovalReadOutcome = "not_requested" | "read_failed" | "not_removed" | "invalid_receipt";
export type RemovalFailure = {
  code: RemovalFailureCode; stage: string; mutationStatus: string;
  retryability: "reconcile_first"; reconciliationOutcome: RemovalReadOutcome;
  httpStatus: number | null; squareCodes: string[]; squareCategories: string[];
};
const allowed = (value: unknown, list: readonly string[]) => Array.isArray(value)
  ? [...new Set(value.filter((v): v is string => typeof v === "string" && list.includes(v)))].slice(0, 8) : [];
export class RemovalDeliveryError extends Error {
  readonly failure: RemovalFailure;
  constructor(code: RemovalFailureCode, cause?: unknown, reconciliationOutcome: RemovalReadOutcome = "not_requested") {
    super(code); this.name = "RemovalDeliveryError";
    const prior = cause instanceof RemovalDeliveryError ? cause.failure : cause instanceof CardDeliveryError ? cause.failure : null;
    const [stage, mutationStatus] = REMOVAL_DELIVERY_FAILURES[code];
    const http = prior?.httpStatus;
    this.failure = { code, stage, mutationStatus, retryability: "reconcile_first", reconciliationOutcome,
      httpStatus: typeof http === "number" && Number.isInteger(http) && http >= 100 && http <= 599 ? http : null,
      squareCodes: allowed(prior?.squareCodes, SQUARE_SAFE_ERROR_CODES), squareCategories: allowed(prior?.squareCategories, SQUARE_SAFE_ERROR_CATEGORIES) };
  }
}
export function removalFailure(error: unknown, fallback: RemovalFailureCode): RemovalFailure {
  // Rebuild the bounded envelope even if a caller mutated a typed error.
  const f = error instanceof RemovalDeliveryError ? error.failure : null;
  const code = f && Object.hasOwn(REMOVAL_DELIVERY_FAILURES, f.code) ? f.code : fallback;
  const outcome = f && ["not_requested", "read_failed", "not_removed", "invalid_receipt"].includes(f.reconciliationOutcome)
    ? f.reconciliationOutcome : "not_requested";
  return new RemovalDeliveryError(code, error, outcome).failure;
}
export function removalFailureRpc(failure: RemovalFailure, provider: "square" | "stripe" | null) {
  const metadata = provider === "square" && ["provider_preflight", "provider_mutation", "receipt_validation"].includes(failure.stage);
  return { p_code: failure.code, p_stage: failure.stage, p_mutation_status: failure.mutationStatus,
    p_retryability: failure.retryability, p_reconciliation_outcome: failure.reconciliationOutcome, p_provider: provider,
    p_http_status: metadata ? failure.httpStatus : null, p_square_codes: metadata ? failure.squareCodes : [],
    p_square_categories: metadata ? failure.squareCategories : [] };
}
