/** Only these bounded fields may cross the payment diagnostics boundary.
 * Never retain an original Error/cause, request, token or provider response. */
export type CardFailureStage =
  | "configuration" | "customer_search" | "customer_create" | "card_create"
  | "receipt_validation" | "dispatch_preparation" | "database_completion" | "reconciliation";
export type CardRetryability = "safe_retry" | "new_card" | "reconcile_first" | "manual_review";

export const SQUARE_SAFE_ERROR_CODES = [
  "UNAUTHORIZED", "ACCESS_TOKEN_EXPIRED", "ACCESS_TOKEN_REVOKED", "FORBIDDEN",
  "INSUFFICIENT_SCOPES", "RATE_LIMITED", "INTERNAL_SERVER_ERROR", "SERVICE_UNAVAILABLE",
  "BAD_REQUEST", "INVALID_REQUEST_ERROR", "INVALID_VALUE", "MISSING_REQUIRED_PARAMETER",
  "INVALID_PHONE_NUMBER", "INVALID_EMAIL_ADDRESS", "NOT_FOUND", "CONFLICT",
  "IDEMPOTENCY_KEY_REUSED", "CARD_DECLINED", "GENERIC_DECLINE", "CARD_NOT_SUPPORTED",
  "CARD_EXPIRED", "INVALID_CARD_DATA", "VERIFY_CVV_FAILURE", "VERIFY_AVS_FAILURE",
  "CARD_DECLINED_VERIFICATION_REQUIRED", "SOURCE_EXPIRED", "SOURCE_USED",
  "CUSTOMER_NOT_FOUND", "CARD_TOKEN_EXPIRED", "CARD_TOKEN_USED",
] as const;
export const SQUARE_SAFE_ERROR_CATEGORIES = [
  "API_ERROR", "AUTHENTICATION_ERROR", "INVALID_REQUEST_ERROR", "RATE_LIMIT_ERROR",
  "PAYMENT_METHOD_ERROR", "REFUND_ERROR",
] as const;

export type CardFailure = {
  stage: CardFailureStage;
  code: string;
  httpStatus: number | null;
  squareCodes: string[];
  squareCategories: string[];
  retryability: CardRetryability;
};

export class CardDeliveryError extends Error {
  readonly failure: CardFailure;
  constructor(failure: CardFailure) {
    super(failure.code);
    this.name = "CardDeliveryError";
    this.failure = failure;
  }
}

export function cardFailure(stage: CardFailureStage, code: string,
  retryability: CardRetryability, httpStatus: number | null = null): CardDeliveryError {
  return new CardDeliveryError({ stage, code, retryability, httpStatus,
    squareCodes: [], squareCategories: [] });
}

export function safeCardFailure(error: unknown, stage: CardFailureStage): CardFailure {
  return error instanceof CardDeliveryError ? error.failure : cardFailure(stage,
    stage === "configuration" ? "square_config_unavailable" :
      stage === "database_completion" ? "database_completion_uncertain" :
        stage === "reconciliation" ? "reconciliation_read_failed" : "provider_response_lost",
    stage === "configuration" ? "safe_retry" : "reconcile_first").failure;
}

export function squareFailureStage(method: string, path: string): CardFailureStage | null {
  if (path === "/customers/search") return "customer_search";
  if (path === "/customers" && method === "POST") return "customer_create";
  if (path === "/cards" && method === "POST") return "card_create";
  if (path.startsWith("/cards?reference_id=") || (method === "GET" && /^\/cards\/[^/]+$/.test(path))) return "reconciliation";
  return null;
}

export function stageFailureCode(stage: CardFailureStage): string {
  return ({ configuration: "square_config_unavailable", customer_search: "square_customer_search_failed",
    customer_create: "square_customer_create_failed", card_create: "square_card_create_failed",
    receipt_validation: "square_invalid_card_receipt", dispatch_preparation: "dispatch_prepare_uncertain",
    database_completion: "database_completion_uncertain", reconciliation: "reconciliation_read_failed" })[stage];
}
