import { afterEach, describe, expect, it, vi } from "vitest";

import { refundPayment, type SquareConfig } from "../client";

const config: SquareConfig = {
  salonId: "11111111-1111-4111-8111-111111111111",
  merchantId: "merchant-qa",
  locationId: "location-qa",
  accessToken: "sandbox-token",
  applicationId: "sandbox-app",
  environment: "sandbox",
  currency: "CAD",
  sync: {
    pullCreate: false,
    pullUpdate: false,
    pullCancel: false,
    pushCreate: false,
    pushUpdate: false,
    pushCancel: false,
  },
};

const exactRefundFields = {
  payment_id: "payment-qa",
  amount_money: { amount: 400, currency: "CAD" },
};

describe("Square refund HTTP contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["partial", 400],
    ["full", 1_000],
  ])("sends the exact %s sandbox CAD refund payload", async (_label, amountCents) => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      void _input;
      void _init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          refund: {
            id: `refund-${amountCents}`,
            status: "COMPLETED",
            payment_id: "payment-qa",
            amount_money: { amount: amountCents, currency: "CAD" },
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetcher);

    const result = await refundPayment(config, {
      paymentId: "payment-qa",
      amountCents,
      reason: "QA fake refund",
      idempotencyKey: `nq:refund-${amountCents}`,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://connect.squareupsandbox.com/v2/refunds");
    expect(init).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer sandbox-token",
        "Content-Type": "application/json",
      }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotency_key: `nq:refund-${amountCents}`,
      payment_id: "payment-qa",
      amount_money: { amount: amountCents, currency: "CAD" },
      reason: "QA fake refund",
    });
    expect(result).toEqual({
      id: `refund-${amountCents}`,
      status: "COMPLETED",
    });
  });

  it.each([
    [{ refund: { ...exactRefundFields, status: "COMPLETED" } }],
    [{ refund: { ...exactRefundFields, id: "refund-without-status" } }],
    [{ refund: { ...exactRefundFields, id: {}, status: "COMPLETED" } }],
    [{ refund: { ...exactRefundFields, id: 123, status: "COMPLETED" } }],
    [{ refund: { ...exactRefundFields, id: "refund", status: {} } }],
    [{ refund: { ...exactRefundFields, id: " ", status: "COMPLETED" } }],
    [{}],
  ])("rejects a successful HTTP response without an exact refund receipt", async (body) => {
    const fetcher = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      void _input;
      void _init;
      return {
        ok: true,
        status: 200,
        json: async () => body,
      };
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(refundPayment(config, {
      paymentId: "payment-qa",
      amountCents: 400,
      reason: "QA fake refund",
      idempotencyKey: "nq:refund-malformed",
    })).rejects.toThrow("Square RefundPayment returned no exact receipt");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wrong payment", { payment_id: "payment-other", amount_money: { amount: 400, currency: "CAD" } }],
    ["wrong cents", { payment_id: "payment-qa", amount_money: { amount: 401, currency: "CAD" } }],
    ["wrong currency", { payment_id: "payment-qa", amount_money: { amount: 400, currency: "USD" } }],
  ])("rejects a %s provider receipt", async (_label, receiptFields) => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        refund: {
          id: "refund-mismatched",
          status: "COMPLETED",
          ...receiptFields,
        },
      }),
    }));
    vi.stubGlobal("fetch", fetcher);

    await expect(refundPayment(config, {
      paymentId: "payment-qa",
      amountCents: 400,
      reason: "QA fake refund",
      idempotencyKey: "nq:refund-mismatched",
    })).rejects.toThrow("Square RefundPayment returned no exact receipt");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
