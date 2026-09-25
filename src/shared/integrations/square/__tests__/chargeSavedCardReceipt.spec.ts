import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { chargeSavedCard, type SquareConfig } from "../client";

const config: SquareConfig = {
  salonId: "11111111-1111-4111-8111-111111111111",
  merchantId: "merchant-qa",
  locationId: "location-qa",
  accessToken: "sandbox-token",
  applicationId: "sandbox-app",
  environment: "sandbox",
  currency: "CAD",
  sync: {
    pullCreate: false, pullUpdate: false, pullCancel: false,
    pushCreate: false, pushUpdate: false, pushCancel: false,
  },
};

const request = {
  cardId: "ccof:synthetic-card",
  customerId: "customer-qa",
  amountCents: 1250,
  idempotencyKey: "qa-cancellation-fee-operation",
  referenceId: "qa-operation-reference",
};

const receipt = {
  id: "payment-qa",
  status: "COMPLETED",
  amount_money: { amount: 1250, currency: "CAD" },
  location_id: "location-qa",
  customer_id: "customer-qa",
  reference_id: "qa-operation-reference",
};

function respondWith(payment: unknown) {
  const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    void _input;
    void _init;
    return { ok: true, status: 200, json: async () => ({ payment }) };
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("Square saved-card fee receipt binding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts the exact fee receipt and sends merchant-initiated, idempotent sandbox material", async () => {
    const fetcher = respondWith(receipt);

    await expect(chargeSavedCard(config, request)).resolves.toEqual({
      paymentId: "payment-qa", status: "COMPLETED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://connect.squareupsandbox.com/v2/payments");
    expect(JSON.parse(String(init?.body))).toEqual({
      idempotency_key: request.idempotencyKey,
      source_id: request.cardId,
      customer_id: request.customerId,
      amount_money: receipt.amount_money,
      location_id: config.locationId,
      autocomplete: true,
      reference_id: request.referenceId,
      customer_details: { customer_initiated: false, seller_keyed_in: false },
    });
  });

  it.each(["APPROVED", "PENDING", "FAILED", "CANCELED"])(
    "preserves valid %s status for the ledger instead of claiming success", async (status) => {
      respondWith({ ...receipt, status });
      await expect(chargeSavedCard(config, request)).resolves.toEqual({
        paymentId: "payment-qa", status,
      });
    },
  );

  it.each([
    ["missing receipt", undefined],
    ["null receipt", null],
    ["array receipt", []],
    ["text receipt", "COMPLETED"],
    ["missing ID", { ...receipt, id: undefined }],
    ["numeric ID", { ...receipt, id: 123 }],
    ["object ID", { ...receipt, id: {} }],
    ["empty ID", { ...receipt, id: "" }],
    ["whitespace ID", { ...receipt, id: " " }],
    ["padded ID", { ...receipt, id: " payment-qa " }],
    ["control-character ID", { ...receipt, id: "payment\nqa" }],
    ["oversized ID", { ...receipt, id: "x".repeat(193) }],
    ["missing status", { ...receipt, status: undefined }],
    ["object status", { ...receipt, status: {} }],
    ["invented status", { ...receipt, status: "SUCCESS" }],
    ["padded status", { ...receipt, status: " COMPLETED " }],
    ["missing amount", { ...receipt, amount_money: undefined }],
    ["null amount", { ...receipt, amount_money: null }],
    ["array amount", { ...receipt, amount_money: [] }],
    ["wrong amount", { ...receipt, amount_money: { amount: 1251, currency: "CAD" } }],
    ["string amount", { ...receipt, amount_money: { amount: "1250", currency: "CAD" } }],
    ["fractional amount", { ...receipt, amount_money: { amount: 1250.5, currency: "CAD" } }],
    ["unsafe amount", { ...receipt, amount_money: { amount: Number.MAX_SAFE_INTEGER + 1, currency: "CAD" } }],
    ["wrong currency", { ...receipt, amount_money: { amount: 1250, currency: "USD" } }],
    ["missing currency", { ...receipt, amount_money: { amount: 1250 } }],
    ["wrong location", { ...receipt, location_id: "another-salon-location" }],
    ["missing location", { ...receipt, location_id: undefined }],
    ["wrong customer", { ...receipt, customer_id: "another-customer" }],
    ["missing customer", { ...receipt, customer_id: undefined }],
    ["wrong reference", { ...receipt, reference_id: "another-operation" }],
    ["missing reference", { ...receipt, reference_id: undefined }],
  ])("rejects %s without replaying the provider mutation", async (_label, payment) => {
    const fetcher = respondWith(payment);
    await expect(chargeSavedCard(config, request)).rejects.toThrow("square_payment_receipt_invalid");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never leaks customer/card payload in a receipt validation error", async () => {
    respondWith({
      ...receipt,
      location_id: "another-location",
      buyer_email_address: "synthetic-private@example.invalid",
      card_details: { card: { last_4: "1234" } },
      note: "private customer note",
    });
    await expect(chargeSavedCard(config, request)).rejects.toMatchObject({
      message: "square_payment_receipt_invalid",
    });
  });

  it("keeps a lost response ambiguous and makes only one provider call", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("synthetic transport error"));
    vi.stubGlobal("fetch", fetcher);
    await expect(chargeSavedCard(config, request)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
