import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../optionalCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../optionalCapabilities")>();
  return {
    ...actual,
    SQUARE_OPTIONAL_APP_CONTRACT_AVAILABLE: Object.freeze({
      loyalty: false,
      gift_cards: true,
      inventory: false,
    }),
  };
});

import type { LooseDb } from "../looseDb";
import { dispatchSquareGiftCardIssuanceOperation } from "../giftCardIssuanceWorker";

const salonId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const operationId = "33333333-3333-4333-8333-333333333333";
const parentOperationId = "44444444-4444-4444-8444-444444444444";
const attemptToken = "55555555-5555-4555-8555-555555555555";
const giftCardId = "gftc:gift-card-1";
const orderId = "order-gift-card-1";
const lineItemUid = "line-gift-card-1";

const providerMaterial = {
  salon_id: salonId,
  environment: "sandbox",
  api_version: "2026-07-15",
  merchant_id: "merchant-1",
  location_id: "location-1",
  application_id: "sandbox-app-1",
  access_token: "sandbox-token",
  currency: "CAD",
};

function database(input?: {
  claimCode?: "operation_claimed" | "operation_succeeded";
  providerObjectId?: string;
  providerReceiptId?: string;
  bindSuccess?: boolean;
}) {
  const rpc = vi.fn(async (
    name: string,
    _args?: Record<string, unknown>,
  ) => {
    void _args;
    if (name === "resolve_square_feature_operation_material") {
      return {
        data: {
          success: true,
          code: "resolved",
          material_fingerprint: "a".repeat(64),
        },
        error: null,
      };
    }
    if (name === "claim_square_feature_operation") {
      const code = input?.claimCode ?? "operation_claimed";
      return {
        data: code === "operation_succeeded"
          ? {
              success: true,
              code,
              operation_id: operationId,
              provider_object_id: input?.providerObjectId ?? "provider-object-1",
              provider_receipt_id: input?.providerReceiptId ?? "provider-receipt-1",
            }
          : {
              success: true,
              code,
              operation_id: operationId,
              attempt_token: attemptToken,
              provider_idempotency_key: `nq:${requestId}`,
              provider_material: providerMaterial,
            },
        error: null,
      };
    }
    if (name === "complete_square_feature_operation") {
      return { data: { success: true, code: "operation_completed" }, error: null };
    }
    if (name === "bind_square_gift_card_issuance") {
      return {
        data: input?.bindSuccess === false
          ? { success: false, code: "receipt_chain_mismatch" }
          : { success: true, code: "issuance_bound" },
        error: null,
      };
    }
    throw new Error(`unexpected RPC ${name}`);
  });
  return { db: { rpc } as unknown as LooseDb, rpc };
}

