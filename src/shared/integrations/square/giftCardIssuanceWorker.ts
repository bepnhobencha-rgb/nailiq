import "server-only";

import { createHash } from "node:crypto";
import {
  activateSquareGiftCard,
  createSquareDigitalGiftCard,
  createSquareGiftCardPayment,
  type SquareConfig,
} from "./client";
import { looseServiceClient, type LooseDb } from "./looseDb";
import {
  SQUARE_OPTIONAL_API_VERSION,
  SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE,
} from "./optionalCapabilities";

type JsonRecord = Record<string, unknown>;

type CreateInput = {
  operationKind: "gift_card_create";
  salonId: string;
  requestId: string;
  expectedEnvironment: "sandbox" | "production";
  sourceId: string;
};

type PaymentInput = {
  operationKind: "gift_card_payment";
  salonId: string;
  requestId: string;
  expectedEnvironment: "sandbox" | "production";
  sourceId: string;
  parentOperationId: string;
  paymentSourceToken: string;
  amountCents: number;
  currency: "CAD";
  orderId: string;
};

type ActivationInput = {
  operationKind: "gift_card_activate";
  salonId: string;
  requestId: string;
  expectedEnvironment: "sandbox" | "production";
  sourceId: string;
  parentOperationId: string;
  amountCents: number;
  currency: "CAD";
  orderId: string;
  lineItemUid: string;
};

export type SquareGiftCardOperationInput =
  | CreateInput
  | PaymentInput
  | ActivationInput;

type Dependencies = {
  db?: LooseDb;
  createGiftCard?: typeof createSquareDigitalGiftCard;
  createPayment?: typeof createSquareGiftCardPayment;
  activateGiftCard?: typeof activateSquareGiftCard;
};

export type SquareGiftCardOperationResult =
  | { status: "disabled"; reason: "app_contract_unavailable" }
  | { status: "not_ready"; reason: string }
  | { status: "retry_pending"; reason: string; operationId?: string }
  | { status: "failed"; reason: string; operationId?: string }
  | {
      status: "succeeded";
      operationId: string;
      providerObjectId: string;
      providerReceiptId: string;
      replay: boolean;
    };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown, max = 255): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= max
    && !CONTROL_RE.test(value) ? value : null;
}