describe("Square Gift Card issuance worker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates only a Square-assigned DIGITAL card and persists a GAN-free receipt", async () => {
    const { db, rpc } = database();
    const createGiftCard = vi.fn(async () => ({
      gift_card: {
        id: giftCardId,
        type: "DIGITAL",
        state: "PENDING",
        gan: "must-never-be-persisted",
        balance_money: { amount: 0, currency: "CAD" },
      },
    }));
    await expect(dispatchSquareGiftCardIssuanceOperation({
      operationKind: "gift_card_create",
      salonId,
      requestId,
      expectedEnvironment: "sandbox",
      sourceId: "issuance-intent-1",
    }, { db, createGiftCard })).resolves.toMatchObject({
      status: "succeeded",
      providerObjectId: giftCardId,
      replay: false,
    });
    expect(createGiftCard).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "sandbox", locationId: "location-1" }),
      { idempotencyKey: `nq:${requestId}` },
      "2026-07-15",
    );
    expect(rpc).toHaveBeenCalledWith(
      "resolve_square_feature_operation_material",
      expect.objectContaining({ p_request: { source_id: "issuance-intent-1", currency: "CAD" } }),
    );
    const completion = rpc.mock.calls.find(([name]) => name === "complete_square_feature_operation")?.[1];
    expect(JSON.stringify(completion)).not.toContain("must-never-be-persisted");
  });

  it("accepts only a completed exact-order payment receipt", async () => {
    const { db, rpc } = database();
    const createPayment = vi.fn(async () => ({
      payment: {
        id: "payment-1",
        status: "COMPLETED",
        amount_money: { amount: 5_000, currency: "CAD" },
        order_id: orderId,
        location_id: "location-1",
      },
    }));
    await expect(dispatchSquareGiftCardIssuanceOperation({
      operationKind: "gift_card_payment",
      salonId,
      requestId,
      expectedEnvironment: "sandbox",
      sourceId: giftCardId,
      parentOperationId,
      paymentSourceToken: "cnon:buyer-token",
      amountCents: 5_000,
      currency: "CAD",
      orderId,
    }, { db, createPayment })).resolves.toMatchObject({
      status: "succeeded",
      providerObjectId: "payment-1",
    });
    expect(createPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceId: "cnon:buyer-token",
        amountCents: 5_000,
        currency: "CAD",
        orderId,
      }),
      "2026-07-15",
    );
    const completion = rpc.mock.calls.find(([name]) => name === "complete_square_feature_operation")?.[1];
    expect(JSON.stringify(completion)).not.toContain("cnon:buyer-token");
  });

  it("activates against the exact order line and binds the full receipt chain", async () => {
    const { db, rpc } = database();
    const activateGiftCard = vi.fn(async () => ({
      gift_card_activity: {
        id: "gcact:activate-1",
        gift_card_id: giftCardId,
        gift_card_gan: "must-never-be-persisted",
        type: "ACTIVATE",
        location_id: "location-1",
        gift_card_balance_money: { amount: 5_000, currency: "CAD" },
        activate_activity_details: { order_id: orderId, line_item_uid: lineItemUid },
      },
    }));
    await expect(dispatchSquareGiftCardIssuanceOperation({
      operationKind: "gift_card_activate",
      salonId,
      requestId,
      expectedEnvironment: "sandbox",
      sourceId: giftCardId,
      parentOperationId,
      amountCents: 5_000,
      currency: "CAD",
      orderId,
      lineItemUid,
    }, { db, activateGiftCard })).resolves.toMatchObject({
      status: "succeeded",
      providerObjectId: "gcact:activate-1",
    });
    expect(activateGiftCard).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ giftCardId, orderId, lineItemUid }),
      "2026-07-15",
    );
    expect(rpc).toHaveBeenCalledWith("bind_square_gift_card_issuance", {
      p_salon_id: salonId,
      p_activation_operation_id: operationId,
      p_square_gift_card_id: giftCardId,
    });
    const completion = rpc.mock.calls.find(([name]) => name === "complete_square_feature_operation")?.[1];
    expect(JSON.stringify(completion)).not.toContain("must-never-be-persisted");
  });

  it("does not complete an ambiguous provider outcome", async () => {
    const { db, rpc } = database();
    const createGiftCard = vi.fn(async () => {
      throw new Error("response lost after provider acceptance");
    });
    await expect(dispatchSquareGiftCardIssuanceOperation({
      operationKind: "gift_card_create",
      salonId,
      requestId,
      expectedEnvironment: "sandbox",
      sourceId: "issuance-intent-1",
    }, { db, createGiftCard })).resolves.toEqual({
      status: "retry_pending",
      reason: "provider_outcome_ambiguous",
      operationId,
    });
    expect(rpc).not.toHaveBeenCalledWith(
      "complete_square_feature_operation",
      expect.anything(),
    );
  });

  it("refuses provider material from a different expected environment", async () => {
    const { db } = database();
    const createGiftCard = vi.fn();
    await expect(dispatchSquareGiftCardIssuanceOperation({
      operationKind: "gift_card_create",
      salonId,
      requestId,
      expectedEnvironment: "production",
      sourceId: "issuance-intent-1",
    }, { db, createGiftCard })).resolves.toMatchObject({
      status: "failed",
      reason: "invalid_provider_material",
    });
    expect(createGiftCard).not.toHaveBeenCalled();
  });

  it("rejects a mismatched provider receipt without inventing success", async () => {
    const { db, rpc } = database();
    const createPayment = vi.fn(async () => ({
      payment: {
        id: "payment-1",
        status: "COMPLETED",
        amount_money: { amount: 4_999, currency: "CAD" },
        order_id: orderId,
        location_id: "location-1",
      },
    }));
    await expect(dispatchSquareGiftCardIssuanceOperation({
      operationKind: "gift_card_payment",
      salonId,
      requestId,
      expectedEnvironment: "sandbox",
      sourceId: giftCardId,
      parentOperationId,
      paymentSourceToken: "cnon:buyer-token",
      amountCents: 5_000,
      currency: "CAD",
      orderId,
    }, { db, createPayment })).resolves.toMatchObject({
      status: "retry_pending",
      reason: "provider_outcome_ambiguous",
    });
    expect(rpc).not.toHaveBeenCalledWith(
      "complete_square_feature_operation",
      expect.anything(),
    );
  });

  it("replays an activated operation by rebinding without another provider call", async () => {
    const { db, rpc } = database({
      claimCode: "operation_succeeded",
      providerObjectId: "gcact:activate-1",
      providerReceiptId: "gift-card-activate:gcact:activate-1",
    });
    const activateGiftCard = vi.fn();
    await expect(dispatchSquareGiftCardIssuanceOperation({
      operationKind: "gift_card_activate",
      salonId,
      requestId,
      expectedEnvironment: "sandbox",
      sourceId: giftCardId,
      parentOperationId,
      amountCents: 5_000,
      currency: "CAD",
      orderId,
      lineItemUid,
    }, { db, activateGiftCard })).resolves.toMatchObject({
      status: "succeeded",
      replay: true,
    });
    expect(activateGiftCard).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("bind_square_gift_card_issuance", expect.anything());
  });
});