function money(value: unknown): { amount: number; currency: string } | null {
  const row = record(value);
  return Number.isSafeInteger(row?.amount) && typeof row?.currency === "string"
    ? { amount: row.amount as number, currency: row.currency }
    : null;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requestMaterial(input: SquareGiftCardOperationInput): JsonRecord | null {
  if (!UUID_RE.test(input.salonId) || !UUID_RE.test(input.requestId)) return null;
  if (input.expectedEnvironment !== "sandbox" && input.expectedEnvironment !== "production") {
    return null;
  }
  if (!text(input.sourceId)) return null;
  if (input.operationKind === "gift_card_create") {
    // The shared Square client requires an explicit merchant currency. Keep
    // the currently approved Canadian Gift Card contract pinned to CAD even
    // though CreateGiftCard itself carries no Money body.
    return { source_id: input.sourceId, currency: "CAD" };
  }
  if (!UUID_RE.test(input.parentOperationId)) return null;
  if (
    !Number.isSafeInteger(input.amountCents)
    || input.amountCents < 1
    || input.amountCents > 200_000
    || input.currency !== "CAD"
    || !text(input.orderId, 192)
  ) return null;
  if (input.operationKind === "gift_card_payment") {
    if (!text(input.paymentSourceToken)) return null;
    return {
      source_id: input.sourceId,
      parent_operation_id: input.parentOperationId,
      payment_source_token: input.paymentSourceToken,
      amount_cents: String(input.amountCents),
      currency: input.currency,
      order_id: input.orderId,
    };
  }
  if (!text(input.lineItemUid, 192)) return null;
  return {
    source_id: input.sourceId,
    parent_operation_id: input.parentOperationId,
    amount_cents: String(input.amountCents),
    currency: input.currency,
    order_id: input.orderId,
    line_item_uid: input.lineItemUid,
  };
}

function providerConfig(
  value: unknown,
  salonId: string,
  expectedEnvironment: "sandbox" | "production",
): SquareConfig | null {
  const row = record(value);
  const environment = row?.environment;
  const providerSalonId = text(row?.salon_id);
  const merchantId = text(row?.merchant_id);
  const locationId = text(row?.location_id);
  const accessToken = text(row?.access_token, 4096);
  const applicationId = text(row?.application_id);
  const currency = text(row?.currency, 3);
  if (environment !== "sandbox" && environment !== "production") return null;
  if (
    providerSalonId !== salonId
    || environment !== expectedEnvironment
    || row?.api_version !== SQUARE_OPTIONAL_API_VERSION
    || !merchantId || !locationId || !accessToken || !applicationId
    || currency !== "CAD"
  ) return null;
  return {
    salonId,
    merchantId,
    locationId,
    accessToken,
    applicationId,
    environment,
    currency,
    sync: {
      pullCreate: false,
      pullUpdate: false,
      pullCancel: false,
      pushCreate: false,
      pushUpdate: false,
      pushCancel: false,
    },
  };
}

function dependencies(input: Dependencies): Required<Dependencies> {
  return {
    db: input.db ?? looseServiceClient(),
    createGiftCard: input.createGiftCard ?? createSquareDigitalGiftCard,
    createPayment: input.createPayment ?? createSquareGiftCardPayment,
    activateGiftCard: input.activateGiftCard ?? activateSquareGiftCard,
  };
}

async function bindActivation(
  db: LooseDb,
  input: ActivationInput,
  operationId: string,
): Promise<boolean> {
  const bound = await db.rpc("bind_square_gift_card_issuance", {
    p_salon_id: input.salonId,
    p_activation_operation_id: operationId,
    p_square_gift_card_id: input.sourceId,
  });
  const receipt = record(bound.data);
  const mirrorId = text(receipt?.gift_card_mirror_id);
  return !bound.error
    && receipt?.success === true
    && receipt.code === "issuance_receipts_bound"
    && mirrorId !== null
    && UUID_RE.test(mirrorId)
    && receipt.square_gift_card_id === input.sourceId
    && receipt.issuance_amount_cents === input.amountCents
    && receipt.issuance_currency === input.currency;
}

/**
 * Dispatch exactly one already-authorized step in the create -> payment ->
 * activate chain. The application gate is intentionally hard OFF, so current
 * runtime calls return before constructing a DB client or contacting Square.
 * Tests replace the gate and all transports with local mocks.
 */
export async function dispatchSquareGiftCardIssuanceOperation(
  input: SquareGiftCardOperationInput,
  dependencyInput: Dependencies = {},
): Promise<SquareGiftCardOperationResult> {
  if (!SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE.gift_cards) {
    return { status: "disabled", reason: "app_contract_unavailable" };
  }
  const request = requestMaterial(input);
  if (!request) return { status: "failed", reason: "invalid_worker_input" };
  const deps = dependencies(dependencyInput);
  const resolved = await deps.db.rpc("resolve_square_feature_operation_material", {
    p_salon_id: input.salonId,
    p_operation_kind: input.operationKind,
    p_request: request,
  });
  if (resolved.error) return { status: "retry_pending", reason: "material_resolution_unavailable" };
  const resolvedRow = record(resolved.data);
  if (resolvedRow?.code !== "resolved" || typeof resolvedRow.material_fingerprint !== "string") {
    return { status: "not_ready", reason: String(resolvedRow?.code ?? "integration_not_ready") };
  }

  const claimed = await deps.db.rpc("claim_square_feature_operation", {
    p_salon_id: input.salonId,
    p_request_id: input.requestId,
    p_operation_kind: input.operationKind,
    p_request: request,
    p_expected_material_fingerprint: resolvedRow.material_fingerprint,
  });
  if (claimed.error) return { status: "retry_pending", reason: "operation_claim_unavailable" };
  const claim = record(claimed.data);
  const operationId = text(claim?.operation_id);
  if (claim?.success !== true) {
    return { status: "failed", reason: String(claim?.code ?? "operation_claim_rejected") };
  }
  if (!operationId || !UUID_RE.test(operationId)) {
    return { status: "failed", reason: "invalid_operation_claim" };
  }
  if (claim.code === "operation_succeeded") {
    const providerObjectId = text(claim.provider_object_id);
    const providerReceiptId = text(claim.provider_receipt_id);
    if (!providerObjectId || !providerReceiptId) {
      return { status: "failed", reason: "invalid_completed_operation", operationId };
    }
    if (
      input.operationKind === "gift_card_activate"
      && !await bindActivation(deps.db, input, operationId)
    ) {
      return { status: "retry_pending", reason: "issuance_binding_unavailable", operationId };
    }
    return {
      status: "succeeded",
      operationId,
      providerObjectId,
      providerReceiptId,
      replay: true,
    };
  }
  if (claim.code !== "operation_claimed") {
    return { status: "retry_pending", reason: String(claim.code ?? "operation_in_flight"), operationId };
  }
  const attemptToken = text(claim.attempt_token);
  const providerIdempotencyKey = text(claim.provider_idempotency_key, 128);
  if (
    !attemptToken
    || !UUID_RE.test(attemptToken)
    || providerIdempotencyKey !== `nq:${input.requestId}`
  ) {
    return { status: "failed", reason: "invalid_operation_claim", operationId };
  }
  const config = providerConfig(
    claim.provider_material,
    input.salonId,
    input.expectedEnvironment,
  );
  if (!config) return { status: "failed", reason: "invalid_provider_material", operationId };

  let providerObjectId: string;
  let providerReceiptId: string;
  let providerResult: JsonRecord;
  try {
    if (input.operationKind === "gift_card_create") {
      const raw = await deps.createGiftCard(config, {
        idempotencyKey: providerIdempotencyKey,
      }, SQUARE_OPTIONAL_API_VERSION);
      const card = record(raw.gift_card);
      const balance = money(card?.balance_money);
      const cardId = text(card?.id);
      if (
        !cardId || card?.type !== "DIGITAL" || card?.state !== "PENDING"
        || balance?.amount !== 0 || balance?.currency !== "CAD"
      ) throw new Error("invalid_create_receipt");
      providerObjectId = cardId;
      providerReceiptId = `gift-card-create:${cardId}`;
      providerResult = {
        id: cardId,
        type: "DIGITAL",
        state: "PENDING",
        balance_money: balance,
      };
    } else if (input.operationKind === "gift_card_payment") {
      const raw = await deps.createPayment(config, {
        idempotencyKey: providerIdempotencyKey,
        sourceId: input.paymentSourceToken,
        amountCents: input.amountCents,
        currency: input.currency,
        orderId: input.orderId,
      }, SQUARE_OPTIONAL_API_VERSION);
      const payment = record(raw.payment);
      const paid = money(payment?.amount_money);
      const paymentId = text(payment?.id);
      if (
        !paymentId || payment?.status !== "COMPLETED"
        || paid?.amount !== input.amountCents || paid?.currency !== input.currency
        || payment?.order_id !== input.orderId
        || payment?.location_id !== config.locationId
      ) throw new Error("invalid_payment_receipt");
      providerObjectId = paymentId;
      providerReceiptId = `gift-card-payment:${paymentId}`;
      providerResult = {
        id: paymentId,
        status: "COMPLETED",
        amount_money: paid,
        order_id: input.orderId,
        location_id: config.locationId,
      };
    } else {
      const raw = await deps.activateGiftCard(config, {
        idempotencyKey: providerIdempotencyKey,
        giftCardId: input.sourceId,
        orderId: input.orderId,
        lineItemUid: input.lineItemUid,
      }, SQUARE_OPTIONAL_API_VERSION);
      const activity = record(raw.gift_card_activity);
      const activated = money(activity?.gift_card_balance_money);
      const details = record(activity?.activate_activity_details);
      const activityId = text(activity?.id);
      if (
        !activityId || activity?.gift_card_id !== input.sourceId
        || activity?.type !== "ACTIVATE" || activity?.location_id !== config.locationId
        || activated?.amount !== input.amountCents || activated?.currency !== input.currency
        || details?.order_id !== input.orderId || details?.line_item_uid !== input.lineItemUid
      ) throw new Error("invalid_activation_receipt");
      providerObjectId = activityId;
      providerReceiptId = `gift-card-activate:${activityId}`;
      providerResult = {
        id: activityId,
        gift_card_id: input.sourceId,
        type: "ACTIVATE",
        location_id: config.locationId,
        gift_card_balance_money: activated,
        activate_activity_details: {
          order_id: input.orderId,
          line_item_uid: input.lineItemUid,
        },
      };
    }
  } catch {
    // A transport failure can occur after Square accepted the mutation. Never
    // mark it failed or issue a new request with a different idempotency key.
    return { status: "retry_pending", reason: "provider_outcome_ambiguous", operationId };
  }

  const completed = await deps.db.rpc("complete_square_feature_operation", {
    p_operation_id: operationId,
    p_attempt_token: attemptToken,
    p_status: "succeeded",
    p_provider_object_id: providerObjectId,
    p_provider_receipt_id: providerReceiptId,
    p_result_fingerprint: fingerprint(providerResult),
    p_error_code: null,
  });
  const completion = record(completed.data);
  if (
    completed.error
    || completion?.success !== true
    || completion.code !== "operation_completed"
    || completion.status !== "succeeded"
    || completion.operation_id !== operationId
    || completion.provider_object_id !== providerObjectId
    || completion.provider_receipt_id !== providerReceiptId
  ) {
    return { status: "retry_pending", reason: "operation_completion_unavailable", operationId };
  }
  if (
    input.operationKind === "gift_card_activate"
    && !await bindActivation(deps.db, input, operationId)
  ) {
    return { status: "retry_pending", reason: "issuance_binding_unavailable", operationId };
  }
  return {
    status: "succeeded",
    operationId,
    providerObjectId,
    providerReceiptId,
    replay: false,
  };
}
